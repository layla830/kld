import { upsertMemoryCandidate } from "../db/memoryCandidates";
import { callOpenAICompat } from "../proxy/openaiAdapter";
import type { Env, MemoryRecord, OpenAIChatRequest, OpenAIChatResponse } from "../types";
import { extractJsonObject } from "../utils/jsonHelpers";
import { normalizeFactKey } from "./coordinates";

export interface FactGroupProposal { fact_key: string; memory_ids: string[]; confidence: number; reason: string; }

export async function proposeFactGroups(env: Env, namespace: string, apply = false): Promise<{ thread: string | null; scanned: number; proposed: number; queued: number; groups: FactGroupProposal[] }> {
  const threadRow = await env.DB.prepare(`SELECT thread, COUNT(*) AS count FROM memories WHERE namespace = ? AND status = 'active' AND (fact_key IS NULL OR fact_key = '') AND thread IS NOT NULL AND importance >= 0.6 AND type IN ('rule','lesson','core','preference','identity','note') GROUP BY thread HAVING count >= 2 ORDER BY count DESC, thread LIMIT 1`).bind(namespace).first<{thread:string;count:number}>();
  if (!threadRow?.thread) return { thread:null, scanned:0, proposed:0, queued:0, groups:[] };
  const rows = await env.DB.prepare(`SELECT * FROM memories WHERE namespace = ? AND status = 'active' AND (fact_key IS NULL OR fact_key = '') AND thread = ? AND importance >= 0.6 AND type IN ('rule','lesson','core','preference','identity','note') ORDER BY importance DESC, updated_at DESC LIMIT 20`).bind(namespace, threadRow.thread).all<MemoryRecord>();
  const memories = rows.results ?? [];
  if (memories.length < 2) return { thread:threadRow.thread, scanned: memories.length, proposed: 0, queued: 0, groups: [] };
  const model = env.MEMORY_MODEL || env.DREAM_MODEL || env.MEMORY_EXTRACT_MODEL;
  if (!model) throw new Error("missing_model");
  const request: OpenAIChatRequest = { model, temperature: 0, max_tokens: 2200, response_format: { type: "json_object" }, stream: false, messages: [
    { role: "system", content: "你是事实归并器。只输出完整 JSON。宁可不分组，也不要把同主题的不同事实合并。" },
    { role: "user", content: `把真正表达同一个稳定事实的记忆分组。每组2-8条，confidence>=0.85。fact_key必须是小写英文/数字/._:-组成的稳定事实槽。输出 {"groups":[{"fact_key":"...","memory_ids":["..."],"confidence":0.9,"reason":"..."}]}。记忆：${JSON.stringify(memories.map(m => ({ id:m.id, type:m.type, thread:m.thread, content:m.content.slice(0,300) })))}` }
  ] };
  const response = await callOpenAICompat(env, request);
  if (!response.ok) throw new Error(`model_status_${response.status}`);
  const parsed = await response.json() as OpenAIChatResponse;
  const content = (parsed.choices?.[0]?.message as { content?: unknown } | undefined)?.content;
  const json = extractJsonObject(typeof content === "string" ? content : "") as { groups?: unknown } | null;
  const allowed = new Set(memories.map(m => m.id));
  const groups: FactGroupProposal[] = [];
  for (const item of Array.isArray(json?.groups) ? json.groups : []) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>; const key = normalizeFactKey(row.fact_key); const confidence = Number(row.confidence);
    const ids = [...new Set(Array.isArray(row.memory_ids) ? row.memory_ids.map(String).filter(id => allowed.has(id)) : [])].slice(0,8);
    if (!key || !/^[a-z0-9][a-z0-9._:-]*$/.test(key) || ids.length < 2 || !Number.isFinite(confidence) || confidence < 0.85) continue;
    groups.push({ fact_key:key, memory_ids:ids, confidence:Math.min(1,confidence), reason:typeof row.reason === "string" ? row.reason.slice(0,240) : "同一稳定事实" });
  }
  if (apply) for (const group of groups) await upsertMemoryCandidate(env.DB, namespace, { externalKey:`z-fact-group:${group.fact_key}:${group.memory_ids.slice().sort().join(",")}`, dreamDate:new Date().toISOString().slice(0,10), action:"fact_group", subject:"memory_fact_group", payload:{ ...group, members:memories.filter(m=>group.memory_ids.includes(m.id)).map(m=>({id:m.id,content:m.content.slice(0,220)})) }, sourceChunkIds:[], sourceChunks:[], status:"pending" });
  return { thread:threadRow.thread, scanned: memories.length, proposed: groups.length, queued: apply ? groups.length : 0, groups };
}
