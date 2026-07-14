import { callOpenAICompat } from "../../proxy/openaiAdapter";
import type { Env, MemoryRecord, OpenAIChatRequest, OpenAIChatResponse } from "../../types";
import { extractJsonObject } from "../../utils/jsonHelpers";
import type { CoordinateLabeler } from "../../memory/coordinateBackfill";

type BackfillUpdate = Record<string, unknown> & { id: string };

function readAssistantText(response: OpenAIChatResponse): string {
  const content = (response.choices?.[0]?.message as { content?: unknown } | undefined)?.content;
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
      ? String((part as { text: string }).text)
      : "")
    .join("")
    .trim();
}

function buildBackfillPrompt(memories: MemoryRecord[]): string {
  const items = memories.map((memory) => ({
    id: memory.id,
    type: memory.type,
    content: memory.content.slice(0, 300),
    tags: memory.tags,
    existing_coordinates: {
      thread: memory.thread,
      risk_level: memory.risk_level,
      urgency_level: memory.urgency_level,
      tension_score: memory.tension_score,
      response_posture: memory.response_posture,
      valence: memory.valence,
      arousal: memory.arousal
    }
  }));
  return [
    "Return a complete coordinate proposal for every memory. Existing non-null coordinates are context and must remain semantically consistent.",
    "risk_level and urgency_level must always be low, normal, medium, or high.",
    "tension_score and arousal must always be numbers from 0 to 1; use 0 for neutral.",
    "valence must always be a number from -1 to 1; use 0 for neutral.",
    "response_posture must always be one short actionable sentence. thread may be null only when no stable topic exists.",
    "你是记忆坐标标注器。给每条记忆补上 LMC-5 坐标。",
    "只输出 JSON，不要 markdown，不要解释。",
    "",
    "坐标说明：",
    "- fact_key: 始终输出 null；旧记忆事实槽由独立的 Z 轴归并任务处理。",
    "- thread: 主题线，如 kld、relationship.boundaries、safety。不确定就 null。",
    "- risk_level: low/normal/medium/high",
    "- urgency_level: low/normal/medium/high",
    "- tension_score: 0-1，有过张力/冲突 >0.5",
    "- valence: -1 到 1，正=愉悦，负=难受",
    "- arousal: 0-1，越高越激动",
    "- response_posture: 未来回应姿态，简短一句",
    "",
    "输出格式：",
    JSON.stringify({
      updates: [
        {
          id: "mem_x",
          fact_key: "project:kld",
          thread: "kld",
          risk_level: "normal",
          urgency_level: "normal",
          tension_score: 0,
          valence: 0,
          arousal: 0,
          response_posture: "保持简洁、事实性的回应"
        }
      ]
    }),
    "",
    "记忆列表：",
    JSON.stringify(items)
  ].join("\n");
}

export const labelCoordinateBatch: CoordinateLabeler = async (
  env: Env,
  model: string,
  memories: MemoryRecord[]
): Promise<BackfillUpdate[]> => {
  const basePrompt = buildBackfillPrompt(memories);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const request: OpenAIChatRequest = {
      model,
      messages: [
        { role: "system", content: "你是严格的 JSON 生成器。只输出一个完整 JSON 对象，不要 markdown。" },
        {
          role: "user",
          content: attempt === 0
            ? basePrompt
            : `${basePrompt}\n\n上次输出无法解析。请缩短字段内容，并确保 JSON 完整闭合。`
        }
      ],
      temperature: 0,
      max_tokens: 3000,
      response_format: { type: "json_object" },
      stream: false
    };

    const response = await callOpenAICompat(env, request);
    if (!response.ok) {
      if (attempt === 0 && response.status >= 500) continue;
      throw new Error(`model_status_${response.status}`);
    }

    const parsed = (await response.json()) as OpenAIChatResponse;
    const jsonResult = extractJsonObject(readAssistantText(parsed));
    const updates = jsonResult && typeof jsonResult === "object"
      ? (jsonResult as { updates?: unknown }).updates
      : null;
    if (!Array.isArray(updates)) continue;

    return updates.filter((item): item is BackfillUpdate => Boolean(
      item && typeof item === "object" && typeof (item as { id?: unknown }).id === "string"
    ));
  }

  throw new Error("invalid_model_json_after_retry");
};
