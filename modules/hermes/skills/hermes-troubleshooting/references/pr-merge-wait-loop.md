# PR merge → deploy → verify loop

For the `friday` repo's self-hosted CI/CD pipeline:

## Pitfall: `git pull` on feature branch after merge

After a PR merges to main, `git pull origin main` fails with "divergent branches"
if you're still on the feature branch. Always switch first:

```bash
git checkout main && git pull origin main
```

## Deploy monitoring

After merge, the deploy workflow (`deploy.yml`) triggers on push to main. Monitor:

```bash
# Wait for deploy run to appear (may take 30s+)
gh run list --workflow=deploy.yml --limit 1 --json status,headSha

# Poll until complete (self-hosted runner takes ~2-4 min)
while true; do
  status=$(gh run list --workflow=deploy.yml --limit 1 --json status,conclusion -q '.[0].status')
  case "$status" in completed) break;; *) sleep 30;; esac
done
```

## MCP tool availability after deploy

The Hermes agent discovers MCP tools at session start. Newly deployed tools
won't appear until the MCP session reconnects. For the expense-tracker module,
HTTP REST fallback endpoints at `/tools/<tool-name>` can be called directly
via curl in the interim.
