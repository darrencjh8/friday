"""Reproduction for friday #144: a deploy run that replaces a cancelled queued
run must ship the cancelled run's changes, not just its own commit.

Simulates the 2026-11-03 burst in throwaway git repos: an initial commit,
then A touching modules/expense-tracker, B touching
modules/portfolio-tracker, C touching modules/hermes. The last successful
deploy is the initial commit. The workflow's "Detect changed modules" step
(extracted from .github/workflows/deploy.yml and executed as-is, under
bash -eo pipefail like GitHub Actions) must report exactly expense-tracker,
portfolio-tracker and hermes. At base it only reports hermes, because the
step diffs HEAD~1.
"""
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

TEST_ID = "tests.test_issue_144.TestIssue144.test_deploy_covers_cancelled_runs"
ROOT = Path(__file__).resolve().parents[2]
EXACT = ["expense-tracker", "hermes", "portfolio-tracker"]


def run(cmd, cwd, env=None, path_extra=None):
    merged = dict(os.environ)
    if env:
        merged.update(env)
    if path_extra:
        merged["PATH"] = path_extra + os.pathsep + merged["PATH"]
    return subprocess.run(cmd, cwd=cwd, env=merged, capture_output=True, text=True)


def extract_detect_step():
    lines = (ROOT / ".github" / "workflows" / "deploy.yml").read_text().splitlines()
    start = next(i for i, l in enumerate(lines) if "Detect changed modules" in l)
    run_idx = next(i for i in range(start, len(lines)) if lines[i].strip() == "run: |")
    body = []
    for line in lines[run_idx + 1:]:
        if line.strip() == "":
            body.append("")
            continue
        if not line.startswith(" " * 16):
            break
        body.append(line[16:])
    return "\n".join(body) + "\n"


def make_burst_repo(td):
    repo = Path(td) / "repo"
    repo.mkdir()
    run(["git", "init", "-q"], cwd=repo)
    run(["git", "config", "user.email", "test@example.com"], cwd=repo)
    run(["git", "config", "user.name", "Test"], cwd=repo)
    (repo / "README.md").write_text("base\n")
    run(["git", "add", "."], cwd=repo)
    run(["git", "commit", "-qm", "initial"], cwd=repo)
    base_sha = run(["git", "rev-parse", "HEAD"], cwd=repo).stdout.strip()
    for rel, msg in [
        ("modules/expense-tracker/app.py", "expense-tracker change (#140)"),
        ("modules/portfolio-tracker/app.py", "portfolio-tracker zod upgrade (#127)"),
        ("modules/hermes/app.py", "hermes change (#138)"),
    ]:
        target = repo / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(msg + "\n")
        run(["git", "add", "."], cwd=repo)
        run(["git", "commit", "-qm", msg], cwd=repo)
    return repo, base_sha


def run_step(td, repo, step, extra_env, path_extra=None):
    out_file = Path(td) / "github_output.txt"
    if out_file.exists():
        out_file.unlink()
    script = repo / "detect.sh"
    script.write_text(step)
    env = {
        "GITHUB_OUTPUT": str(out_file),
        "FORCE_ALL": "false",
        "DEPLOY_COMPONENTS_OVERRIDE": "",
        "GITHUB_EVENT_NAME": "push",
        "DISPATCH_REF": "",
        "GITHUB_REPOSITORY": "darrencjh8/friday",
    }
    env.update(extra_env)
    result = run(["bash", "-eo", "pipefail", str(script)], cwd=repo, env=env,
                 path_extra=path_extra)
    components = None
    if out_file.exists():
        for line in out_file.read_text().splitlines():
            if line.startswith("components="):
                components = line.split("=", 1)[1].strip()
    return result.returncode, components, result.stderr.strip()


def stub_curl(td, head_sha=None, fail=False):
    bindir = Path(td) / "bin"
    bindir.mkdir(exist_ok=True)
    args_file = Path(td) / "curl_args.txt"
    stub = bindir / "curl"
    if fail:
        stub.write_text("#!/bin/sh\nexit 22\n")
    else:
        payload = json.dumps(
            {"total_count": 1,
             "workflow_runs": [{"head_sha": head_sha, "status": "completed",
                                "conclusion": "success"}]},
            indent=2)
        stub.write_text(
            "#!/bin/sh\n"
            f"printf '%s\\n' \"$@\" > {args_file}\n"
            f"cat <<'PAYLOAD'\n{payload}\nPAYLOAD\n")
    stub.chmod(0o755)
    return str(bindir), args_file


