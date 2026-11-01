#!/usr/bin/env python3
"""Pre-run script for the daily wiki-due-reminders job.

Captures only the Notion Accounts data source (read-only) as a hashed wiki raw
snapshot, so account action dates added or changed in Notion count the next
morning instead of waiting for the weekly wiki-finance-refresh. stdout names
the snapshot file (changed or unchanged) for the job prompt.
"""
import importlib.util
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("wiki_source_snapshot", os.path.join(HERE, "wiki-source-snapshot.py"))
snapshot = importlib.util.module_from_spec(spec)
spec.loader.exec_module(snapshot)

if __name__ == "__main__":
    sys.exit(snapshot.main(["--only", "notion-accounts"]))
