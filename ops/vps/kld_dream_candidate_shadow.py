#!/usr/bin/env python3
"""Candidate-only Dream shadow.

The production Dream owns shared prompt, normalization, Worker, logging and
cursor behavior. This module only reads recall chunks and persists local
candidate rows; it never writes Worker memories in candidate-only mode.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
from datetime import datetime, timezone
from typing import Any

from deepseek_client import chat_json
from kld_ingest_common import connect_db, iso_utc, load_env
from kld_dream import (
    EXCERPT_LIMIT,
    MAX_TOKENS,
    NAMESPACE,
    append_log,
    clean_str,
    date_range,
    fetch_existing_memories,
    format_transcript,
    normalize_plan,
    run_dream,
    yesterday_label,
)

MAX_CHUNKS = int(os.environ.get("KLD_DREAM_MAX_CHUNKS", "6"))
VALID_SUBJECTS = {"user", "kld", "relationship", "project", "external"}
AMBIGUOUS_SUBJECT_RE = re.compile(r"(^|[^A-Za-z])(?:我|你|她)(?=$|[^A-Za-z])")
MIN_MEMORY_CHINESE_CHARS = int(os.environ.get("KLD_DREAM_MIN_CHINESE_CHARS", "30"))
MAX_EVIDENCE_CHARS = int(os.environ.get("KLD_DREAM_MAX_EVIDENCE_CHARS", "80"))



def ensure_candidate_table(db) -> None:
    db.executescript(
        """
        CREATE TABLE IF NOT EXISTS memory_candidates (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          candidate_key TEXT NOT NULL UNIQUE,
          dream_date TEXT NOT NULL,
          action TEXT NOT NULL,
          subject TEXT,
          target_id TEXT,
          payload_json TEXT NOT NULL,
          source_chunk_ids_json TEXT NOT NULL DEFAULT '[]',
          status TEXT NOT NULL DEFAULT 'pending',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_memory_candidates_status
          ON memory_candidates(status, dream_date, id);
        """
    )
    columns = {row[1] for row in db.execute("PRAGMA table_info(memory_candidates)")}
    if "subject" not in columns:
        db.execute("ALTER TABLE memory_candidates ADD COLUMN subject TEXT")
    db.commit()


def load_date_chunks(db, start_iso: str, end_iso: str, after_id: int = 0) -> tuple[list[dict], bool]:
    rows = db.execute(
        """
        SELECT id, start_message_id, end_message_id, start_time, end_time,
               message_count, summary, keywords_json, important_quotes_json
        FROM recall_chunks
        WHERE id > ? AND end_time >= ? AND start_time < ?
        ORDER BY id ASC
        LIMIT ?
        """,
        (after_id, start_iso, end_iso, MAX_CHUNKS + 1),
    ).fetchall()
    has_more = len(rows) > MAX_CHUNKS
    rows = rows[:MAX_CHUNKS]
    chunks = [
        {
            "id": row[0],
            "start_message_id": row[1],
            "end_message_id": row[2],
            "start_time": row[3],
            "end_time": row[4],
            "message_count": row[5],
            "summary": row[6],
            "keywords": json.loads(row[7] or "[]"),
            "important_quotes": json.loads(row[8] or "[]"),
        }
        for row in rows
    ]
    return chunks, has_more


def format_chunks(chunks: list[dict]) -> str:
    return "\n\n".join(
        "\n".join(
            [
                f"[chunk:{chunk['id']}][{chunk['start_time']}..{chunk['end_time']}][messages:{chunk['start_message_id']}..{chunk['end_message_id']}]",
                f"摘要：{chunk['summary']}",
                f"关键词：{json.dumps(chunk['keywords'], ensure_ascii=False)}",
                f"关键原话：{json.dumps(chunk['important_quotes'], ensure_ascii=False)}",
            ]
        )
        for chunk in chunks
    )


def build_prompt(date_label: str, start_iso: str, end_iso: str, messages: list[dict], existing: list[dict], has_more: bool, chunks: list[dict] | None = None) -> str:
    return "\n".join(
        [
            "你是独立的 Dream 记忆整理器，不是用户，也不是对话助手 KLD。你的任务不是简单总结，而是在用户休息时整理长期记忆。",
            "你会读取旧长期记忆和当天聊天 transcript，产出一份更干净、更一致、更有用的 memory store 更新计划。",
            "只输出 JSON，不要 markdown，不要解释，不要输出思考过程。",
            "",
            "Dream 目标：",
            "- 合并重复记忆，避免同一事实以多个版本长期存在。",
            "- 发现过时、被新信息否定、互相矛盾的旧记忆，并更新或删除。",
            "- 从聊天中提炼未来会影响回答的稳定偏好、项目状态、关系事实、承诺、边界和重要原文。",
            "- 形成下一次对话可直接使用的简洁记忆，而不是保存流水账。",
            "",
            "窗口：",
            f"- 你只能处理 {date_label} 这一天窗口内的聊天。窗口是 {start_iso} 到 {end_iso}。",
            "- 这是当天最后一批或完整批次。" if not has_more else "- 这是当天的一批聊天，不是完整一天；只整理这一批里明确出现的信息。",
            "",
            "总原则：",
            "- 原始聊天不要逐条变成记忆，只保留未来真的会用到的事实、偏好、边界、项目进展、承诺。",
            "- 宁可少记，也不要把临时语气、寒暄、重复话、空内容、调试内容写进长期记忆。",
            "- 只有一条消息或一句孤立表达、没有后续确认或上下文支撑的内容，不要生成 memories_to_add 或 important_excerpts。至少需要 2 条消息共同支撑。",
            "- 当旧记忆和新信息冲突时，优先更新或删除旧记忆，不要并排留下互相打架的版本。",
            "- 当新信息只是旧记忆的更准确版本，优先 memories_to_update，不要 memories_to_add。",
            "- 当多条旧记忆重复，保留更完整的一条并删除重复项；必要时先 update 保留项。",
            "- pinned=true 的旧记忆不能删除，只能在 memories_to_update 中提出更保守的补充。",
            "- type=diary 或 type=layla_diary 的旧记忆是原始日记，永远不要 memories_to_update 它们的 content——日记是原始证据不能改写。如果日记里的状态过时了，新建一条带 fact_key 的状态记忆，让以后的 Z 审计处理。",
            "- 长期记忆一律使用明确的第三人称主体，不使用含混的“我”“你”“她”。",
            "- 用户的事实、偏好、决定写成“用户（Layla）……”。KLD 的承诺、行为和需要记住的事项写成“KLD……”。",
            "- transcript 中“对话助手(KLD)”说出的建议、猜测、复述或推断，不得升级成用户事实；只有用户明确表达或明确确认的信息才能写成用户事实。",
            "- Dream 整理器自身不进入记忆正文，不把整理过程写成任何一方的经历或承诺。",
            "- 不要提到 D1、Vectorize、RAG、数据库、记忆系统、代理层等实现细节。",
            "",
            "Dream 输出格式：",
            "- title 是 12 字以内标题。",
            "- summary 写成一段简短自然中文，描述这次 dream 整理出了什么。",
            "- sections 最多 3 段，每段有 heading 和 content；没有必要可以给空数组。",
            f"- important_excerpts 最多 {EXCERPT_LIMIT} 条，quote 必须是值得保留的原文片段；每条还必须给 durable_claim，用明确第三人称说明这段原话未来证明什么稳定偏好、边界、承诺或关系事实。",
            "- memories_to_add 最多 12 条，每条要短、稳定、可复用。",
            "- memories_to_update 只针对给出的旧记忆 id。",
            "- memories_to_delete 只删除空、重复、明显过期或被新信息否定的旧记忆。",
            "- relations_to_add 最多 12 条，只能连接旧长期记忆候选里已经存在的 id；不要连接本次新建记忆，因为新建记忆还没有 id。",
            "- relations_to_add 的 relation_type 只能是 safe 类型：same_issue, same_project, same_tool, same_event, same_topic, temporal_sequence, emotional_link, in_thread, same_person, in_episode, instance_of, derived_from, same_fact_key, origin_split。",
            "- 不要自动输出 contradicts/supports/cause_effect；这类需要人工审核，不属于 relations_to_add。",
            "- memories_to_add 可以附带 LMC-5 坐标：fact_key 是稳定事实槽，thread 是主题线，risk_level 只能 low/normal/medium/high，urgency_level 只能 low/normal/medium/high，tension_score 是 0-1，response_posture 是未来回应姿态。",
            "- fact_key 不确定就输出 null，不要为了分类硬编事实槽。",
            "- 当输入是 chunk 时，每条新增、更新、删除和重要原文都要输出 source_chunk_ids，只能引用输入中的 chunk id。",
            "- memories_to_add 和 important_excerpts 必须各自引用至少 2 个不同的 source_message_ids，且每个消息 id 必须落在所引 chunk 的消息范围内；不能用一个包含很多消息的 chunk 冒充多消息证据。",
            "- 每个候选（新增、更新、删除、重要原文、关系）都必须输出 evidence 和 source_chunk_ids。evidence 必须是所引用 chunk 的关键原话中的逐字片段，最多 80 字；不能用摘要、推断或改写冒充证据。",
            "- memories_to_add 和 memories_to_update 的 content 至少包含 30 个中文字符；不足时不要输出。",
            "- relation 的 source_memory_id 和 target_memory_id 不得相同。没有可靠候选时，输出空数组是合法结果。",
            "- memories_to_add 和 memories_to_update 必须输出 subject，且只能是 user、kld、relationship、project、external。",
            "- subject=user 的 content 必须以“用户（Layla）”为明确主体；subject=kld 必须以“KLD”为明确主体。",
            "- subject=relationship 必须明确写出“用户（Layla）”和“KLD”；不得用“我、你、她”代替主体。",
            "- 控制总输出长度，宁可少写也不要输出超长 JSON。",
            "",
            "输出 JSON 结构：",
            json.dumps(
                {
                    "date": date_label,
                    "title": "夜间整理",
                    "summary": "这次 dream 合并了重复记忆，更新了项目状态，并保留了关键原文。",
                    "sections": [{"heading": "整理结果", "content": "……"}],
                    "important_excerpts": [{"quote": "用户或 KLD 说过的关键原文", "durable_claim": "用户（Layla）的稳定边界或关系事实", "reason": "为什么值得保留", "tags": ["project"], "source_message_ids": ["1", "2"], "source_chunk_ids": [1]}],
                    "memories_to_add": [
                        {
                            "type": "project",
                            "subject": "user",
                            "content": "用户（Layla）正在简化 KLD 的记忆写入策略。",
                            "importance": 0.86,
                            "confidence": 0.92,
                            "tags": ["project", "kld"],
                            "fact_key": "project:kld_memory_strategy",
                            "thread": "kld",
                            "risk_level": "normal",
                            "urgency_level": "normal",
                            "tension_score": 0.2,
                            "response_posture": "技术讨论中直接推进，优先保持现有功能兼容",
                            "evidence": "用户正在简化 KLD 的记忆写入策略",
                            "source_message_ids": ["1", "2"],
                            "source_chunk_ids": [1],
                        }
                    ],
                    "memories_to_update": [{"target_id": "mem_x", "subject": "project", "content": "KLD 记忆项目的写入策略已更新。", "type": "project", "importance": 0.88, "tags": ["project"]}],
                    "memories_to_delete": [{"target_id": "mem_y", "reason": "空内容或重复"}],
                    "relations_to_add": [{"source_memory_id": "mem_a", "target_memory_id": "mem_b", "relation_type": "same_topic", "strength": 0.82, "reason": "两条记忆都在描述同一个项目策略"}],
                },
                ensure_ascii=False,
            ),
            "",
            "旧长期记忆候选：",
            json.dumps(existing, ensure_ascii=False, indent=2) if existing else "[]",
            "",
            "今日原始聊天：",
            format_chunks(chunks) if chunks is not None else format_transcript(messages),
        ]
    )


def candidate_identity(group: str, item: dict) -> tuple[str, ...]:
    if group == "memories_to_add":
        return (clean_str(item.get("content")) or "",)
    if group in {"memories_to_update", "memories_to_delete"}:
        return (clean_str(item.get("target_id")) or "",)
    if group == "important_excerpts":
        return (clean_str(item.get("quote")) or "",)
    if group == "relations_to_add":
        return (
            clean_str(item.get("source_memory_id") or item.get("source_id") or item.get("source")) or "",
            clean_str(item.get("target_memory_id") or item.get("target_id") or item.get("target")) or "",
            clean_str(item.get("relation_type") or item.get("type") or item.get("relation")) or "",
        )
    return ()


def restore_candidate_provenance(raw_plan: dict, plan: dict) -> dict:
    groups = (
        "memories_to_add",
        "memories_to_update",
        "memories_to_delete",
        "important_excerpts",
        "relations_to_add",
    )
    for group in groups:
        raw_buckets: dict[tuple[str, ...], list[dict]] = {}
        for item in raw_plan.get(group) or []:
            if isinstance(item, dict):
                raw_buckets.setdefault(candidate_identity(group, item), []).append(item)
        for normalized in plan.get(group) or []:
            bucket = raw_buckets.get(candidate_identity(group, normalized)) or []
            if not bucket:
                continue
            source = bucket.pop(0)
            for field in ("subject", "evidence", "durable_claim", "source_message_ids", "source_chunk_ids"):
                value = source.get(field)
                if field in {"source_message_ids", "source_chunk_ids"}:
                    if isinstance(value, list):
                        normalized[field] = list(value)
                else:
                    cleaned = clean_str(value)
                    if cleaned:
                        normalized[field] = cleaned
    return plan


def candidate_status(action: str, payload: dict) -> tuple[str, str | None]:
    if action not in {"add", "update"}:
        return "pending", None
    subject = clean_str(payload.get("subject"))
    content = clean_str(payload.get("content")) or ""
    if subject not in VALID_SUBJECTS:
        return "needs_subject_review", "missing_or_invalid_subject"
    if AMBIGUOUS_SUBJECT_RE.search(content):
        return "needs_subject_review", "ambiguous_pronoun"
    if subject == "user" and not content.startswith("用户（Layla）"):
        return "needs_subject_review", "user_subject_prefix_mismatch"
    if subject == "kld" and not content.startswith("KLD"):
        return "needs_subject_review", "kld_subject_prefix_mismatch"
    if subject == "relationship" and not ("用户（Layla）" in content and "KLD" in content):
        return "needs_subject_review", "relationship_subjects_missing"
    return "pending", None


def chinese_char_count(value: Any) -> int:
    return len(re.findall(r"[\u3400-\u4dbf\u4e00-\u9fff]", clean_str(value) or ""))


def evidence_text(action: str, payload: dict) -> str:
    value = payload.get("evidence")
    if not value and action == "excerpt":
        value = payload.get("quote")
    return str(value or "").strip()


def evidence_validation_error(
    action: str,
    payload: dict,
    source_chunk_ids: list[int],
    chunks_by_id: dict[int, dict],
) -> str | None:
    if not source_chunk_ids:
        return "missing_or_invalid_source_chunk_ids"
    evidence = evidence_text(action, payload)
    if not evidence:
        return "missing_evidence"
    if len(evidence) > MAX_EVIDENCE_CHARS:
        return "evidence_too_long"
    quotes = [
        str(quote)
        for chunk_id in source_chunk_ids
        for quote in (chunks_by_id[chunk_id].get("important_quotes") or [])
        if isinstance(quote, str)
    ]
    if not any(evidence in quote for quote in quotes):
        return "evidence_not_verbatim_in_source_chunks"
    return None


def valid_source_message_ids(payload: dict, source_chunk_ids: list[int], chunks_by_id: dict[int, dict]) -> list[str]:
    ranges = []
    for chunk_id in source_chunk_ids:
        chunk = chunks_by_id[chunk_id]
        try:
            ranges.append((int(chunk["start_message_id"]), int(chunk["end_message_id"])))
        except (KeyError, TypeError, ValueError):
            continue
    valid = []
    for value in payload.get("source_message_ids") or []:
        try:
            message_id = int(str(value))
        except (TypeError, ValueError):
            continue
        if any(start <= message_id <= end for start, end in ranges):
            valid.append(str(message_id))
    return sorted(set(valid), key=int)


def persist_candidates(db, date_label: str, plan: dict, chunks: list[dict]) -> dict:
    now = iso_utc(datetime.now(timezone.utc))
    chunks_by_id = {int(chunk["id"]): chunk for chunk in chunks}
    allowed_chunk_ids = set(chunks_by_id)
    entries: list[tuple[str, dict]] = []
    entries.extend(("add", item) for item in plan.get("memories_to_add", []))
    entries.extend(("update", item) for item in plan.get("memories_to_update", []))
    entries.extend(("delete", item) for item in plan.get("memories_to_delete", []))
    entries.extend(("excerpt", item) for item in plan.get("important_excerpts", [])[:EXCERPT_LIMIT])
    entries.extend(("relation", item) for item in plan.get("relations_to_add", [])[:12])
    created = 0
    skipped = 0
    dropped = 0
    statuses: dict[str, int] = {}
    drop_reasons: dict[str, int] = {}
    for action, payload in entries:
        if action in {"add", "update"} and chinese_char_count(payload.get("content")) < MIN_MEMORY_CHINESE_CHARS:
            reason = "content_too_short"
            dropped += 1
            drop_reasons[reason] = drop_reasons.get(reason, 0) + 1
            continue
        if action == "relation" and clean_str(payload.get("source_memory_id")) == clean_str(payload.get("target_memory_id")):
            reason = "relation_self_loop"
            dropped += 1
            drop_reasons[reason] = drop_reasons.get(reason, 0) + 1
            continue
        source_chunk_ids = [
            int(value)
            for value in (payload.get("source_chunk_ids") or [])
            if str(value).isdigit() and int(value) in allowed_chunk_ids
        ]
        source_chunk_ids = sorted(set(source_chunk_ids))
        source_message_ids = valid_source_message_ids(payload, source_chunk_ids, chunks_by_id)
        if action in {"add", "excerpt"} and len(source_message_ids) < 2:
            reason = "single_message_not_durable"
            dropped += 1
            drop_reasons[reason] = drop_reasons.get(reason, 0) + 1
            continue
        safe_payload = dict(payload)
        safe_payload["source_chunk_ids"] = source_chunk_ids
        safe_payload["source_message_ids"] = source_message_ids
        if action == "excerpt" and not clean_str(safe_payload.get("durable_claim")):
            reason = "missing_durable_claim"
            dropped += 1
            drop_reasons[reason] = drop_reasons.get(reason, 0) + 1
            continue
        evidence = evidence_text(action, safe_payload)
        if evidence:
            safe_payload["evidence"] = evidence
        status, subject_error = candidate_status(action, safe_payload)
        validation_errors = []
        if subject_error:
            safe_payload["subject_validation_error"] = subject_error
            validation_errors.append(subject_error)
        evidence_error = evidence_validation_error(action, safe_payload, source_chunk_ids, chunks_by_id)
        if evidence_error:
            status = "needs_subject_review"
            validation_errors.append(evidence_error)
        if validation_errors:
            safe_payload["validation_error"] = ";".join(validation_errors)
        subject = clean_str(safe_payload.get("subject"))
        target_id = clean_str(payload.get("target_id"))
        canonical = json.dumps(
            {"date": date_label, "action": action, "target_id": target_id, "payload": safe_payload},
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        )
        candidate_key = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
        cursor = db.execute(
            """
            INSERT OR IGNORE INTO memory_candidates
              (candidate_key, dream_date, action, subject, target_id, payload_json,
               source_chunk_ids_json, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                candidate_key,
                date_label,
                action,
                subject,
                target_id,
                json.dumps(safe_payload, ensure_ascii=False, sort_keys=True),
                json.dumps(source_chunk_ids, ensure_ascii=False),
                status,
                now,
                now,
            ),
        )
        if cursor.rowcount:
            created += 1
            statuses[status] = statuses.get(status, 0) + 1
        else:
            skipped += 1
    db.commit()
    return {
        "created": created,
        "deduplicated": skipped,
        "dropped": dropped,
        "total": len(entries),
        "statuses": statuses,
        "drop_reasons": drop_reasons,
    }


