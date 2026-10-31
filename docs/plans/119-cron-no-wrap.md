QUESTIONS
q: Should the header and footer be removed for every cron job, or only proactive-tick? | a: Every job. Hermes has only the global `cron.wrap_response` switch, and Darren asked to omit the prefix and footer.
q: Does the live /opt/data/config.yaml already carry a `cron:` block that a baked block would replace? | a: No. Read-only check on 2026-10-31 found no `cron` or `wrap_response` key in the live file.

# Plan: deliver Hermes cron output without the wrapper (#119)

## Problem

Every cron delivery arrives wrapped by Hermes:

```
Cronjob Response: proactive-tick
(job_id: 5bb972340ca3)
-------------

<message>

To stop or manage this job, send me a new message (e.g. "stop reminder proactive-tick").
```

Upstream `cron/scheduler_delivery.py` adds this header and footer while
`cron.wrap_response` is true, which is the default in
`hermes_cli/config_defaults.py`. The upstream cron guide documents
`cron.wrap_response: false` as the way to deliver the raw agent output.

## Change

1. Add a top-level `cron:` block with `wrap_response: false` to
   `modules/hermes/config.yaml`, with a comment naming the issue.
2. Add `modules/hermes/tests/test_cron_wrap_config.py`
   (`CronWrapConfigTest.test_cron_responses_are_not_wrapped`), which loads the
   baked config and asserts `cron.wrap_response` is `False`.
3. Run that test in `.github/workflows/test.yml`.

## Merge safety

`50-seed-defaults` merges the baked config into `/opt/data/config.yaml` at the
top level with baked keys winning, so a partial baked block replaces the whole
live block. The live config has no `cron:` block, so nothing is dropped. Every
other cron setting keeps its upstream default.

## Trade-off

The setting is global. Messages from every cron job lose the job name and id,
so the sender is known only from the content.

## Validation

- RED: the new test fails at the base commit (no `cron` block).
- GREEN: the new test passes at HEAD.
- After the CI deploy, the next proactive-tick message arrives without the
  header and footer.
