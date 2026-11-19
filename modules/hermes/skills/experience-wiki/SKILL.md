---
name: experience-wiki
description: The shared experience wiki of reusable work craft (bug fixes, common problems, coding style, CI and testing, tooling) in /workspace/friday-persona/experience. Search it before repo work, debugging or a CI failure; add to it when a PR merges or an issue closes and you learned a fact other agents can reuse.
---

# Experience wiki

A Karpathy-style LLM wiki shared with the other Friday agents, in the `experience/` folder of the persona repo. `persona-sync` refreshes the clone at `/workspace/friday-persona` every 6 hours. The folder's own `AGENTS.md` is the schema: follow it.

## Read first

Before repo work, debugging or fixing a CI failure, search for the error or behaviour:
`rg -i "<error text or topic>" /workspace/friday-persona/experience/wiki/`
Start from `experience/wiki/index.md`. An article marked Outdated or Disputed is history, not current advice. If the wiki and live state disagree, live state wins.

## Write when you learned something reusable

At the close of a piece of work, ask: did I learn a fact another agent could reuse? If it is not reusable across agents, it does not go in. Never add persona content, session narratives, or anyone's personal details, the owner's included.

1. Add the evidence as a new dated file under `experience/raw/` (verbatim excerpt). Never edit or delete an existing raw file.
2. Create or update the article under `experience/wiki/<topic>/`. Mark a superseded claim Outdated instead of deleting it.
3. Update `experience/wiki/index.md` and append one entry to the end of `experience/wiki/log.md`: `## [YYYY-MM-DD] <operation> | <title>`.
4. Publish: `/opt/data/scripts/experience-commit.sh "<one-line summary>"`. It checks the change for personal information, tags a backup, and pushes.

If it exits non-zero, tell the owner what it printed. Exit 2 means refused (the edit is parked under `/opt/data/persona-reflection/pending/`); exit 3 means the other agent changed the same lines and the owner merges by hand.
