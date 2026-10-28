"""Least-privilege workflow tools for the log issue triage cron."""

from __future__ import annotations

import datetime as dt
import hashlib
import io
import json
import math
import os
import re
import sqlite3
import subprocess
import tarfile
import tempfile
import threading
import uuid
from pathlib import Path

# The main repo can move; TRIAGE_MAIN_REPO retargets every in-repo component.
_MAIN_REPO = os.environ.get("TRIAGE_MAIN_REPO") or "darrencjh8/friday"
_COMPONENT_REPOS = {
    "hermes": _MAIN_REPO,
    "expense-tracker": _MAIN_REPO,
    "portfolio-tracker": _MAIN_REPO,
    "codex-router": "darrencjh8/codex-router",
    "actual-api": _MAIN_REPO,
}
_COMPONENTS = tuple(_COMPONENT_REPOS)
_SNAPSHOT_ROOT = Path("/opt/data/log-issue-triage/snapshots")
_STATE_ROOT = Path("/opt/data/log-issue-triage/state")
_COLLECTION_DIR = "collections"
_PROOF_DIR = "proofs"
_CRON_ROOT = Path("/opt/data/cron")
_CRON_FINDINGS: dict[str, dict] = {}
_CRON_STALE_TICKER_SECONDS = 300
_CRON_RUNNING_STALE_SECONDS = 7200
# Runtime terminal job statuses that mean "ran fine": `ok` (delivered or local)
# and `delivery_queued` (agent success handed to the seed's managed delivery).
_CRON_SUCCESS_STATUSES = ("ok", "delivery_queued")
_COLLECTOR = "/opt/data/scripts/log-issue-triage-snapshot.sh"
_SHA_RE = re.compile(r"^[0-9a-f]{40}$")
_IMAGE_RE = re.compile(r"^sha256:[0-9a-f]{64}$")
_TEST_COMMAND_RE = re.compile(
    r"^python(?:3)? -m unittest -v [A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+(?::[A-Za-z_][A-Za-z0-9_.]*)?$"
)
_FAILURE_SUMMARY_RE = re.compile(r"(?m)^FAILED \((?:failures|errors)=[1-9][0-9]*(?:, (?:failures|errors)=[1-9][0-9]*)?\)$")
_TEST_FAILURE_RE = re.compile(r"(?m)^(?:FAIL|ERROR): [A-Za-z_][A-Za-z0-9_]* \([A-Za-z_][A-Za-z0-9_.]*\)$")
_TEST_RUN_RE = re.compile(r"(?m)^Ran [1-9][0-9]* tests? in [0-9.]+s$")
_SECRET_RE = re.compile(
    r"(?i)(?:authorization\s*:\s*(?:basic|bearer)\s+\S+|"
    r"(?:cloud[_-]?secret[_-]?access[_-]?key|password|passwd|pin|otp|secret(?:[_-]?access[_-]?key)?|client[_-]?secret|private[_-]?key|token|api[_-]?key|authorization|cookie|session)\s*[:=]\s*[^\s,;}]+|"
    r"[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|"
    r"(?i:\b(?:account|acct|account[_ -]?id|acct[_ -]?id|customer|customer[_ -]?id|member|member[_ -]?id|reference|ref)\s*(?:number|no\.?|id)?\s*(?:is\s*)?(?:[:=#-]\s*)?[A-Z0-9][A-Z0-9_-]{0,31}\b)|"
    r"(?<!\d)(?!\d{4}[\s./-]\d{1,2}[\s./-]\d{1,2}(?:T|\b))(?:\+\d{1,3}[\s./-]?)?(?:\(\d{2,4}\)[\s./-]?)?(?:\d{3,4}(?:[\s./-]\d{2,4}){1,3}|\d{7,12})(?!\d)|(?<!\d)\d{10,15}(?!\d)|\b(?:\d[ -]?){13,19}\b|"
    r"gh[pousr]_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|"
    r"\b\d{6,12}:[A-Za-z0-9_-]{30,}|https://hooks\.slack\.com/services/[A-Za-z0-9/_-]+|"
    r"\bntn_[A-Za-z0-9]+|"
    r"AIza[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9_-]{20,}|"
    r"eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}|"
    r"-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----.*?"
    r"-----END (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----)",
    re.DOTALL,
)
_SNAPSHOTS: dict[str, dict] = {}
_PROOFS: dict[str, dict] = {}
_SANDBOX_LOCK = threading.Lock()
_PUBLISH_LOCK = threading.Lock()
_MAX_PROOFS = 64
_MAX_SNAPSHOTS = 64
_MAX_STATE_RECORDS = 64


