# OneDrive Sync Module

Syncs specific OneDrive folders to local disk for portfolio-tracker to consume.

## Quick Start (delegated auth, recommended)

One-time setup:
```bash
cd modules/onedrive-sync
./authorize.sh
```

This opens a browser for Microsoft OAuth. After authorizing, the refresh token is stored in
`config/onedrive/` and all future syncs run headlessly.

Then start the sync:
```bash
docker compose up -d onedrive-sync
```

## Architecture

```
OneDrive Cloud
  └── PortfolioPerformance/portfolio.xml
        │
        ▼  driveone/onedrive (syncs every 5min)
  /onedrive_data/PortfolioPerformance/portfolio.xml
        │
        ▼  portfolio-tracker (reads via shared volume)
  Java CLI → PP XML processing
```

## Configuration

| File | Purpose |
|---|---|
| `config/sync_list` | Folders/files to sync (relative to OneDrive root) |
| `config/onedrive/` | OAuth tokens (created by `authorize.sh`) |

## Alternative: Client Credentials (headless, app-only)

Register an app in Azure AD → App registrations:
1. Name: `portfolio-sync`
2. API permissions: `Microsoft Graph` → `Files.Read.All` (Application)
3. Grant admin consent
4. Certificates & secrets → New client secret

Set these env vars in your `.env`:
```bash
ONEDRIVE_TENANT_ID=your-tenant-id
ONEDRIVE_CLIENT_ID=your-client-id
ONEDRIVE_CLIENT_SECRET=your-secret
```

Then run:
```bash
python sync.py
```

This uses `sync.py` which authenticates via Microsoft Graph API without any browser interaction.
