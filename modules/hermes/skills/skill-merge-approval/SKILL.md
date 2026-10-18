---
name: skill-merge-approval
description: Resolve a reply approving or rejecting a Telegram skill-merge proposal. Use when the user says approve/reject for a curator proposal, including a reply to the proposal message.
---

# Skill merge approval

The weekly proposal is report-only. A reply authorizes only the numbered merge rows from the exact saved run named by its proposal ID; it never authorizes prunings or a regenerated proposal.

Accept these forms when replying directly to a proposal whose ID is unambiguous in the preserved reply context:

- `approve all`
- `approve 1,3`
- `reject all`

In a fresh session without the replied-to message, require the explicit-ID forms `approve <proposal-id> all`, `approve <proposal-id> 1,3`, or `reject <proposal-id>`. Otherwise ask for the proposal ID. Rejection means make no changes.

Before any write, run `python3 curator-proposal-approval.py <proposal-id> <all|row-list>` from the same scripts directory as `curator-proposals.py` and inspect its JSON output. The validator checks that the original `/opt/data/logs/curator/<run-id>/run.json` still matches the hash in the ID and returns only selected `consolidations` from that report. Never rerun `hermes curator` to resolve an approval. If validation fails, stop and ask for a fresh proposal.

Apply only the returned `from` → `into` mappings, using the skill tools' normal read-before-write and ledgered-write rules. Do not apply unselected rows, pruning proposals, or other changes from the curator run. If any selected mapping cannot be applied safely, stop before proceeding to unrelated rows and report what succeeded and what did not.
