#!/usr/bin/env python3
import argparse
import subprocess
import sys
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

TOOLS = "/home/ccagent/cc-workspace/tools"

parser = argparse.ArgumentParser(description="Generate VPS chunk candidates and sync them to Worker review.")
parser.add_argument("--date", default=None, help="Dream date YYYY-MM-DD; defaults to yesterday Asia/Singapore.")
parser.add_argument("--force", action="store_true", help="Regenerate a date from its first chunk; dedupe still applies.")
args = parser.parse_args()
date = args.date or (datetime.now(ZoneInfo("Asia/Singapore")) - timedelta(days=1)).strftime("%Y-%m-%d")

generate = [sys.executable, f"{TOOLS}/kld_dream_candidate_shadow.py", "--candidate-only", "--date", date]
if args.force:
    generate.append("--force")
subprocess.run(generate, check=True)
subprocess.run([sys.executable, f"{TOOLS}/kld_candidate_sync.py", "--date", date], check=True)
print(f"candidate pipeline complete date={date}")


