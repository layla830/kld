import type { MemoryApiRecord } from "../types";
import type { MemorySearchDegradation } from "../memory/search";
import type { EAxisFusionTrace } from "./fusion";

export type RecallLayerName = "authority" | "evidence" | "association" | "fallback";

export interface RecallLayerTrace {
  count: number;
  ids: string[];
  types: string[];
}

export interface RecallTrace {
  strategy: "deterministic_fast_path" | "hybrid_search";
  layers: Record<RecallLayerName, RecallLayerTrace>;
  e_axis?: EAxisFusionTrace;
  degraded_sources?: MemorySearchDegradation[];
}

const AUTHORITY_TYPES = new Set(["rule", "lesson", "core", "preference", "identity", "project_state", "timeline_day"]);
const EVIDENCE_TYPES = new Set(["quote", "excerpt", "milestone", "message", "conversation_message", "episodic"]);

function layerOf(memory: MemoryApiRecord): RecallLayerName {
  const type = memory.type.toLowerCase();
  if (memory.fact_key || AUTHORITY_TYPES.has(type)) return "authority";
  if (EVIDENCE_TYPES.has(type)) return "evidence";
  if (memory.thread || memory.tags.some((tag) => /relation|timeline|same_|in_thread|derived_from/i.test(tag))) return "association";
  return "fallback";
}

export function buildRecallTrace(
  memories: MemoryApiRecord[],
  strategy: RecallTrace["strategy"],
  eAxis?: EAxisFusionTrace,
  degradations: MemorySearchDegradation[] = []
): RecallTrace {
  const buckets: Record<RecallLayerName, MemoryApiRecord[]> = {
    authority: [], evidence: [], association: [], fallback: []
  };
  for (const memory of memories) buckets[layerOf(memory)].push(memory);

  const layers = Object.fromEntries(
    (Object.entries(buckets) as Array<[RecallLayerName, MemoryApiRecord[]]>).map(([name, records]) => [
      name,
      {
        count: records.length,
        ids: records.map((record) => record.id),
        types: [...new Set(records.map((record) => record.type))]
      }
    ])
  ) as Record<RecallLayerName, RecallLayerTrace>;
  return {
    strategy,
    layers,
    ...(eAxis ? { e_axis: eAxis } : {}),
    ...(degradations.length > 0
      ? { degraded_sources: degradations.map(({ source, code }) => ({ source, code })) }
      : {})
  };
}