def _test_public_summary(output):
    """Keep issue evidence to structural unittest lines, never assertion text."""
    lines = []
    for pattern in (_TEST_FAILURE_RE, _TEST_RUN_RE, _FAILURE_SUMMARY_RE):
        match = pattern.search(output)
        if match:
            lines.append(match.group(0))
    return "\n".join(lines)


def _run(args, *, timeout=120, input_text=None, input_bytes=None, cwd=None):
    """Run one fixed executable without a shell; never return credential-bearing errors."""
    if input_text is not None and input_bytes is not None:
        raise ValueError("only one input type may be provided")
    try:
        result = subprocess.run(
            args,
            cwd=cwd,
            input=input_bytes if input_bytes is not None else input_text,
            text=input_bytes is None,
            capture_output=True,
            timeout=timeout,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        return {"ok": False, "error": f"{args[0]} failed or timed out: {type(exc).__name__}"}
    stdout = result.stdout.decode("utf-8", errors="replace") if isinstance(result.stdout, bytes) else result.stdout
    stderr = result.stderr.decode("utf-8", errors="replace") if isinstance(result.stderr, bytes) else result.stderr
    return {
        "ok": result.returncode == 0,
        "returncode": result.returncode,
        "stdout": _SECRET_RE.sub("[REDACTED]", stdout[-12000:]),
        "stderr": _SECRET_RE.sub("[REDACTED]", stderr[-2000:]),
    }


def _component(args):
    component = str(args.get("component", ""))
    if component not in _COMPONENTS:
        raise ValueError("unsupported component")
    return component


def _now():
    return dt.datetime.now(dt.timezone.utc)


def _parse_time(value):
    if not value:
        return None
    try:
        parsed = dt.datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed.replace(tzinfo=dt.timezone.utc) if parsed.tzinfo is None else parsed.astimezone(dt.timezone.utc)


def _cron_finding(job_id, job_name, kind, detail, observed_at, **extra):
    safe_detail = _SECRET_RE.sub("[REDACTED]", str(detail))[-1000:]
    identity_detail = "ticker heartbeat is stale" if kind == "ticker_stale" else safe_detail
    key = "|".join((job_id, kind, identity_detail))
    finding_id = hashlib.sha256(key.encode("utf-8")).hexdigest()[:32]
    finding = {
        "finding_id": finding_id,
        "job_id": job_id,
        "job_name": job_name,
        "kind": kind,
        "detail": safe_detail,
        "observed_at": observed_at.isoformat(),
        **extra,
    }
    _CRON_FINDINGS[finding_id] = finding
    return finding


def _cron_health(args):
    del args
    now = _now()
    jobs_path = _CRON_ROOT / "jobs.json"
    try:
        payload = json.loads(jobs_path.read_text(encoding="utf-8"))
        jobs = payload["jobs"]
        if not isinstance(jobs, list):
            raise ValueError("jobs is not a list")
    except (OSError, ValueError, KeyError, TypeError):
        return {"status": "health_check_failed", "detail": "cron jobs file is missing or invalid"}

    findings = []
    heartbeat_path = _CRON_ROOT / "ticker_heartbeat"
    try:
        # Hermes writes "<epoch> <pid>"; older stamps are a bare epoch.
        heartbeat_value = float(heartbeat_path.read_text(encoding="utf-8").split()[0])
        if not math.isfinite(heartbeat_value):
            raise ValueError("heartbeat is not finite")
        heartbeat_age = max(0.0, now.timestamp() - heartbeat_value)
    except (OSError, TypeError, ValueError, IndexError):
        heartbeat_age = None
    if heartbeat_age is None:
        findings.append(_cron_finding("scheduler", "cron-scheduler", "ticker_unavailable", "ticker heartbeat is missing or invalid", now))
    elif heartbeat_age > _CRON_STALE_TICKER_SECONDS:
        findings.append(_cron_finding("scheduler", "cron-scheduler", "ticker_stale", f"ticker heartbeat is {int(heartbeat_age)} seconds old", now))

    latest = {}
    try:
        db_path = _CRON_ROOT / "executions.db"
        with sqlite3.connect(f"file:{db_path}?mode=ro", uri=True, timeout=5) as db:
            rows = db.execute(
                "SELECT job_id,status,claimed_at,finished_at,error,delivery_outcome,scheduled_instant "
                "FROM executions ORDER BY rowid DESC"
            )
            for row in rows:
                latest.setdefault(row[0], row)
    except (OSError, sqlite3.Error):
        return {"status": "health_check_failed", "detail": "cron execution history is missing or unreadable"}

    for job in jobs:
        if not isinstance(job, dict) or not job.get("enabled", True):
            continue
        job_id = str(job.get("id", ""))
        job_name = str(job.get("name", job_id))
        row = latest.get(job_id)
        if row is None:
            next_run = _parse_time(job.get("next_run_at"))
            if next_run and next_run < now - dt.timedelta(seconds=_CRON_STALE_TICKER_SECONDS):
                findings.append(_cron_finding(job_id, job_name, "invocation_missing", "scheduled invocation has no execution record", now, schedule=job.get("schedule")))
            elif job.get("last_status") not in (None, *_CRON_SUCCESS_STATUSES):
                findings.append(_cron_finding(job_id, job_name, "execution_failed", "job metadata reports a non-success status without a matching execution record", now, schedule=job.get("schedule")))
            continue
        status, claimed_at, finished_at, error, delivery, scheduled = row[1:]
        claimed = _parse_time(claimed_at)
        if status in ("claimed", "running") and not error:
            running_age = (now - claimed).total_seconds() if claimed else None
            if running_age is None or running_age > _CRON_RUNNING_STALE_SECONDS:
                findings.append(_cron_finding(job_id, job_name, "execution_stale", "execution remains active beyond the stale threshold", now, schedule=job.get("schedule"), execution_status=status))
        elif status != "completed" or error:
            findings.append(_cron_finding(job_id, job_name, "execution_failed", error or f"execution ended with status {status}", now, schedule=job.get("schedule"), execution_status=status))
        elif delivery in ("failed", "unverified"):
            findings.append(_cron_finding(job_id, job_name, "delivery_failed", f"delivery outcome was {delivery}", now, schedule=job.get("schedule"), execution_status=status))
        scheduled_at = _parse_time(scheduled)
        claimed = _parse_time(claimed_at)
        next_run = _parse_time(job.get("next_run_at"))
        if next_run and next_run < now - dt.timedelta(seconds=_CRON_STALE_TICKER_SECONDS):
            findings.append(_cron_finding(job_id, job_name, "invocation_overdue", "next scheduled invocation is overdue", now, schedule=job.get("schedule")))
        if job.get("last_status") not in (None, *_CRON_SUCCESS_STATUSES) and not error:
            findings.append(_cron_finding(job_id, job_name, "metadata_failed", f"job metadata reports status {job['last_status']}", now, schedule=job.get("schedule")))
        if scheduled_at and claimed and claimed - scheduled_at > dt.timedelta(seconds=_CRON_STALE_TICKER_SECONDS):
            findings.append(_cron_finding(job_id, job_name, "invocation_late", "execution started more than five minutes after its scheduled instant", now, schedule=job.get("schedule"), execution_status=status))

    return {
        "status": "degraded" if findings else "healthy",
        "checked_at": now.isoformat(),
        "job_count": sum(1 for job in jobs if isinstance(job, dict) and job.get("enabled", True)),
        "finding_count": len(findings),
        "findings": findings,
        **({"finding_id": findings[0]["finding_id"]} if len(findings) == 1 else {}),
    }


def _source_archive(checkout: Path, fixture: str | None) -> bytes | None:
    """Build a bounded, path-safe Git worktree archive plus an optional fixture."""
    def entries():
        for root, dirs, files in os.walk(checkout):
            dirs[:] = sorted(name for name in dirs if name != ".git")
            for name in sorted(dirs + files):
                yield Path(root) / name

    buf = io.BytesIO()
    total_bytes = 0
    count = 0
    for path in entries():
        count += 1
        if count > 20000:
            return None
        if path.is_file() and not path.is_symlink():
            total_bytes += path.stat().st_size
            if total_bytes > 20 * 1024 * 1024:
                return None
    with tarfile.open(fileobj=buf, mode="w", format=tarfile.PAX_FORMAT) as archive:
        for path in entries():
            archive.add(path, arcname=path.relative_to(checkout).as_posix(), recursive=False)
        if fixture is not None:
            fixture_bytes = fixture.encode("utf-8")
            info = tarfile.TarInfo("fixture.txt")
            info.size = len(fixture_bytes)
            info.mode = 0o444
            archive.addfile(info, io.BytesIO(fixture_bytes))
    payload = buf.getvalue()
    return payload if len(payload) <= 32 * 1024 * 1024 else None


def _state_path(kind, record_id):
    if not re.fullmatch(r"[0-9a-f]{32}", record_id):
        return None
    return _STATE_ROOT / kind / f"{record_id}.json"


def _persist_record(kind, record_id, record):
    path = _state_path(kind, record_id)
    if path is None:
        raise ValueError("invalid state record id")
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=path.parent, prefix=".pending-", delete=False) as handle:
        os.chmod(handle.name, 0o600)
        json.dump(record, handle, ensure_ascii=True, separators=(",", ":"))
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
        pending = handle.name
    os.replace(pending, path)
    records = sorted(
        path.parent.glob("*.json"),
        key=lambda candidate: (candidate.stat().st_mtime_ns, candidate.name),
    )
    for stale in records[:-_MAX_STATE_RECORDS]:
        try:
            stale.unlink()
        except OSError:
            pass


