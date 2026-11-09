import re, subprocess, sys, tempfile
from pathlib import Path
import yaml

TEST_ID = "tests.test_issue_177.TestIssue177.test_threshold_and_mcp_persistence"

def main():
    ok = True
    config = yaml.safe_load(open("modules/hermes/config.yaml"))
    if config.get("compression", {}).get("threshold_tokens") != 350000:
        print(f"FAIL: {TEST_ID} threshold_tokens is {config.get('compression', {}).get('threshold_tokens')} expected 350000")
        ok = False
    seed = open("modules/hermes/50-seed-defaults").read()
    match = re.search(r"<<'PYCONFIG'[^\n]*\n(.*?)\nPYCONFIG", seed, re.DOTALL)
    assert match, "merge block missing"
    with tempfile.TemporaryDirectory() as td:
        baked = Path(td) / "baked.yaml"; live = Path(td) / "live.yaml"; merge = Path(td) / "merge.py"
        baked.write_text(open("modules/hermes/config.yaml").read())
        live.write_text("mcp_servers:\n  live-added-server:\n    url: http://live-added:8080/mcp\n  expense-tracker:\n    url: http://expense-tracker:8080/mcp\n")
        merge.write_text(match.group(1))
        result = subprocess.run([sys.executable, str(merge), str(baked), str(live)], capture_output=True, text=True)
        assert result.returncode == 0, result.stderr
        servers = (yaml.safe_load(live.read_text()).get("mcp_servers") or {})
        if "live-added-server" not in servers:
            print(f"FAIL: {TEST_ID} live-added MCP server wiped by seed merge")
            ok = False
        if "expense-tracker" not in servers:
            print(f"FAIL: {TEST_ID} baked MCP server lost")
            ok = False
    print(f"{TEST_ID}: {'PASS' if ok else 'FAIL'}")
    return 0 if ok else 1

if __name__ == "__main__":
    raise SystemExit(main())
