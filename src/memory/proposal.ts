import type { MemoryCandidateRecord } from "../db/memoryCandidates";

export type ProposalAxis = "X" | "Y" | "Z" | "E" | "M" | "ingest";
export type ProposalKind = "timeline" | "relation" | "fact_transition" | "coordinate" | "maintenance" | "ingest";

export interface MemoryProposal {
  id: string;
  namespace: string;
  axis: ProposalAxis;
  kind: ProposalKind;
  action: string;
  targetId: string | null;
  status: string;
  risk: "normal" | "medium";
  resolutionMode: "review";
  evidence: { dreamDate: string; chunkIds: number[]; chunks: Array<Record<string, unknown>> };
  payload: Record<string, unknown>;
}

function object(text: string): Record<string, unknown> {
  try { const value = JSON.parse(text) as unknown; return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; } catch { return {}; }
}

function array<T>(text: string): T[] {
  try { const value = JSON.parse(text) as unknown; return Array.isArray(value) ? value as T[] : []; } catch { return []; }
}

function classify(candidate: MemoryCandidateRecord, payload: Record<string, unknown>): { axis: ProposalAxis; kind: ProposalKind } {
  if (candidate.action === "timeline_date") return { axis: "X", kind: "timeline" };
  if (candidate.action === "relation") return { axis: "Y", kind: "relation" };
  if (candidate.action === "fact_group" || payload._kind === "fact_transition") return { axis: "Z", kind: "fact_transition" };
  if (payload._kind === "coordinate_backfill") return { axis: "E", kind: "coordinate" };
  if (["m_archive", "m_relation_cleanup"].includes(candidate.action)) return { axis: "M", kind: "maintenance" };
  return { axis: "ingest", kind: "ingest" };
}

export function proposalFromCandidate(candidate: MemoryCandidateRecord): MemoryProposal {
  const payload = object(candidate.payload_json);
  const classification = classify(candidate, payload);
  return {
    id: candidate.id, namespace: candidate.namespace, ...classification,
    action: candidate.action, targetId: candidate.target_id, status: candidate.status,
    risk: classification.axis === "Z" || classification.axis === "M" ? "medium" : "normal",
    resolutionMode: "review",
    evidence: {
      dreamDate: candidate.dream_date,
      chunkIds: array<number>(candidate.source_chunk_ids_json),
      chunks: array<Record<string, unknown>>(candidate.source_chunks_json)
    },
    payload
  };
}