def candidate_cursor_name(date_label: str) -> str:
    return f"dream-candidates:{NAMESPACE}:{date_label}"


def read_candidate_cursor(db, date_label: str) -> int:
    row = db.execute(
        "SELECT last_message_id FROM recall_cursor WHERE name = ?",
        (candidate_cursor_name(date_label),),
    ).fetchone()
    return int(row[0] or 0) if row else 0


def write_candidate_cursor(db, date_label: str, chunk_id: int) -> None:
    now = iso_utc(datetime.now(timezone.utc))
    db.execute(
        """
        INSERT INTO recall_cursor (name, last_message_id, last_created_at, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(name) DO UPDATE SET
          last_message_id=excluded.last_message_id,
          last_created_at=excluded.last_created_at,
          updated_at=excluded.updated_at
        """,
        (candidate_cursor_name(date_label), chunk_id, f"chunk:{chunk_id}", now),
    )
    db.commit()


def run_candidate_dream(date_label: str, force: bool) -> dict:
    load_env()
    db = connect_db()
    ensure_candidate_table(db)
    start_iso, end_iso = date_range(date_label)
    after_id = 0 if force else read_candidate_cursor(db, date_label)
    existing = fetch_existing_memories()
    batches = []
    while True:
        chunks, has_more = load_date_chunks(db, start_iso, end_iso, after_id)
        if not chunks:
            break
        prompt = build_prompt(date_label, start_iso, end_iso, [], existing, has_more, chunks=chunks)
        response, raw_plan = chat_json(
            [{"role": "system", "content": "你是严格的 JSON 生成器。你只输出 JSON，不要输出思考过程。"}, {"role": "user", "content": prompt}],
            max_tokens=max(MAX_TOKENS, 5000),
            temperature=0,
        )
        plan = restore_candidate_provenance(raw_plan, normalize_plan(raw_plan))
        persisted = persist_candidates(db, date_label, plan, chunks)
        after_id = int(chunks[-1]["id"])
        write_candidate_cursor(db, date_label, after_id)
        batches.append(
            {
                "first_chunk_id": chunks[0]["id"],
                "last_chunk_id": chunks[-1]["id"],
                "chunk_count": len(chunks),
                "candidates": persisted,
                "model": response["model"],
                "usage": response["usage"],
            }
        )
        if not has_more:
            break
    result = {
        "ran": bool(batches),
        "mode": "candidate-only",
        "date": date_label,
        "batches": batches,
        "candidate_count": sum(batch["candidates"]["created"] for batch in batches),
        "last_chunk_id": after_id,
    }
    append_log(result)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description="kld local Dream — nightly memory consolidation writing back to the Worker.")
    parser.add_argument("--date", default=None, help="Date label YYYY-MM-DD (default: yesterday Asia/Singapore).")
    parser.add_argument("--apply", action="store_true", help="Apply the plan to the Worker (default: dry-run, print only).")
    parser.add_argument("--force", action="store_true", help="Re-run even if cursor says already done.")
    parser.add_argument("--candidate-only", action="store_true", help="Read local recall_chunks and store local pending candidates; never write Worker memories.")
    args = parser.parse_args()
    label = args.date or yesterday_label()
    if args.candidate_only:
        run_candidate_dream(label, force=args.force)
        return
    run_dream(label, apply=args.apply, force=args.force)


if __name__ == "__main__":
    main()