def _load_record(kind, record_id):
    path = _state_path(kind, str(record_id))
    if path is None:
        return None
    try:
        with path.open(encoding="utf-8") as handle:
            record = json.load(handle)
    except (OSError, ValueError):
        return None
    return record if isinstance(record, dict) else None


def _collect(args):
    component = _component(args)
    result = _run(["bash", _COLLECTOR, component], timeout=90)
    if not result["ok"]:
        return {"status": "collection_failed", "detail": result.get("stderr", "")}
    path = _SNAPSHOT_ROOT / f"{component}.json"
    try:
        snapshot = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {"status": "collection_failed", "detail": "snapshot missing or invalid"}
    if snapshot.get("component") != component:
        return {"status": "collection_failed", "detail": "snapshot component mismatch"}
    collection_id = uuid.uuid4().hex
    if snapshot.get("collection_errors") or snapshot.get("truncated"):
        return {"status": "partial", "snapshot": snapshot}
    _SNAPSHOTS[collection_id] = snapshot
    _persist_record(_COLLECTION_DIR, collection_id, snapshot)
    if len(_SNAPSHOTS) > _MAX_SNAPSHOTS:
        _SNAPSHOTS.pop(next(iter(_SNAPSHOTS)))
    return {"status": "ok", "collection_id": collection_id, "snapshot": snapshot}


