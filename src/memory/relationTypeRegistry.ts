/**
 * Relation type registry — the single source of truth for relation-type
 * metadata (label, meaning, direction).  Both the admin board
 * (`metabolismView.ts`) and the historical Y reconfirmation pipeline import
 * from this module so there is exactly one definition site, not two copies
 * kept in sync by a test.
 *
 * See: docs/historical-y-reconfirmation-hardening-v2-spec-2026-08-02.md §1.1
 */

export type RelationDirection = "symmetric" | "directed";

export interface RelationTypeMeta {
  label: string;
  meaning: string;
  direction: RelationDirection;
}

export const RELATION_TYPE_REGISTRY: Record<string, RelationTypeMeta> = {
  same_issue: { label: "同一问题", meaning: "两条记忆在处理同一个问题", direction: "symmetric" },
  same_project: { label: "同一项目", meaning: "两条记忆属于同一个项目", direction: "symmetric" },
  same_tool: { label: "同一工具", meaning: "两条记忆涉及同一个工具", direction: "symmetric" },
  same_event: { label: "同一事件", meaning: "两条记忆描述同一件具体事件", direction: "symmetric" },
  same_topic: { label: "同一话题", meaning: "两条记忆主题相同，但不一定是同一事件", direction: "symmetric" },
  temporal_sequence: { label: "时间先后", meaning: "起点记忆发生在前，终点记忆是后续", direction: "directed" },
  emotional_link: { label: "情绪关联", meaning: "两条记忆共享相近的情绪体验", direction: "symmetric" },
  in_thread: { label: "同一主题线", meaning: "两条记忆属于同一条长期主题线", direction: "symmetric" },
  same_person: { label: "同一人物", meaning: "两条记忆涉及同一个人", direction: "symmetric" },
  in_episode: { label: "同一经历", meaning: "两条记忆属于同一段经历", direction: "symmetric" },
  instance_of: { label: "实例归属", meaning: "起点记忆是终点概念的一个具体实例", direction: "directed" },
  derived_from: { label: "由此提炼", meaning: "终点记忆由起点记忆提炼或演化而来", direction: "directed" },
  same_fact_key: { label: "同一事实槽", meaning: "两条记忆是同一事实的不同记录", direction: "symmetric" },
  origin_split: { label: "同源拆分", meaning: "两条记忆来自同一条原始记录的拆分", direction: "symmetric" },
  contradicts: { label: "相互矛盾", meaning: "两条记忆对同一事实给出了不兼容的描述", direction: "symmetric" },
  cause_effect: { label: "因果关系", meaning: "起点记忆描述原因，终点记忆描述结果", direction: "directed" },
  supports: { label: "支持关系", meaning: "起点记忆为终点记忆提供证据或支撑", direction: "directed" }
};

// ---- Derived sets (frozen for safety) ---------------------------------------

/** Directed relation types that the historical Y pipeline may emit. */
export const DIRECTED_RELATION_TYPES: ReadonlySet<string> = new Set(
  Object.entries(RELATION_TYPE_REGISTRY)
    .filter(([, meta]) => meta.direction === "directed")
    .map(([type]) => type)
);

/** Structural relation types — decidable only from record fields, not the model. */
export const STRUCTURAL_RELATION_TYPES: ReadonlySet<string> = new Set([
  "in_thread",
  "same_fact_key",
  "origin_split"
]);

/**
 * Check whether a relation type is structural (decidable from record fields).
 */
export function isStructuralRelationType(relationType: string): boolean {
  return STRUCTURAL_RELATION_TYPES.has(relationType);
}

/**
 * Check whether a relation type is directed (has a canonical A→B direction).
 */
export function isDirectedRelationType(relationType: string): boolean {
  return DIRECTED_RELATION_TYPES.has(relationType);
}
