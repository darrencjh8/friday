# Git Credential Helper Pattern

When `gh auth login --with-token` rejects a non-PAT token, use a one-shot
credential helper script to push with `git` directly.

## One-shot helper (in-memory, no file left behind)

```bash
# Create a temporary credential helper that echoes the token
helper=$(mktemp)
cat > "$helper" << 'SCRIPT'
#!/bin/sh
echo "username=oauth2"
echo "password=***"
SCRIPT
chmod 700 "$helper"

# Push using the helper
git -c "credential.helper=$helper" push -u origin main

# Clean up
rm -f "$helper"
```

## Per-session env approach

```bash
# Set git to use an inline credential helper for this session
git config credential.helper \
  '!f() { echo "username=oauth2"; echo "password=$GITHUB_TOKEN"; }; f'

git push -u origin main

# Clear when done
git config --unset credential.helper
```
