QUESTIONS
q: Should ignore rules key on sender, subject, or both? | a: Subject is required; the sender domain is optional. The operator asked for generic, subject-based rules, not per-sender ones.
q: Does a sender-less rule need DMARC? | a: No. Ignoring a spoofed email books nothing and sends nothing. A sender-scoped rule still needs the exact domain and DMARC pass.
q: Should Jev get a new "rewards summary" kind instead? | a: No. The operator chose the generic wiki rule, so that one row covers it.
q: Which wins when a notify rule and an ignore rule both match? | a: The notify rule, so existing Notify behaviour is unchanged.
q: Who adds the Trust row to the wiki? | assumption: The operator, through the Hermes API after this ships, with a separate approval. The code reads the table and ships no rows.
END QUESTIONS

# Wiki-driven Ignore rules for email-intake (#131)

## Problem

The Trust cashback-summary email was recorded `shadow_uncertain`: Jev said
`marketing` at 0.65, below `CONFIDENCE = 0.85`. `Dispatcher._notices` then
queued `notify.review_text` ("Needs review ... /replay_..."). The wiki page
`entities/email-senders.md` already says this email needs no action, but
`senders.py` reads only `Sender domains` (Jev hints) and `Notify rules`
(always send a message). Nothing can suppress mail.

## Change

1. `intake/senders.py`:
   - `IGNORE_SECTION = "ignore rules"` and `IgnoreRule(domain, subject_contains)`.
   - `load_ignore_rules(path)` reads confirmed rows through `_confirmed_rows`.
     A blank, `*` or `any` domain means any sender. A row without subject
     text is skipped.
   - `match_ignore(rules, sender_domain, auth, subject)`: subjects are
     compared lower-cased, whitespace-collapsed, with curly apostrophes
     straightened. A rule with a domain needs that exact domain and
     `dmarc == "pass"`; a rule without one needs only the subject.
   - Update the module docstring.
2. `intake/shadow.py`: `ShadowRunner(..., ignore_rules=list)`. In `run_once`,
   after the copy and notify-rule checks and before the encrypted-PDF and
   Jev steps, a match records status `ignored_rule` with decision
   `{"version", "destination": "neither", "reason": "ignore_rule",
   "sender_domain"}` and counts `summary["ignored"]`. `ignored_rule` is in
   neither `_JEV_STATUSES` (so a classifier bump never re-sends it to Jev),
   `ROUTED_STATUSES` nor `NOTICE_STATUSES` (so it is never dispatched or
   reported), like Jev's own `ignored`.
3. `intake/service.py`: pass `ignore_rules=lambda: senders.load_ignore_rules(settings.senders_file)`.
4. Tests: new `modules/hermes/tests/test_email_intake_ignore.py`, wired into
   `.github/workflows/test.yml` next to the other email-intake tests. It covers:
   - parsing;
   - the authenticated Trust match: `ignored_rule`, no Jev call, no tracker
     call, no Telegram message;
   - DMARC fail, another sender with the same subject, a Trust alert and a
     Trust statement: all still go to Jev, then review;
   - near-miss subjects and the any-sender rule;
   - a notify rule winning over an ignore rule.

No wiki content ships in the repo. The Trust row is a later wiki write
through the Hermes API, approved separately.

## Verification

- RED: `python3 -m unittest modules/hermes/tests/test_email_intake_ignore.py`
  fails at base (`ignore_rules` and `load_ignore_rules` do not exist).
- GREEN at HEAD, plus every `modules/hermes/tests/test_email_intake*.py`.
