---
name: google-login
description: Set up or renew Friday's Google access (Tasks, Gmail read-only, Calendar read-only) with `google login`, including the SSH tunnel from Darren's Windows PC. Use when he asks to log in to Google, or when gtasks, gmail or gcal report an expired or missing login.
---

# Google login

One login covers all three CLIs: `gtasks` (Tasks, read and write), `gmail` (read-only) and `gcal` (read-only). The token is saved once and shared. Run a login only when Darren asks to set up or renew Google access, or after a CLI reports the login expired and he agrees.

## Check first

`google status` prints `logged in: calendar.readonly, gmail.readonly, tasks` when all is well. A missing name means that box was left unticked at consent; log in again to add it. `not logged in` means there is no token.

## Why a tunnel is needed

Hermes runs in a Docker container on the production host. `google login` listens for Google's callback on port 8299 inside the container, and the host publishes that port on its loopback only (`127.0.0.1:8299`). Google sends the browser to the registered redirect `http://localhost:9090/callback`, and `localhost` there is Darren's own PC. An SSH local forward joins the two: PC port 9090 → host `localhost:8299` → container listener.

## Automatic flow (default)

1. Start `google login` as a background process, then read its output. It prints the authorization URL and an `ssh -L 9090:localhost:8299 user@your-host...` hint. The hint's target is a placeholder: give Darren the real SSH user and host from the wiki page on Google login.
2. Send Darren the URL and these Windows steps:
   - Open PowerShell or Windows Terminal. Windows 10 and 11 ship the OpenSSH client, so `ssh` works without installing anything.
   - Run `ssh -L 9090:localhost:8299 <user>@<host>` with the real user and host, and log in. On the first connection, answer `yes` to the host-key question. Leave the window open: closing it stops the tunnel.
   - Open the authorization URL in a browser on that same PC.
3. On the consent screens:
   - "Google hasn't verified this app" is expected; this is his own personal-use OAuth app. Click Advanced, then "Go to ... (unsafe)".
   - Tick all three boxes: Tasks, "View your email messages and settings" and Calendar read-only.
   - If Google asks for anything broader than those three, cancel. The CLI also refuses to save a token with more.
4. The browser shows "Done. Return to your terminal." and the background process prints `Login saved: ...`. Confirm with `google status`. Darren can then close the SSH window.

The listener gives up after 300 seconds. If it timed out, start a fresh `google login`; an old URL is not reused.

## Manual flow (phone, or the tunnel will not work)

Run `google login --manual` and give Darren the URL. He consents as above. The browser then fails to open `http://localhost:9090/callback?...` (connection refused); that is expected. He copies the whole address from the address bar and pastes it back. You feed it to the waiting prompt (`Redirect URL:`), and the CLI checks the state value and exchanges the code once. Never ask for a code or URL outside this flow.

## Troubleshooting

- `bind: Address already in use` (or `cannot listen to port: 9090`) in PowerShell means something on the PC already uses port 9090, often an earlier tunnel. Close that window, or find the owner with `netstat -ano | findstr :9090`. The redirect is registered on 9090, so a different local port does not work.
- Connection refused or reset after consent, with the tunnel up, means no listener in the container. Usually the login timed out or was never started; start a new one.
- The SSH login itself fails: he is not on the home network or the tailnet. Connect the PC to the tailnet, then use the tailnet host name instead of the LAN address.
- `redirect_uri_mismatch` or a 400 policy page from Google means the redirect is not `http://localhost:9090/callback`. Never switch to a tailnet-host redirect; Google rejects those.
- The browser shows "authorization failed" when he cancelled or declined consent; start again.

## Safety

- `GTASKS_CLIENT_ID` and `GTASKS_CLIENT_SECRET` come from the container environment. Check only whether each is set; never print, log or copy either value.
- Never open, print, export or copy the token file or the OAuth config.
- Run `google logout` only when Darren explicitly asks. It deletes the local token; he revokes access at Google account > Security > Third-party access.
