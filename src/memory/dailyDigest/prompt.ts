import type { MemoryApiRecord, MessageRecord } from "../../types";
import { truncate } from "./parser";

export function formatTranscript(messages: MessageRecord[]): string {
  return messages
    .map((message) => {
      const role = message.role === "assistant" ? "我(助手)" : "用户";
      return `[${message.id}][${message.created_at}][${role}] ${truncate(message.content.trim(), 700)}`;
    })
    .join("\n\n");
}

export function formatExistingMemories(memories: MemoryApiRecord[]): string {
  if (memories.length === 0) return "[]";
  return JSON.stringify(
    memories.map((memory) => ({
      id: memory.id,
      type: memory.type,
      content: truncate(memory.content, 260),
      importance: memory.importance,
      confidence: memory.confidence,
      pinned: memory.pinned,
      tags: memory.tags,
      fact_key: memory.fact_key,
      thread: memory.thread,
      risk_level: memory.risk_level,
      urgency_level: memory.urgency_level,
      tension_score: memory.tension_score,
      response_posture: memory.response_posture
    })),
    null,
    2
  );
}

export function buildDigestPrompt(input: {
  dateLabel: string;
  startIso: string;
  endIso: string;
  messages: MessageRecord[];
  existingMemories: MemoryApiRecord[];
  excerptLimit: number;
  hasMore: boolean;
}): string {
  return [
    "你是 kld 的 nightly dream 记忆整理器。你的任务不是简单总结，而是在她休息时整理长期记忆。",
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
    `- 你只能处理 ${input.dateLabel} 这一天窗口内的聊天。窗口是 ${input.startIso} 到 ${input.endIso}。`,
    input.hasMore ? "- 这是当天的一批聊天，不是完整一天；只整理这一批里明确出现的信息。" : "- 这是当天最后一批或完整批次。",
    "",
    "总原则：",
    "- 原始聊天不要逐条变成记忆，只保留未来真的会用到的事实、偏好、边界、项目进展、承诺。",
    "- 宁可少记，也不要把临时语气、寒暄、重复话、空内容、调试内容写进长期记忆。",
    "- 只在单条消息里出现一次、没有第二条独立消息确认或延续的信息，不写入 important_excerpts 或 memories_to_add；source_message_ids 必须至少包含 2 个不同消息 id。",
    "- 当旧记忆和新信息冲突时，优先更新或删除旧记忆，不要并排留下互相打架的版本。",
    "- 当新信息只是旧记忆的更准确版本，优先 memories_to_update，不要 memories_to_add。",
    "- 当多条旧记忆重复，保留更完整的一条并删除重复项；必要时先 update 保留项。",
    "- pinned=true 的旧记忆不能删除，只能在 memories_to_update 中提出更保守的补充。",
    "- 使用明确的第三人称主体：用户事实写‘用户（Layla）’，助手承诺写‘KLD需要……’。",
    "- 不使用含混的‘我、你、她’，不要把助手建议、猜测或复述升级成用户事实。",
    "- 不要提到 D1、Vectorize、RAG、数据库、记忆系统、代理层等实现细节。",
    "",
    "Dream 输出格式：",
    "- title 是 12 字以内标题。",
    "- summary 写成一段简短自然中文，描述这次 dream 整理出了什么。",
    "- sections 最多 3 段，每段有 heading 和 content；没有必要可以给空数组。",
    `- important_excerpts 最多 ${input.excerptLimit} 条，quote 必须是值得保留的原文片段。`,
    "- memories_to_add 最多 8 条，每条要短、稳定、可复用。",
    "- memories_to_update 只针对给出的旧记忆 id。",
    "- memories_to_delete 只删除空、重复、明显过期或被新信息否定的旧记忆。",
    "- memories_to_add 可以附带 LMC-5 坐标：fact_key 是稳定事实槽，thread 是主题线，risk_level 只能 low/normal/medium/high，urgency_level 只能 low/normal/medium/high，tension_score 是 0-1，valence 是 -1 到 1（正=愉悦，负=难受），arousal 是 0-1（越高越激动），response_posture 是未来回应姿态。",
    "- fact_key 不确定就输出 null，不要为了分类硬编事实槽。",
    "- valence/arousal 不确定就输出 null，不要硬猜情绪。",
    "- 控制总输出长度，宁可少写也不要输出超长 JSON。",
    "",
    "relation_hints 是新记忆之间或新记忆与旧记忆之间的关系建议：",
    "- source_id 和 target_id 可以是新 memories_to_add 里暂时用 placeholder（如 add_0, add_1），也可以是旧记忆的 mem_x id。",
    "- relation_type 只能用：same_topic, same_event, emotional_link, derived_from（safe 类，可直接建边）；或 contradicts, cause_effect, supports（review 类，需人工审）。时间先后关系由 X 时间轴维护，不要输出 temporal_sequence。",
    "- 不确定关系就给空数组，不要硬编关系。",
    "",
    "输出 JSON 结构：",
    JSON.stringify({
      date: input.dateLabel,
      title: "夜间整理",
      summary: "这次 dream 合并了重复记忆，更新了项目状态，并保留了关键原文。",
      sections: [{ heading: "整理结果", content: "……" }],
      important_excerpts: [
        {
          quote: "她或助手说过的关键原文",
          reason: "为什么值得保留",
          tags: ["project"],
          source_message_ids: ["msg_x"]
        }
      ],
      memories_to_add: [
        {
          type: "project",
          content: "你正在简化 kld 的记忆写入策略。",
          importance: 0.86,
          confidence: 0.92,
          tags: ["project", "kld"],
          fact_key: "project:kld_memory_strategy",
          thread: "kld",
          risk_level: "normal",
          urgency_level: "normal",
          tension_score: 0.2,
          valence: null,
          arousal: null,
          response_posture: "技术讨论中直接推进，优先保持现有功能兼容",
          source_message_ids: ["msg_x"]
        }
      ],
      memories_to_update: [
        {
          target_id: "mem_x",
          content: "更新后的旧记忆正文",
          type: "project",
          importance: 0.88,
          confidence: 0.9,
          tags: ["project"]
        }
      ],
      memories_to_delete: [{ target_id: "mem_y", reason: "空内容或重复" }],
      relation_hints: [
        { source_id: "add_0", target_id: "mem_z", relation_type: "same_topic", strength: 0.6, reason: "都是关于kld项目" }
      ]
    }),
    "",
    "旧长期记忆候选：",
    formatExistingMemories(input.existingMemories),
    "",
    "今日原始聊天：",
    formatTranscript(input.messages)
  ].join("\n");
}
