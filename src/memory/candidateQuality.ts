import type { MemoryCandidateRecord } from "../db/memoryCandidates";
import { proposalFromCandidate } from "../domain/memoryProposal";

export type CandidateQualityLabel = "pass" | "needs_review" | "reject_suggested";

export interface CandidateQualityAssessment {
  label: CandidateQualityLabel;
  flags: string[];
  reasons: string[];
}

const PIPELINE_SCAFFOLD_RE = /event chunk|hippocampus observation|observation from event chunk|event_chunks\.id|source_chunk_ids|tool_use|tool_result|hook_success|traceback|stack trace/i;
const INTERRUPTION_NOISE_RE = /no response requested|request interrupted by user|用户中断请求|无需回复/i;
const SENTENCE_BOUNDARY_RE = /[。！？!?；;]/g;
const LIST_ITEM_RE = /(?:^|\n)\s*(?:\d+[.)、]|[一二三四五六七八九十]+[、.])/g;

function compact(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function visibleLength(value: string): number {
  return value.replace(/\s+/g, "").length;
}

export function assessCandidateQuality(candidate: MemoryCandidateRecord): CandidateQualityAssessment {
  if (["relation", "timeline_date", "m_archive", "m_relation_cleanup", "fact_group"].includes(candidate.action)) {
    return { label: "pass", flags: [], reasons: [] };
  }

  const proposal = proposalFromCandidate(candidate);
  const payload = proposal.payload;
  const content = compact(candidate.action === "excerpt" ? payload.quote : payload.content);
  const evidence = compact(payload.evidence);
  const combined = [content, evidence].filter(Boolean).join("\n");
  const flags: string[] = [];
  const reasons: string[] = [];

  if (!content) {
    flags.push("missing_content");
    reasons.push("候选没有可独立审核的正文");
  }
  if (PIPELINE_SCAFFOLD_RE.test(combined)) {
    flags.push("pipeline_scaffold");
    reasons.push("正文混入了 chunk、hook 或工具管线文字");
  }
  if (INTERRUPTION_NOISE_RE.test(combined)) {
    flags.push("interaction_noise");
    reasons.push("正文是中断或无需回复之类的交互噪音");
  }
  if (content.length > 520) {
    flags.push("too_coarse");
    reasons.push("正文超过 520 字，像一段摘要而不是单条记忆");
  }
  if ((content.match(SENTENCE_BOUNDARY_RE) ?? []).length >= 5 || (content.match(LIST_ITEM_RE) ?? []).length >= 4) {
    flags.push("multi_fact");
    reasons.push("正文包含太多句子或列表项，可能需要拆成多个事实");
  }
  if (proposal.evidence.chunkIds.length > 1) {
    flags.push("multi_chunk");
    reasons.push("候选跨越多个来源 chunk，需要确认是否过粗");
  }

  const length = visibleLength(content);
  if (candidate.action === "excerpt" && length > 0 && length < 8) {
    flags.push("contextless_excerpt");
    reasons.push("原话太短，脱离上下文后很难独立召回");
  } else if (["add", "update", "diary_split_fact"].includes(candidate.action) && length > 0 && length < 24) {
    flags.push("too_thin");
    reasons.push("正文过短，尚不足以成为可独立使用的长期记忆");
  }

  if (candidate.action === "excerpt") {
    const durableClaim = compact(payload.durable_claim);
    const sourceMessageIds = Array.isArray(payload.source_message_ids)
      ? [...new Set(payload.source_message_ids.map(String).filter(Boolean))]
      : [];
    if (!durableClaim) {
      flags.push("missing_durable_claim");
      reasons.push("原话没有说明未来可复用的稳定偏好、边界、承诺或关系事实");
    }
    if (sourceMessageIds.length < 2) {
      flags.push("single_message_support");
      reasons.push("原话只有一条消息证据，缺少上下文共同支撑");
    }
  }

  const rejectFlags = new Set(["missing_content", "pipeline_scaffold", "interaction_noise", "contextless_excerpt", "missing_durable_claim", "single_message_support"]);
  const label: CandidateQualityLabel = flags.some((flag) => rejectFlags.has(flag))
    ? "reject_suggested"
    : flags.length > 0 ? "needs_review" : "pass";
  return { label, flags: [...new Set(flags)], reasons: [...new Set(reasons)] };
}
