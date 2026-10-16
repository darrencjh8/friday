# Cron Job Debugging: Git Backup Script

Full transcript from debugging a failing `memory-backup` cron job (job ID `57d147e0a70f`).

## Symptoms

- `cronjob list` shows `last_status: error` for 13 consecutive runs
- Output log at `$HERMES_HOME/cron/output/<job_id>/` shows:
  ```
  remote: Invalid username or token. Password authentication is not supported for Git operations.
  fatal: Authentication failed for 'https://github.com/darrencjh8/friday-memory/'
  ```

## Diagnosis Steps

### 1. Check the cron job config
```bash
cronjob action=list
```
Key fields: `no_agent: true`, `script: memory-backup.sh`, `last_status: error`

### 2. Read the output logs
```bash
ls -la $HERMES_HOME/cron/output/<job_id>/
```
Each run produces a timestamped `.md` file with stdout, stderr, exit code.

### 3. Run the script manually with trace
```bash
bash -x /path/to/script.sh
```
This revealed: the script was using a stale `ghs_` (GitHub App) token from the initial clone, but `gh auth token` now returned a `github_pat_` (PAT). The remote URL was never refreshed between runs.

### 4. Check the remote URL
```bash
cd /path/to/clone && git remote -v
# Showed: x-access-token:ghs_<redacted> (stale)
gh auth token | head -c 12
# Showed: github_pat_1... (current)
```

Mismatch confirmed.

### 5. Fix: refresh remote URL every run
Added before `git pull`:
```bash
git remote set-url origin "$REPO_URL" 2>/dev/null || true
```

Changed `git pull` to `git pull --rebase` to handle divergence.

### 6. Secondary issue: stuck rebase + permission problems
The earlier `git pull --rebase` (before the URL fix) left a mid-rebase state:
```bash
git rebase --abort
git checkout main
```

Files from the original clone were read-only (git's default for checked-out files with restricted umask). Added:
```bash
[ -d "$CLONE_DIR" ] && chmod -R u+w "$CLONE_DIR" 2>/dev/null || true
```

### 7. Reset local clone to remote
The local clone was 15 commits behind:
```bash
git fetch origin main && git reset --hard origin/main
```

### 8. Verify
```bash
bash /path/to/script.sh; echo "EXIT: $?"
# EXIT: 0 — push succeeded
```

## Key Takeaways

| Pitfall | Fix |
|---------|-----|
| Git remote URL set once during clone, never refreshed | `git remote set-url` before every `pull`/`push` |
| `git pull` fails silently (`|| true`) with stale auth | Set URL first, then pull |
| Token type changes (ghs_ → github_pat_) between runs | Construct REPO_URL fresh each run |
| Clone files become read-only | `chmod -R u+w` at start of script |
| `git pull --rebase` can leave mid-rebase state | Use `git rebase --abort` as recovery |
