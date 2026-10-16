# File-tool quirks (read_file binary detection, terminal blocklist)

## read_file treats UTF-8 smart-punctuation files as binary

**Symptom:** `read_file` returns "Binary file - cannot display as text" for a plain `.js`/`.md` source file, while grep/git/diff work fine on the same file.

**Cause:** Files containing UTF-8 em-dashes or smart quotes (e.g. `—` in user-facing error strings, common in `friday/modules/*/src/*.js`) trip the binary-content detector — it keys on non-ASCII bytes.

**Diagnose:** `file`/`xxd` may not be installed on the host. `od -c <file> | head -5` shows the `342 200 224` (U+2014) bytes that trigger detection.

**Workaround:** Read line ranges with sed instead:
```bash
sed -n '775,900p' path/to/file.js
```
The `patch` tool still works on such files — only `read_file`'s display path is affected.

## Terminal rejects one-liners with nested $(...) substitution

**Symptom:** a multi-command one-liner like
```bash
grep -n 'fn tx' f.js && sed -n "$(grep -n 'fn tx' f.js | cut -d: -f1),+15p" f.js
```
is refused with "command parser limit or malformed executable payload" (hardline blocklist). The command is saved to `/opt/data/cache/blocked-scripts/` but the practical recovery is to redo the work with simpler tools.

**Workaround:** use `search_files` to locate the line number, then `read_file` (or `sed`) to view the range. Two simple calls beat one clever one-liner, and the blocklist never fires.

## Container test runs for modules with native deps

`friday` module tests (e.g. expense-tracker's vitest suite) cannot run on the local host when a native dep like `better-sqlite3` fails to build. The verified pattern:

1. Copy working-tree files into the container test dir — `/tmp/test-run` can be STALE:
   ```bash
   docker cp modules/expense-tracker/src modules-expense-tracker-1:/tmp/test-run/src
   docker cp modules/expense-tracker/tests modules-expense-tracker-1:/tmp/test-run/tests
   ```
2. Verify sync before trusting results — md5sums must match:
   ```bash
   md5sum modules/expense-tracker/src/tools.js
   docker exec modules-expense-tracker-1 md5sum /tmp/test-run/src/tools.js
   ```
3. Run filtered tests:
   ```bash
   docker exec modules-expense-tracker-1 sh -c 'cd /tmp/test-run && ./node_modules/.bin/vitest run tests/tools.test.js -t mark_email_read'
   ```
4. After a handler change, run the FULL test file plus dependent suites (orchestrator, imap) — filtered runs miss regressions elsewhere. Verified 2026-08: 7/7 filtered, 31/31 full tools.test.js, 142/142 orchestrator+imap suites.
