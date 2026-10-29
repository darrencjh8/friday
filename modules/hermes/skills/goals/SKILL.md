---
name: goals
description: Track Darren's standing goals in Mnemosyne and follow up on them. Use when he sets, updates, pauses, finishes or drops a goal, asks what his goals are, or replies to a goal check-in.
---

# Goals

A goal is something Darren wants to reach over days or weeks ("build a 20k car fund by June 2027"), not a one-off task or reminder. Goals live only in Mnemosyne canonical slots: category `goal`, one slot per goal, named by a short kebab-case slug. There is no goals file. The `goal-tick` cron job reads these slots to decide when to check in.

## Slot body

Write the body as plain `key: value` lines so a later session can read it without guessing:

```
status: active | paused | done | dropped
outcome: what "done" looks like, measurable where possible
why: the reason he gave
constraints: limits he stated (budget, timing, things not to do)
next_step: the single next action, and who owns it
check_in: daily | weekly | YYYY-MM-DD (when to raise it next)
keywords: words a recall search should use to find the related chats
updated: YYYY-MM-DD
log: dated one-line notes of decisions and progress, newest first, at most 5
```

## In a chat session

- **Set**: restate the goal in the slot format and ask him to confirm. Only after he confirms, write it with `mnemosyne_remember_canonical(category="goal", name=<slug>, body=...)`. Fill `why`, `constraints` and `keywords` from what he said in this conversation; do not invent them.
- **Update**: read the slot with `mnemosyne_recall_canonical(category="goal", name=<slug>)`, change only what he changed, bump `updated`, add a `log` line, and write it back. Restating the same body is a no-op, and a new body keeps the old one as history.
- **Reply to a check-in**: the check-in message names the goal slug. Record what he decided in `log` and `next_step`, and move `check_in` to the next date he agreed to. A plain "done" sets `status: done`; "drop it" sets `status: dropped`.
- **List**: `mnemosyne_recall_canonical(category="goal")` and show slug, status, next step and next check-in.
- **Finish or drop**: set the status rather than calling `mnemosyne_forget_canonical`, so the history stays readable.

## Approval

Friday may remind and ask on her own. Anything that acts for Darren (sending a message to someone else, paying, booking, buying, changing an account) needs his explicit yes in the chat for that specific action, even when it serves an active goal. A goal is never standing approval.

## In a cron session

Cron sessions can read Mnemosyne but cannot write it. Do not try to update a goal from cron. Put what changed in the check-in message; the slot is updated from chat when Darren replies.