def _reproduce(args):
    component = _component(args)
    collection_id = str(args.get("collection_id", ""))
    snapshot = _SNAPSHOTS.get(collection_id) or _load_record(_COLLECTION_DIR, collection_id)
    if not snapshot or snapshot.get("component") != component:
        return {"status": "blocked", "detail": "use the matching clean collection_id for this component"}
    revision = str(args.get("revision", ""))
    command = str(args.get("command", ""))
    fixture = str(args.get("fixture", ""))
    if not _TEST_COMMAND_RE.fullmatch(command):
        return {"status": "blocked", "detail": "command must run one named Python unittest target; shell commands are not accepted"}
    if not _SHA_RE.fullmatch(revision):
        return {"status": "blocked", "detail": "revision must be a full 40-character commit SHA"}
    if not command or len(command) > 4000 or "\x00" in command:
        return {"status": "blocked", "detail": "command must be 1-4000 characters"}
    if _SECRET_RE.search(command) or _SECRET_RE.search(fixture):
        return {"status": "blocked", "detail": "command or fixture contains content matched by the sensitive-data filter"}
    if len(fixture) > 32000 or "\x00" in fixture:
        return {"status": "blocked", "detail": "fixture exceeds the 32 KiB limit"}
    images = snapshot.get("container_images") or []
    matching_image = next((
        entry for entry in images
        if entry.get("revision") == revision
        and _IMAGE_RE.fullmatch(str(entry.get("image_id", "")))
    ), None)
    if matching_image is None:
        return {"status": "blocked", "detail": "no captured image ID has the requested source revision"}
    image_id = matching_image["image_id"]

    record_id = uuid.uuid4().hex
    with tempfile.TemporaryDirectory(prefix="triage-source-") as tmp:
        checkout = Path(tmp) / "source"
        fetch = _run(["gh", "repo", "clone", _COMPONENT_REPOS[component], str(checkout), "--", "--depth=1", "--filter=blob:none"], timeout=120)
        if not fetch["ok"]:
            return {"status": "blocked", "detail": "could not clone the approved source repository"}
        fetch = _run(["git", "-C", str(checkout), "fetch", "--quiet", "--depth", "1", "origin", revision], timeout=120)
        if not fetch["ok"]:
            return {"status": "blocked", "detail": "could not fetch the pinned source revision"}
        fetch = _run(["git", "-C", str(checkout), "checkout", "--quiet", "--detach", "FETCH_HEAD"], timeout=30)
        if not fetch["ok"]:
            return {"status": "blocked", "detail": "could not check out the pinned source revision"}
        baseline_archive = _source_archive(checkout, None)
        incident_archive = _source_archive(checkout, fixture)
        if baseline_archive is None or incident_archive is None:
            return {"status": "blocked", "detail": "source archive exceeds file-count or size limits"}
        sandbox_script = (
            "ulimit -f 32768 || exit 125; "
            "tar -xf - -C /triage >/tmp/triage-output 2>&1 || { head -c 65536 /tmp/triage-output; exit 125; }; "
            "/bin/sh -c \"$1\" >>/tmp/triage-output 2>&1; "
            "status=$?; head -c 65536 /tmp/triage-output; exit \"$status\""
        )

        def run_sandbox(archive_bytes, suffix):
            sandbox_name = f"triage-{record_id}-{suffix}"
            docker_args = [
                "docker", "run", "--rm", "--name", sandbox_name, "-i", "--network=none", "--read-only",
                "--cap-drop=ALL", "--security-opt=no-new-privileges",
                "--pids-limit=64", "--memory=512m", "--cpus=1.0", "--user=65534:65534",
                "--tmpfs", "/triage:rw,nosuid,nodev,size=64m,mode=1777",
                "--tmpfs", "/tmp:rw,nosuid,nodev,size=64m,mode=1777",
                "--workdir", "/triage", "--entrypoint", "/bin/sh", image_id,
                "-c", sandbox_script, "triage-sandbox", command,
            ]
            result = _run(docker_args, timeout=180, input_bytes=archive_bytes)
            if result.get("returncode") is None:
                _run(["docker", "rm", "--force", sandbox_name], timeout=15)
            return result, docker_args

        if not _SANDBOX_LOCK.acquire(blocking=False):
            return {"status": "blocked", "detail": "another reproduction is already running"}
        try:
            baseline, _ = run_sandbox(baseline_archive, "baseline")
            incident, _ = run_sandbox(incident_archive, "incident")
        finally:
            _SANDBOX_LOCK.release()

        baseline_output = baseline.get("stdout", "")
        incident_output = incident.get("stdout", "")
        baseline_passed = (
            baseline.get("returncode") == 0
            and not baseline.get("stderr")
            and re.search(r"(?m)^Ran [1-9][0-9]* tests? in [0-9.]+s$", baseline_output)
            and re.search(r"(?m)^OK$", baseline_output)
        )
        incident_failed = (
            incident.get("returncode") == 1
            and not incident.get("stderr")
            and _FAILURE_SUMMARY_RE.search(incident_output)
            and re.search(r"(?m)^(?:FAIL|ERROR): [A-Za-z_][A-Za-z0-9_]* \([A-Za-z_][A-Za-z0-9_.]*\)$", incident_output)
            and re.search(r"(?m)^Ran [1-9][0-9]* tests? in [0-9.]+s$", incident_output)
        )
        proof = {
            "reproduction_id": record_id,
            "component": component,
            "collection_id": collection_id,
            "repository": _COMPONENT_REPOS[component],
            "revision": revision,
            "image_id": image_id,
            "command": command,
            "baseline_returncode": baseline.get("returncode"),
            "baseline_stdout": baseline_output,
            "baseline_stderr": baseline.get("stderr", ""),
            "returncode": incident.get("returncode"),
            "stdout": incident_output,
            "public_stdout": _test_public_summary(incident_output),
            "stderr": incident.get("stderr", ""),
            "fixture_sensitive": bool(baseline_passed and incident_failed),
            "completed": bool(baseline_passed and incident_failed),
        }
        try:
            _persist_record(_PROOF_DIR, record_id, proof)
        except (OSError, ValueError):
            return {"status": "evidence_persistence_failed", "detail": "reproduction evidence could not be durably stored"}
        _PROOFS[record_id] = proof
        if len(_PROOFS) > _MAX_PROOFS:
            _PROOFS.pop(next(iter(_PROOFS)))
        return {"status": "executed" if proof["completed"] else "execution_failed", **proof}


