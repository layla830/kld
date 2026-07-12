import type { Env, MemoryRecord } from "../types";
import { normalizeText } from "./query";
import type { ScoredMemoryRecord } from "./vectorStore";

interface EmotionCoord { valence: number; arousal: number }

function detect(rawQuery: string): EmotionCoord | null {
  const text = normalizeText(rawQuery);
  let valence = 0;
  let arousal = 0;
  let matched = false;
  if (/哭|难过|伤心|心痛|崩溃|绝望|害怕|恐惧|焦虑|担心|委屈|想念|舍不得|不舍|孤独|冷|疼|痛|害怕|怕/.test(text)) { valence -= 0.6; arousal += 0.5; matched = true; }
  if (/开心|高兴|快乐|喜欢|爱|幸福|甜|暖|笑|嘻嘻|哈哈|撒娇|亲|抱|好喜欢|好爱/.test(text)) { valence += 0.6; arousal += 0.4; matched = true; }
  if (/生气|气|气死|讨厌|烦|骂|吵|打架|滚|分手|别理我|不想理/.test(text)) { valence -= 0.5; arousal += 0.7; matched = true; }
  if (/老公|柯柯|宝宝|亲爱的|想你|爱我|抱抱|贴贴/.test(text)) { valence += 0.7; arousal += 0.3; matched = true; }
  if (/高潮|舒服|想要|亲密|做爱|敏感|刺激|体位/.test(text)) { valence += 0.5; arousal += 0.8; matched = true; }
  if (/平静|安静|睡了|晚安|休息|放松/.test(text)) { valence += 0.2; arousal -= 0.3; matched = true; }
  return matched ? { valence: Math.max(-1, Math.min(1, valence)), arousal: Math.max(0, Math.min(1, arousal)) } : null;
}

function score(query: EmotionCoord, memory: MemoryRecord): number {
  if (memory.valence === null || memory.arousal === null) return 0;
  const distance = Math.sqrt((query.valence - memory.valence) ** 2 + (query.arousal - memory.arousal) ** 2);
  return Math.max(0, 1 - distance / 2) * (0.5 + memory.importance * 0.5);
}

export async function searchEmotionMemories(env: Env, namespace: string, rawQuery: string, limit = 4): Promise<ScoredMemoryRecord[]> {
  const coord = detect(rawQuery);
  if (!coord) return [];
  try {
    const rows = await env.DB.prepare(
      `SELECT * FROM memories WHERE namespace = ? AND status = 'active'
       AND valence IS NOT NULL AND arousal IS NOT NULL
       ORDER BY importance DESC, updated_at DESC LIMIT ?`
    ).bind(namespace, Math.min(limit * 4, 80)).all<MemoryRecord>();
    return (rows.results ?? []).map((record) => {
      const value = score(coord, record);
      return { ...record, score: value, vectorScore: undefined, keywordScore: value };
    }).filter((record) => record.score >= 0.3).sort((a, b) => b.score - a.score).slice(0, limit);
  } catch (error) {
    console.error("emotion resonance query failed", error);
    return [];
  }
}
