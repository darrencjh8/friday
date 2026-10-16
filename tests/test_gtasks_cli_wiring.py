from pathlib import Path

root = Path(__file__).resolve().parents[1]

def read(relative_path):
    path = root / relative_path
    return path.read_text() if path.is_file() else ""


compose = read("modules/docker-compose.yml")
workflow = read(".github/workflows/deploy.yml")
dockerfile = read("modules/hermes/Dockerfile")
skill = read("modules/hermes/skills/gtasks-cli/SKILL.md")

assert "GTASKS_CLIENT_ID=${GTASKS_CLIENT_ID:-}" in compose
assert "GTASKS_CLIENT_SECRET=${GTASKS_CLIENT_SECRET:-}" in compose
assert "GTASKS_REDIRECT_URI=" in compose
assert "http://localhost:9090/callback" in compose
assert "127.0.0.1:8299:8299" in compose
assert "XDG_CONFIG_HOME=/opt/data/.config" in compose
assert "GTASKS_CLIENT_ID: ${{ secrets.GTASKS_CLIENT_ID }}" in workflow
assert "GTASKS_CLIENT_SECRET: ${{ secrets.GTASKS_CLIENT_SECRET }}" in workflow
assert "COPY scripts/gtasks.py /usr/local/bin/gtasks" in dockerfile
assert "BRO3886" not in dockerfile and "GTASKS_VERSION" not in dockerfile
assert "https://www.googleapis.com/auth/tasks" in skill
assert not any(
    line.strip().startswith("echo ") and "GTASKS_CLIENT_SECRET" in line
    for line in skill.splitlines()
)
assert "`gtasks tasks rm" not in skill
assert "`gtasks tasklists rm" not in skill
print("Google Tasks CLI wiring and skill safety passed")