def _search_issues(args):
    component = _component(args)
    query = str(args.get("query", "")).strip()
    if not query or len(query) > 200:
        return {"status": "invalid_query"}
    repo = _COMPONENT_REPOS[component]
    result = _run([
        "gh", "issue", "list", "--repo", repo, "--state", "all", "--limit", "100",
        "--search", query, "--json", "number,title,state,url",
    ], timeout=45)
    if not result["ok"]:
        return {"status": "search_failed", "detail": result["stderr"]}
    try:
        issues = json.loads(result["stdout"])
    except ValueError:
        return {"status": "search_failed", "detail": "invalid GitHub response"}
    return {"status": "ok", "repository": repo, "issues": issues}


def _publish(args):
    if not _PUBLISH_LOCK.acquire(blocking=False):
        return {"status": "publication_in_progress", "detail": "another issue publication is being reconciled"}
    try:
        return _publish_once(args)
    finally:
        _PUBLISH_LOCK.release()


def _publish_once(args):
    component = _component(args)
    reproduction_id = str(args.get("reproduction_id", ""))
    proof = _PROOFS.get(reproduction_id)
    if not proof or proof.get("component") != component or not proof.get("completed") or not proof.get("fixture_sensitive"):
        return {"status": "blocked", "detail": "a successful isolated reproduction is required"}
    title = str(args.get("title", "")).strip()
    body = str(args.get("body", "")).strip()
    if not title or len(title) > 180 or not body or len(body) > 12000:
        return {"status": "invalid_issue", "detail": "title/body is empty or exceeds size limits"}
    if _SECRET_RE.search(title) or _SECRET_RE.search(body):
        return {"status": "blocked", "detail": "issue title/body contains content matched by the sensitive-data filter"}
    repo = _COMPONENT_REPOS[component]
    marker_search = _run([
        "gh", "issue", "list", "--repo", repo, "--state", "all", "--limit", "1000",
        "--search", f"{proof['reproduction_id']} in:body", "--json", "number,title,url",
    ], timeout=45)
    if not marker_search["ok"]:
        return {"status": "dedupe_check_failed", "detail": marker_search["stderr"]}
    try:
        prior_publication = json.loads(marker_search["stdout"])
    except ValueError:
        return {"status": "dedupe_check_failed", "detail": "invalid GitHub reproduction-marker response"}
    if prior_publication:
        return {"status": "duplicate", "issues": prior_publication, "detail": "matching reproduction ID already published"}
    existing = _run([
        "gh", "issue", "list", "--repo", repo, "--state", "all", "--limit", "1000",
        "--search", title, "--json", "number,title,url",
    ], timeout=45)
    if not existing["ok"]:
        return {"status": "dedupe_check_failed", "detail": existing["stderr"]}
    try:
        matches = json.loads(existing["stdout"])
    except ValueError:
        return {"status": "dedupe_check_failed", "detail": "invalid GitHub response"}
    if any(str(item.get("title", "")).casefold() == title.casefold() for item in matches):
        return {"status": "duplicate", "issues": matches}
    if f"`{proof['reproduction_id']}`" not in body:
        body += f"\n\nReproduction evidence ID: `{proof['reproduction_id']}` (revision `{proof['revision']}`, image `{proof['image_id']}`)."
    evidence = (
        f"\n\nReproducer command: `{proof['command']}`\n\n"
        "```text\n" + proof.get("public_stdout", "") + "\n```"
    )
    body += evidence
    if len(body) > 12000 or _SECRET_RE.search(body):
        return {"status": "blocked", "detail": "verified reproduction evidence exceeds limits or sensitive-data checks"}
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", prefix="triage-issue-", delete=True) as body_file:
        body_file.write(body)
        body_file.flush()
        result = _run(["gh", "issue", "create", "--repo", repo, "--title", title, "--body-file", body_file.name], timeout=60)
    if not result["ok"]:
        return {"status": "publish_failed", "detail": result["stderr"]}
    url = result["stdout"].strip().splitlines()[-1] if result["stdout"].strip() else ""
    match = re.fullmatch(r"https://github\.com/[^/]+/[^/]+/issues/(\d+)", url)
    if not match or f"github.com/{repo}/issues/" not in url:
        return {"status": "published_unverified", "url": url}
    number = match.group(1)
    verify = _run(["gh", "issue", "view", number, "--repo", repo, "--json", "number,title,body,url"], timeout=45)
    if not verify["ok"]:
        return {"status": "published_unverified", "url": url}
    try:
        issue = json.loads(verify["stdout"])
    except ValueError:
        return {"status": "published_unverified", "url": url}
    if issue.get("title") != title or issue.get("body") != body or issue.get("url") != url:
        return {"status": "published_unverified", "url": url}
    return {"status": "verified", "repository": repo, "number": int(number), "url": url}


