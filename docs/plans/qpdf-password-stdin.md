QUESTIONS
q: Why do the unlock tests fail only on CI? | a: The hermes-scripts job now runs on ubuntu-26.04 with qpdf 12.3.2. A diagnostic run (#96) showed `qpdf: open f: Permission denied` for a mode-0600 password file owned by the runner user, while qpdf still reads and writes the `.pdf` files. The same tests pass in a plain `ubuntu:26.04` container, as root and as a normal user, so the runner confines qpdf's file reads.
q: Does qpdf accept the password on stdin? | a: Yes. `--password-file=-` reads the password from standard input; it has existed since qpdf 10.2, and the hermes image's Debian qpdf is newer than that.
q: Does this weaken how the password is handled? | a: No. The password still never appears in argv or a log, and it no longer touches the filesystem at all.

# Plan: pass the statement password to qpdf on stdin (issue #97)

## Problem

`decrypt_pdf` in `modules/hermes/plugins/email-intake/intake/unlock.py` writes each candidate password to a private temporary file and runs `qpdf --password-file=<file>`. On the ubuntu-26.04 runners qpdf cannot open that file, so every decrypt returns `None` and `test_email_intake_unlock.py` fails (2 failures, 3 errors). The Unit Tests workflow, which the deploy workflow also calls, therefore fails on every PR.

## Change

In `unlock.py`:

1. Run `qpdf --password-file=- --decrypt <in> <out>` and pass the password bytes through `input=`.
2. Drop the temporary password file and update the module docstring to say the password goes in on stdin.

## Tests

- New `modules/tests/test_email_intake_unlock_stdin.py`, with qpdf faked: the command has `--password-file=-`, and `input` is the password. It fails at base.
- The existing `modules/hermes/tests/test_email_intake_unlock.py` runs real qpdf and must still pass. It is run in an `ubuntu:26.04` container locally and by CI.
