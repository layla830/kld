#!/usr/bin/env python3
"""Route recall requests by evidence ownership, not by token-hit count.

VPS local history owns recent conversation and explicit verbatim-evidence asks.
The Worker owns curated long-term facts, dated timelines, relationships, rules,
preferences, and response posture.
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Any

from local_recall_text import tokens
from local_recall_time import TimeIntent, time_intent

MEMORY_SIGNAL_RE = re.compile(
    r"记得|还记|想起|回忆|忘了|之前|以前|过去|上次|那次|那天|当时|后来|说过|聊过|提过|写过|存过|"
    r"remember|recall|forgot|previous|last\s+(?:time|night|week)|as we discussed|mentioned before",
    re.I,
)
STATUS_QUESTION_RE = re.compile(
    r"现在.{0,8}(?:什么状态|怎么样|进度)|(?:什么状态|怎么样了|进度如何|进展如何|怎么回事)|"
    r"(?:是谁|谁在|谁来|谁负责|谁整理)|(?:完成|做完|拿回|取回|解决|处理|弄好|写完).{0,8}(?:了吗|没有|没)|"
    r"(?:还在|还有|还要|是否|是不是).{0,12}(?:吗|呢|么)$",
    re.I,
)
RAW_EVIDENCE_RE = re.compile(r"原话|逐字|一字不差|原文|聊天记录|当时怎么说|刚才说了什么|verbatim|exact\s+(?:words|quote)", re.I)
DURABLE_QUESTION_RE = re.compile(
    r"(?:平时|一直|总是|以后|应该|喜欢|不喜欢|偏好|习惯|规则|底线|约定|承诺).{0,24}(?:什么|哪|谁|为什么|怎么|是否|是不是)|"
    r"(?:是谁|谁来|谁负责).{0,16}(?:提|说|做|处理|决定)",
    re.I,
)
TRIVIAL_RE = re.compile(r"^\s*(?:hi|hello|hey|你好|嗨|在吗|嗯|哦|好|好的|行|可以|继续|谢谢|辛苦|ok|test|测试)\s*[。.!！?？]*\s*$", re.I)


@dataclass(frozen=True)
class RecallDecision:
    prompt: str
    intent: TimeIntent
    should_recall: bool
    use_local: bool
    use_remote: bool
    reason: str


def prompt_from_input(raw: str) -> str:
    try:
        data: Any = json.loads(raw)
    except json.JSONDecodeError:
        return raw.strip()
    if not isinstance(data, dict):
        return ""
    for key in ("prompt", "message", "input", "user_prompt", "content"):
        value = data.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return ""


def is_heartbeat(prompt: str) -> bool:
    first = next((line.strip() for line in prompt.splitlines() if line.strip()), "")
    return bool(re.fullmatch(r"# Heartbeat|STATE_EOF", first))


def decide_recall(prompt: str, *, force: bool = False) -> RecallDecision:
    prompt = prompt.strip()
    intent = time_intent(prompt)
    if not prompt or is_heartbeat(prompt) or TRIVIAL_RE.fullmatch(prompt):
        return RecallDecision(prompt, intent, False, False, False, "ignored")

    if force:
        return RecallDecision(prompt, intent, True, True, False, "forced")

    meaningful = tokens(prompt)
    memory_signal = bool(MEMORY_SIGNAL_RE.search(prompt))
    raw_evidence = bool(RAW_EVIDENCE_RE.search(prompt))
    status_question = len(meaningful) >= 2 and bool(STATUS_QUESTION_RE.search(prompt))
    durable_question = bool(DURABLE_QUESTION_RE.search(prompt))

    # Explicit raw evidence and recent conversational continuity are the only
    # synchronous local-recall jobs. Historical dates belong to the Worker's
    # curated timeline; this prevents a weak local LIKE hit from suppressing it.
    if raw_evidence or intent.mode == "recent":
        reason = "raw_evidence" if raw_evidence else "recent"
        return RecallDecision(prompt, intent, True, True, False, reason)

    if intent.mode == "hard":
        return RecallDecision(prompt, intent, True, False, True, "dated_timeline")

    if memory_signal or status_question or durable_question:
        reason = "memory" if memory_signal else "status" if status_question else "durable_question"
        return RecallDecision(prompt, intent, True, False, True, reason)

    return RecallDecision(prompt, intent, False, False, False, "no_signal")
