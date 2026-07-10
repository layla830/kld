#!/usr/bin/env python3
import json
import os
import sqlite3
import urllib.request
import argparse
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

DB = "/home/ccagent/.cc-connect/state/kld-local-memory.sqlite3"
URL = os.environ.get("KLD_WORKER_URL", "https://kld.yuxin2247.workers.dev").rstrip("/") + "/v1/memory-candidates"
TOKEN = os.environ.get("KLD_ADMIN_PASSWORD", "").strip() or os.environ.get("MEMORY_MCP_API_KEY", "").strip()

parser = argparse.ArgumentParser(description="Sync local Dream candidates to the Worker review queue.")
parser.add_argument("--date", default=None, help="Dream date YYYY-MM-DD; defaults to yesterday Asia/Singapore.")
args = parser.parse_args()
dream_date = args.date or (datetime.now(ZoneInfo("Asia/Singapore")) - timedelta(days=1)).strftime("%Y-%m-%d")

db = sqlite3.connect(DB)
db.row_factory = sqlite3.Row
rows = db.execute("""
    SELECT candidate_key, dream_date, action, subject, target_id, payload_json,
           source_chunk_ids_json, status
    FROM memory_candidates
    WHERE dream_date=? AND status IN ('pending','needs_subject_review')
    ORDER BY id
""", (dream_date,)).fetchall()

candidates = []
for row in rows:
    chunk_ids = json.loads(row["source_chunk_ids_json"] or "[]")
    placeholders = ",".join("?" for _ in chunk_ids)
    chunks = []
    if chunk_ids:
        for chunk in db.execute(
            f"SELECT id,start_time,end_time,summary,keywords_json,important_quotes_json FROM recall_chunks WHERE id IN ({placeholders}) ORDER BY id",
            chunk_ids,
        ):
            chunks.append({
                "id": chunk[0], "start_time": chunk[1], "end_time": chunk[2], "summary": chunk[3],
                "keywords": json.loads(chunk[4] or "[]"), "important_quotes": json.loads(chunk[5] or "[]"),
            })
    payload = json.loads(row["payload_json"])
    candidates.append({
        "external_key": row["candidate_key"], "dream_date": row["dream_date"], "action": row["action"],
        "subject": row["subject"], "target_id": row["target_id"], "payload": payload,
        "source_chunk_ids": chunk_ids, "source_chunks": chunks, "status": row["status"],
        "validation_error": payload.get("validation_error") or payload.get("subject_validation_error"),
    })

if not candidates:
    print(json.dumps({"ok": True, "accepted": 0, "reason": "nothing_to_sync"}))
    raise SystemExit(0)
if not TOKEN:
    raise SystemExit("missing Worker token")
body = json.dumps({"namespace": "default", "candidates": candidates}, ensure_ascii=False).encode("utf-8")
request = urllib.request.Request(URL, data=body, method="POST", headers={
    "Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json", "User-Agent": "kld-candidate-sync/1.0",
})
with urllib.request.urlopen(request, timeout=90) as response:
    result = json.loads(response.read().decode("utf-8"))
if int((result.get("data") or {}).get("accepted") or 0) != len(candidates):
    raise SystemExit(f"partial sync: {result}")
db.execute("UPDATE memory_candidates SET status='synced', updated_at=datetime('now') WHERE dream_date=? AND status IN ('pending','needs_subject_review')", (dream_date,))
db.commit()
print(json.dumps({"ok": True, "date": dream_date, "accepted": len(candidates)}, ensure_ascii=False))
