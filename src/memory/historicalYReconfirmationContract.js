export const HISTORICAL_Y_RECONFIRMATION_SCHEMA_VERSION = 2;

export const HISTORICAL_Y_RECONFIRMABLE_RELATION_TYPES = Object.freeze([
  "same_issue",
  "same_project",
  "same_tool",
  "same_event",
  "same_topic",
  "emotional_link",
  "in_thread",
  "same_person",
  "in_episode",
  "instance_of",
  "derived_from",
  "same_fact_key"
]);

// origin_split stays structural but is NOT reconfirmable this round (spec P3):
// the admin table calls it symmetric while SYMMETRIC_RELATION_TYPES excludes it,
// so pair direction is never canonicalized. Excluding it here keeps the CLI
// candidate set clean and makes the worker reject origin_split relation IDs
// with 409 before any ledger row can burn the relation's one-shot outcome.

export const HISTORICAL_Y_DIRECTED_RELATION_TYPES = Object.freeze(
  ["derived_from", "instance_of"]
);

export const HISTORICAL_Y_STRUCTURAL_RELATION_TYPES = Object.freeze(
  ["in_thread", "same_fact_key", "origin_split"]
);

export function normalizeHistoricalYRelationIds(relationIds) {
  if (!Array.isArray(relationIds)) {
    throw new Error("historical_y_relation_ids_required");
  }
  const normalized = relationIds.map((value) => String(value).trim());
  if (normalized.some((value) => value.length === 0)) {
    throw new Error("historical_y_relation_id_empty");
  }
  if (new Set(normalized).size !== normalized.length) {
    throw new Error("historical_y_relation_ids_duplicate");
  }
  return normalized.sort();
}

export function canonicalHistoricalYBatch(manifestId, relationIds) {
  return JSON.stringify({
    schema_version: HISTORICAL_Y_RECONFIRMATION_SCHEMA_VERSION,
    manifest_id: String(manifestId).trim(),
    relation_ids: normalizeHistoricalYRelationIds(relationIds)
  });
}

export function historicalYBatchIdFromSha256(sha256) {
  const normalized = String(sha256).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalized)) {
    throw new Error("historical_y_batch_sha256_invalid");
  }
  return `hyr_${normalized.slice(0, 32)}`;
}
