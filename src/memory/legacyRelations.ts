import { createMemoryRelation } from "../db/memoryRelations";
import type { Env, MemoryRecord } from "../types";

interface LegacyRelationProposal {
  source_id: string;
  target_id: string;
  relation_type: "same_fact_key" | "in_thread" | "origin_split" | "temporal_sequence";
  strength: number;
  reason: string;
}

function parseList(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String).map((item) => item.trim()).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function dateTag(memory: MemoryRecord): string | null {
  return parseList(memory.tags).find((tag) => /^date:20\d{2}-\d{2}-\d{2}$/.test(tag))?.slice(5) ?? null;
}

function addChain(
  proposals: Map<string, LegacyRelationProposal>,
  memories: MemoryRecord[],
  relationType: LegacyRelationProposal["relation_type"],
  strength: number,
  reason: string
): void {
  const sorted = [...memories].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
  for (let index = 1; index < sorted.length; index += 1) {
    const source = sorted[index - 1];
    const target = sorted[index];
    const pair = source.id < target.id ? `${source.id}|${target.id}` : `${target.id}|${source.id}`;
    const key = `${relationType}|${pair}`;
    if (!proposals.has(key)) proposals.set(key, {
      source_id: source.id,
      target_id: target.id,
      relation_type: relationType,
      strength,
      reason
    });
  }
}

export async function runLegacyRelationBackfill(
  env: Env,
  namespace: string,
  apply = false
): Promise<{
  scanned: number;
  proposed: number;
  inserted: number;
  by_type: Record<string, number>;
  sample: LegacyRelationProposal[];
}> {
  const rows = await env.DB.prepare(
    `SELECT * FROM memories
     WHERE namespace = ? AND status = 'active' AND type != 'dream_review'
     ORDER BY id LIMIT 1000`
  ).bind(namespace).all<MemoryRecord>();
  const memories = rows.results ?? [];
  const proposals = new Map<string, LegacyRelationProposal>();

  const byFact = new Map<string, MemoryRecord[]>();
  const byThread = new Map<string, MemoryRecord[]>();
  const bySourceMessage = new Map<string, MemoryRecord[]>();
  for (const memory of memories) {
    if (memory.fact_key) byFact.set(memory.fact_key, [...(byFact.get(memory.fact_key) ?? []), memory]);
    if (memory.thread && !/^dream(?:-|\.)?review$/i.test(memory.thread)) {
      byThread.set(memory.thread, [...(byThread.get(memory.thread) ?? []), memory]);
    }
    for (const sourceId of parseList(memory.source_message_ids)) {
      bySourceMessage.set(sourceId, [...(bySourceMessage.get(sourceId) ?? []), memory]);
    }
  }

  for (const [factKey, group] of byFact) {
    if (group.length < 2) continue;
    addChain(proposals, group, "same_fact_key", 0.92, `legacy-backfill:same fact_key ${factKey}`);
    const dated = group.filter((memory) => dateTag(memory)).sort((a, b) => dateTag(a)!.localeCompare(dateTag(b)!) || a.id.localeCompare(b.id));
    for (let index = 1; index < dated.length; index += 1) {
      const previousDate = dateTag(dated[index - 1]);
      const currentDate = dateTag(dated[index]);
      if (!previousDate || !currentDate || previousDate === currentDate) continue;
      const source = dated[index - 1];
      const target = dated[index];
      proposals.set(`temporal_sequence|${source.id}|${target.id}`, {
        source_id: source.id,
        target_id: target.id,
        relation_type: "temporal_sequence",
        strength: 0.8,
        reason: `legacy-backfill:${factKey} ${previousDate} -> ${currentDate}`
      });
    }
  }

  for (const [thread, group] of byThread) {
    if (group.length < 2) continue;
    addChain(proposals, group, "in_thread", 0.75, `legacy-backfill:thread ${thread}`);
  }

  for (const [sourceId, group] of bySourceMessage) {
    if (group.length < 2) continue;
    addChain(proposals, group, "origin_split", 0.9, `legacy-backfill:shared source message ${sourceId}`);
  }

  const all = [...proposals.values()];
  const byType: Record<string, number> = {};
  for (const proposal of all) byType[proposal.relation_type] = (byType[proposal.relation_type] ?? 0) + 1;
  let inserted = 0;
  if (apply) {
    for (const proposal of all) {
      if (await createMemoryRelation(env.DB, {
        namespace,
        sourceMemoryId: proposal.source_id,
        targetMemoryId: proposal.target_id,
        relationType: proposal.relation_type,
        strength: proposal.strength,
        reason: proposal.reason
      })) inserted += 1;
    }
  }

  return { scanned: memories.length, proposed: all.length, inserted, by_type: byType, sample: all.slice(0, 30) };
}