def main():
    failures = []
    step = extract_detect_step()
    if "HEAD~1" in step:
        failures.append("detect step still references HEAD~1")
    with tempfile.TemporaryDirectory() as td:
        repo, base_sha = make_burst_repo(td)
        # A. Override base: exact component set, not a subset, not "all".
        rc, comp, err = run_step(td, repo, step,
                                 {"LAST_SUCCESSFUL_DEPLOY_SHA": base_sha})
        if rc != 0:
            failures.append(f"override case exited {rc}: {err}")
        elif comp is None or sorted(comp.split()) != EXACT:
            failures.append(f"override case components={comp!r}, expected {EXACT}")
        # B. Full clone with a real origin: the no-fetch path is exercised.
        bare = Path(td) / "origin.git"
        run(["git", "init", "-q", "--bare", str(bare)], cwd=td)
        run(["git", "push", "-q", str(bare), "HEAD:refs/heads/main"], cwd=repo)
        run(["git", "--git-dir", str(bare), "symbolic-ref", "HEAD",
             "refs/heads/main"], cwd=td)
        full = Path(td) / "full"
        run(["git", "clone", "-q", str(bare), str(full)], cwd=td)
        run(["git", "config", "user.email", "test@example.com"], cwd=full)
        run(["git", "config", "user.name", "Test"], cwd=full)
        rc, comp, err = run_step(td, full, step,
                                 {"LAST_SUCCESSFUL_DEPLOY_SHA": base_sha})
        if rc != 0:
            failures.append(f"full-clone case exited {rc}: {err}")
        elif comp is None or sorted(comp.split()) != EXACT:
            failures.append(f"full-clone case components={comp!r}, expected {EXACT}")
        # C. Non-ancestor base: deploy all, never a wrong subset.
        run(["git", "checkout", "-qb", "diverged", base_sha], cwd=repo)
        target = repo / "modules" / "hermes" / "other.py"
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text("diverged\n")
        run(["git", "add", "."], cwd=repo)
        run(["git", "commit", "-qm", "diverged"], cwd=repo)
        diverged_sha = run(["git", "rev-parse", "HEAD"], cwd=repo).stdout.strip()
        run(["git", "checkout", "-q", "master"], cwd=repo)
        rc, comp, err = run_step(td, repo, step,
                                 {"LAST_SUCCESSFUL_DEPLOY_SHA": diverged_sha})
        if rc != 0:
            failures.append(f"non-ancestor case exited {rc}: {err}")
        elif comp != "all":
            failures.append(f"non-ancestor case components={comp!r}, expected 'all'")
        # D. API lookup via stub curl: uses the returned head_sha, and the
        # request carries the event=push filter and an Authorization header.
        bindir, args_file = stub_curl(td, base_sha)
        rc, comp, err = run_step(td, repo, step, {}, path_extra=bindir)
        if rc != 0:
            failures.append(f"lookup case exited {rc}: {err}")
        elif comp is None or sorted(comp.split()) != EXACT:
            failures.append(f"lookup case components={comp!r}, expected {EXACT}")
        elif args_file.exists():
            args = args_file.read_text()
            if "event=push" not in args:
                failures.append("lookup case: curl URL lacks event=push")
            if "Authorization: Bearer" not in args:
                failures.append("lookup case: curl lacks Authorization header")
        else:
            failures.append("lookup case: stub curl was never called")
        # E. Lookup failure and no override: deploy all, never a subset.
        bindir, _ = stub_curl(td, fail=True)
        rc, comp, err = run_step(td, repo, step, {}, path_extra=bindir)
        if rc != 0:
            failures.append(f"failure case exited {rc}: {err}")
        elif comp != "all":
            failures.append(f"failure case components={comp!r}, expected 'all'")
        # G. Lookup returns 200 but an unparsable body (no head_sha): deploy
        # all, never a subset. (Code review round 1, L1.)
        bindir = Path(td) / "bin-unparsable"
        bindir.mkdir(exist_ok=True)
        stub = bindir / "curl"
        stub.write_text("#!/bin/sh\necho '{}'\n")
        stub.chmod(0o755)
        rc, comp, err = run_step(td, repo, step, {}, path_extra=str(bindir))
        if rc != 0:
            failures.append(f"unparsable-response case exited {rc}: {err}")
        elif comp != "all":
            failures.append(
                f"unparsable-response case components={comp!r}, expected 'all'")
        # F. Dispatch on main uses the lookup; dispatch elsewhere deploys all.
        bindir, _ = stub_curl(td, base_sha)
        rc, comp, err = run_step(
            td, repo, step,
            {"GITHUB_EVENT_NAME": "workflow_dispatch", "DISPATCH_REF": "main"},
            path_extra=bindir)
        if rc != 0:
            failures.append(f"dispatch-main case exited {rc}: {err}")
        elif comp is None or sorted(comp.split()) != EXACT:
            failures.append(f"dispatch-main case components={comp!r}, expected {EXACT}")
        rc, comp, err = run_step(
            td, repo, step,
            {"GITHUB_EVENT_NAME": "workflow_dispatch", "DISPATCH_REF": "feature-x"},
            path_extra=bindir)
        if rc != 0:
            failures.append(f"dispatch-other case exited {rc}: {err}")
        elif comp != "all":
            failures.append(f"dispatch-other case components={comp!r}, expected 'all'")
    if failures:
        print(f"FAIL: {TEST_ID} " + "; ".join(failures))
        return 1
    print(f"{TEST_ID}: PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