def _publish_cron_failure(args):
    finding_id = str(args.get("finding_id", ""))
    finding = _CRON_FINDINGS.get(finding_id)
    if not finding:
        return {"status": "blocked", "detail": "use a finding ID returned by the current cron health check"}
    repo = _MAIN_REPO
    title = f"[cron] {finding['job_name']}: {finding['kind']}"
    body = (
        "## Scheduler health finding\n\n"
        f"- Job: `{finding['job_name']}` (`{finding['job_id']}`)\n"
        f"- Failure: `{finding['kind']}`\n"
        f"- Observed: `{finding['observed_at']}`\n"
        f"- Schedule: `{json.dumps(finding.get('schedule'), sort_keys=True)}`\n"
        f"- Detail: {finding['detail']}\n\n"
        f"Scheduler health finding ID: `{finding_id}`\n"
    )
    if _SECRET_RE.search(title) or _SECRET_RE.search(body):
        return {"status": "blocked", "detail": "scheduler evidence contains content matched by the sensitive-data filter"}
    marker_search = _run([
        "gh", "issue", "list", "--repo", repo, "--state", "all", "--limit", "1000",
        "--search", f"{finding_id} in:body", "--json", "number,title,url",
    ], timeout=45)
    if not marker_search["ok"]:
        return {"status": "dedupe_check_failed", "detail": marker_search.get("stderr", "")}
    try:
        prior = json.loads(marker_search["stdout"])
    except (TypeError, ValueError):
        return {"status": "dedupe_check_failed", "detail": "invalid GitHub reproduction-marker response"}
    if prior:
        return {"status": "duplicate", "issues": prior}
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", prefix="triage-cron-", delete=True) as body_file:
        body_file.write(body)
        body_file.flush()
        result = _run(["gh", "issue", "create", "--repo", repo, "--title", title, "--body-file", body_file.name], timeout=60)
    if not result["ok"]:
        return {"status": "publish_failed", "detail": result.get("stderr", "")}
    url = result.get("stdout", "").strip().splitlines()[-1] if result.get("stdout", "").strip() else ""
    match = re.fullmatch(r"https://github\.com/[^/]+/[^/]+/issues/(\d+)", url)
    if not match or f"github.com/{repo}/issues/" not in url:
        return {"status": "published_unverified", "url": url}
    number = match.group(1)
    verify = _run(["gh", "issue", "view", number, "--repo", repo, "--json", "number,title,body,url"], timeout=45)
    if not verify["ok"]:
        return {"status": "published_unverified", "url": url}
    try:
        issue = json.loads(verify["stdout"])
    except (TypeError, ValueError):
        return {"status": "published_unverified", "url": url}
    if issue.get("title") != title or issue.get("body") != body or issue.get("url") != url:
        return {"status": "published_unverified", "url": url}
    return {"status": "verified", "repository": repo, "number": int(number), "url": url}


