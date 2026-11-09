# OneDrive Sync Module

> Retired as a sync container: there is no `onedrive-sync` service in
> `modules/docker-compose.yml` and no rclone sync. Portfolio sync now happens
> inside portfolio-tracker via the Microsoft Graph API
> (`modules/portfolio-tracker/src/onedrive.js`, `pp-pull` / `pp-push`).

This directory is retained only for the OAuth refresh token path:
`modules/onedrive-sync/config/onedrive/`, which `modules/deploy.sh` still
points at. The token is created once by `authorize.sh` and read by
portfolio-tracker at runtime.

## One-time setup (delegated auth)

```bash
cd modules/onedrive-sync
./authorize.sh
```

This opens a browser for Microsoft OAuth. After authorizing, the refresh token
is stored in `config/onedrive/` and all future syncs run headlessly from
portfolio-tracker — there is nothing to start here.

## Configuration

| File | Purpose |
|---|---|
| `config/onedrive/` | OAuth tokens (created by `authorize.sh`) |
