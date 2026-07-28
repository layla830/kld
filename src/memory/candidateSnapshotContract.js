export const SUPERSEDED_CANDIDATE_SNAPSHOT_REASON =
  "superseded_by_newer_candidate_snapshot";

export function staleOperationalCandidateForMemoryPredicate(
  candidateAlias,
  memoryIdExpression = "?"
) {
  return `EXISTS (
    SELECT 1
    FROM memories AS changed_memory
    WHERE changed_memory.namespace = ${candidateAlias}.namespace
      AND changed_memory.id = ${memoryIdExpression}
      AND (
        (
          ${candidateAlias}.action = 'y_relation_review'
          AND (
            (
              json_extract(${candidateAlias}.payload_json, '$.source_id') = changed_memory.id
              AND (
                (
                  json_type(${candidateAlias}.payload_json, '$.source_revision') = 'integer'
                  AND CAST(json_extract(${candidateAlias}.payload_json, '$.source_revision') AS INTEGER)
                    <> changed_memory.five_axis_revision
                )
                OR
                (
                  json_type(${candidateAlias}.payload_json, '$.source_revision') IS NOT 'integer'
                  AND json_extract(${candidateAlias}.payload_json, '$.source_updated_at')
                    IS NOT changed_memory.updated_at
                )
              )
            )
            OR
            (
              json_extract(${candidateAlias}.payload_json, '$.target_id') = changed_memory.id
              AND (
                (
                  json_type(${candidateAlias}.payload_json, '$.target_revision') = 'integer'
                  AND CAST(json_extract(${candidateAlias}.payload_json, '$.target_revision') AS INTEGER)
                    <> changed_memory.five_axis_revision
                )
                OR
                (
                  json_type(${candidateAlias}.payload_json, '$.target_revision') IS NOT 'integer'
                  AND json_extract(${candidateAlias}.payload_json, '$.target_updated_at')
                    IS NOT changed_memory.updated_at
                )
              )
            )
          )
        )
        OR
        (
          ${candidateAlias}.action = 'z_supersede'
          AND (
            (
              json_extract(${candidateAlias}.payload_json, '$.best.id') = changed_memory.id
              AND json_extract(${candidateAlias}.payload_json, '$.best.updated_at')
                IS NOT changed_memory.updated_at
            )
            OR
            (
              json_extract(${candidateAlias}.payload_json, '$.weaker.id') = changed_memory.id
              AND json_extract(${candidateAlias}.payload_json, '$.weaker.updated_at')
                IS NOT changed_memory.updated_at
            )
          )
        )
        OR
        (
          ${candidateAlias}.action = 'm_archive'
          AND ${candidateAlias}.target_id = changed_memory.id
          AND json_extract(${candidateAlias}.payload_json, '$.before.updated_at')
            IS NOT changed_memory.updated_at
        )
      )
  )`;
}

export function staleOperationalCandidateAuditPredicate(candidateAlias) {
  return `(
    ${candidateAlias}.action IN ('y_relation_review', 'z_supersede', 'm_archive')
    AND EXISTS (
      SELECT 1
      FROM memory_candidate_dependencies AS dependency
      WHERE dependency.namespace = ${candidateAlias}.namespace
        AND dependency.candidate_external_key = ${candidateAlias}.external_key
        AND ${staleOperationalCandidateForMemoryPredicate(
          candidateAlias,
          "dependency.memory_id"
        )}
    )
  )`;
}