_COLLECT_SCHEMA = {
    "name": "triage_collect_snapshot",
    "description": "Collect and return exactly one bounded, redacted log snapshot for an approved service.",
    "parameters": {"type": "object", "properties": {"component": {"type": "string", "enum": list(_COMPONENTS)}}, "required": ["component"], "additionalProperties": False},
}
_REPRO_SCHEMA = {
    "name": "triage_run_reproducer",
    "description": "Run a supplied reproduction at the captured image revision, with fixture.txt, in a disposable, networkless, read-only, resource-bounded container with no host mounts.",
    "parameters": {"type": "object", "properties": {"component": {"type": "string", "enum": list(_COMPONENTS)}, "collection_id": {"type": "string"}, "revision": {"type": "string"}, "command": {"type": "string"}, "fixture": {"type": "string"}}, "required": ["component", "collection_id", "revision", "command", "fixture"], "additionalProperties": False},
}
_SEARCH_SCHEMA = {
    "name": "triage_search_issues",
    "description": "Search all open and closed issues in the fixed repository for this component.",
    "parameters": {"type": "object", "properties": {"component": {"type": "string", "enum": list(_COMPONENTS)}, "query": {"type": "string"}}, "required": ["component", "query"], "additionalProperties": False},
}
_PUBLISH_SCHEMA = {
    "name": "triage_publish_finding",
    "description": "Create a deduplicated-confirmed-finding issue in the component's fixed repository after a successful isolated reproduction.",
    "parameters": {"type": "object", "properties": {"component": {"type": "string", "enum": list(_COMPONENTS)}, "reproduction_id": {"type": "string"}, "title": {"type": "string"}, "body": {"type": "string"}}, "required": ["component", "reproduction_id", "title", "body"], "additionalProperties": False},
}
_CRON_HEALTH_SCHEMA = {
    "name": "triage_check_cron_health",
    "description": "Read the live cron jobs, ticker heartbeat, and execution history; report missed, late, failed, or undelivered enabled jobs.",
    "parameters": {"type": "object", "properties": {}, "additionalProperties": False},
}
_PUBLISH_CRON_SCHEMA = {
    "name": "triage_publish_cron_failure",
    "description": "Publish one verified scheduler-health finding returned by the current cron health check, with stable deduplication and read-back verification.",
    "parameters": {"type": "object", "properties": {"finding_id": {"type": "string"}}, "required": ["finding_id"], "additionalProperties": False},
}


def _json_result(handler):
    """The gateway accepts only string tool results, so serialize the dict payloads."""
    def wrapped(args, **_dispatcher_context):
        # Hermes injects task_id/session_id into any handler taking **kwargs; the handlers take only args.
        result = handler(args)
        return result if isinstance(result, str) else json.dumps(result, sort_keys=True)
    return wrapped


def register(ctx):
    for name, schema, handler in (
        ("triage_collect_snapshot", _COLLECT_SCHEMA, _collect),
        ("triage_run_reproducer", _REPRO_SCHEMA, _reproduce),
        ("triage_search_issues", _SEARCH_SCHEMA, _search_issues),
        ("triage_publish_finding", _PUBLISH_SCHEMA, _publish),
        ("triage_check_cron_health", _CRON_HEALTH_SCHEMA, _cron_health),
        ("triage_publish_cron_failure", _PUBLISH_CRON_SCHEMA, _publish_cron_failure),
    ):
        ctx.register_tool(
            name=name,
            toolset="log_issue_triage",
            schema=schema,
            handler=_json_result(handler),
            description=schema["description"],
        )
