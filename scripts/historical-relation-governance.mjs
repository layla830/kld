import { createHash } from "node:crypto";
import {
  fiveAxisMemoryEligibilityPredicate
} from "../src/memory/fiveAxis/eligibilityContract.js";
import {
  RELATION_PROVENANCE_CLASSES,
  relationProvenanceSql
} from "../src/memory/relationProvenanceContract.js";
import {
  canonicalHistoricalRelationIdentity,
  canonicalHistoricalRelationSelection
} from "../src/memory/historicalRelationSnapshotContract.js";

export {
  canonicalHistoricalRelationIdentity,
  canonicalHistoricalRelationSelection
} from "../src/memory/historicalRelationSnapshotContract.js";

export const HISTORICAL_RELATION_LIFECYCLE_COHORTS = Object.freeze([
  "stale_endpoint",
  "eligible_unproven",
  "eligible_proven"
]);

export const HISTORICAL_RELATION_DEBT_COHORTS = Object.freeze([
  "stale_endpoint",
  "eligible_unproven"
]);

export const HISTORICAL_RELATION_SELECTION_VERSION =
  "five-axis-eligibility:v1+relation-provenance:v1";

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function bindSqlPredicate(predicate) {
  let bindIndex = 0;
  const sql = predicate.sql.replaceAll("?", () => sqlString(predicate.binds[bindIndex++]));
  if (bindIndex !== predicate.binds.length) {
    throw new Error("historical_relation_eligibility_bind_mismatch");
  }
  return sql;
}

function eligibleMemoryPredicate(alias) {
  return bindSqlPredicate(fiveAxisMemoryEligibilityPredicate(alias));
}

function historicalRelationClassificationSql() {
  const sourceEligible = `(${eligibleMemoryPredicate("source_memory")})`;
  const targetEligible = `(${eligibleMemoryPredicate("target_memory")})`;
  const endpointsEligible = `(${sourceEligible} AND ${targetEligible})`;
  const staleEndpoint = `NOT (${endpointsEligible})`;
  const provenance = relationProvenanceSql("relation");
  const lifecycleCase = `CASE
    WHEN ${staleEndpoint} THEN 'stale_endpoint'
    WHEN ${provenance.unproven} THEN 'eligible_unproven'
    ELSE 'eligible_proven'
  END`;
  return {
    sourceEligible,
    targetEligible,
    endpointsEligible,
    staleEndpoint,
    provenance,
    lifecycleCase
  };
}

function classifiedRelationsCte(namespace) {
  const classification = historicalRelationClassificationSql();
  return `WITH classified_relations AS (
    SELECT
      relation.id,
      relation.namespace,
      relation.source_memory_id,
      relation.target_memory_id,
      relation.relation_type,
      relation.strength,
      relation.reason,
      relation.created_at,
      CASE WHEN ${classification.sourceEligible} THEN 1 ELSE 0 END AS source_eligible,
      source_memory.status AS source_status,
      source_memory.active_fact AS source_active_fact,
      source_memory.type AS source_type,
      source_memory.updated_at AS source_updated_at,
      source_memory.five_axis_revision AS source_five_axis_revision,
      CASE WHEN ${classification.targetEligible} THEN 1 ELSE 0 END AS target_eligible,
      target_memory.status AS target_status,
      target_memory.active_fact AS target_active_fact,
      target_memory.type AS target_type,
      target_memory.updated_at AS target_updated_at,
      target_memory.five_axis_revision AS target_five_axis_revision,
      ${classification.lifecycleCase} AS lifecycle_cohort,
      ${classification.provenance.classificationCase} AS provenance_class
    FROM memory_relations AS relation
    JOIN memories AS source_memory
      ON source_memory.namespace = relation.namespace
     AND source_memory.id = relation.source_memory_id
    JOIN memories AS target_memory
      ON target_memory.namespace = relation.namespace
     AND target_memory.id = relation.target_memory_id
    WHERE relation.namespace = ${sqlString(namespace)}
  )`;
}

export function buildHistoricalRelationSummaryQuery(input) {
  return {
    name: "historical_relation_summary",
    sql: `${classifiedRelationsCte(input.namespace)}
    SELECT
      lifecycle_cohort,
      provenance_class,
      relation_type,
      COUNT(*) AS relation_count,
      MIN(created_at) AS first_created_at,
      MAX(created_at) AS last_created_at
    FROM classified_relations
    GROUP BY lifecycle_cohort, provenance_class, relation_type
    ORDER BY lifecycle_cohort, provenance_class, relation_type`
  };
}

export function buildHistoricalRelationPageQuery(input) {
  const pageSize = Number(input.pageSize ?? 250);
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 500) {
    throw new Error("historical_relation_page_size_out_of_range");
  }
  const hasCursor = input.afterCreatedAt != null || input.afterId != null;
  if (hasCursor && (!input.afterCreatedAt || !input.afterId)) {
    throw new Error("historical_relation_cursor_incomplete");
  }
  const cursor = hasCursor
    ? `AND (
        created_at > ${sqlString(input.afterCreatedAt)}
        OR (
          created_at = ${sqlString(input.afterCreatedAt)}
          AND id > ${sqlString(input.afterId)}
        )
      )`
    : "";
  return {
    name: "historical_relation_manifest_page",
    sql: `${classifiedRelationsCte(input.namespace)}
    SELECT *
    FROM classified_relations
    WHERE lifecycle_cohort IN (${HISTORICAL_RELATION_DEBT_COHORTS.map(sqlString).join(", ")})
      ${cursor}
    ORDER BY created_at, id
    LIMIT ${pageSize}`
  };
}

export function assertReadOnlyHistoricalRelationQueries(queries) {
  const writePattern =
    /\b(?:INSERT|UPDATE|DELETE|REPLACE|CREATE|ALTER|DROP|PRAGMA|VACUUM|ATTACH|DETACH)\b/i;
  for (const query of queries) {
    const sql = query.sql.trim();
    if (!/^(?:SELECT|WITH)\b/i.test(sql)) {
      throw new Error(`historical_relation_query_not_select:${query.name}`);
    }
    if (writePattern.test(sql)) {
      throw new Error(`historical_relation_query_contains_write:${query.name}`);
    }
  }
}

function requiredString(row, field) {
  const value = row[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`historical_relation_manifest_invalid_${field}`);
  }
  return value;
}

function nullableString(value) {
  if (value == null) return null;
  if (typeof value !== "string") {
    throw new Error("historical_relation_manifest_invalid_nullable_string");
  }
  return value;
}

function finiteNumber(row, field) {
  const value = Number(row[field]);
  if (!Number.isFinite(value)) {
    throw new Error(`historical_relation_manifest_invalid_${field}`);
  }
  return value;
}

function binaryNumber(row, field) {
  const value = finiteNumber(row, field);
  if (value !== 0 && value !== 1) {
    throw new Error(`historical_relation_manifest_invalid_${field}`);
  }
  return value;
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function normalizeManifestRow(row) {
  const lifecycleCohort = requiredString(row, "lifecycle_cohort");
  if (!HISTORICAL_RELATION_DEBT_COHORTS.includes(lifecycleCohort)) {
    throw new Error(`historical_relation_manifest_non_debt_cohort:${lifecycleCohort}`);
  }
  const provenanceClass = requiredString(row, "provenance_class");
  if (!RELATION_PROVENANCE_CLASSES.includes(provenanceClass)) {
    throw new Error(`historical_relation_manifest_invalid_provenance_class:${provenanceClass}`);
  }
  const normalized = {
    id: requiredString(row, "id"),
    namespace: requiredString(row, "namespace"),
    source_memory_id: requiredString(row, "source_memory_id"),
    target_memory_id: requiredString(row, "target_memory_id"),
    relation_type: requiredString(row, "relation_type"),
    strength: finiteNumber(row, "strength"),
    reason: nullableString(row.reason),
    created_at: requiredString(row, "created_at"),
    source_eligible: binaryNumber(row, "source_eligible") === 1,
    source_status: requiredString(row, "source_status"),
    source_active_fact: binaryNumber(row, "source_active_fact"),
    source_type: requiredString(row, "source_type"),
    source_updated_at: requiredString(row, "source_updated_at"),
    source_five_axis_revision: finiteNumber(row, "source_five_axis_revision"),
    target_eligible: binaryNumber(row, "target_eligible") === 1,
    target_status: requiredString(row, "target_status"),
    target_active_fact: binaryNumber(row, "target_active_fact"),
    target_type: requiredString(row, "target_type"),
    target_updated_at: requiredString(row, "target_updated_at"),
    target_five_axis_revision: finiteNumber(row, "target_five_axis_revision"),
    lifecycle_cohort: lifecycleCohort,
    provenance_class: provenanceClass
  };
  return {
    ...normalized,
    identity_sha256: sha256(canonicalHistoricalRelationIdentity(normalized)),
    selection_sha256: sha256(canonicalHistoricalRelationSelection(normalized))
  };
}

function summaryDebtCount(summaryRows) {
  return summaryRows.reduce((total, row) => (
    HISTORICAL_RELATION_DEBT_COHORTS.includes(row.lifecycle_cohort)
      ? total + finiteNumber(row, "relation_count")
      : total
  ), 0);
}

export function buildHistoricalRelationManifest(input) {
  const relations = input.rows.map(normalizeManifestRow).sort((left, right) => (
    left.created_at.localeCompare(right.created_at) || left.id.localeCompare(right.id)
  ));
  const identities = new Set();
  for (const relation of relations) {
    const key = `${relation.namespace}\u0000${relation.id}`;
    if (identities.has(key)) {
      throw new Error(`historical_relation_manifest_duplicate:${relation.id}`);
    }
    identities.add(key);
    if (relation.namespace !== input.namespace) {
      throw new Error(`historical_relation_manifest_namespace_mismatch:${relation.id}`);
    }
  }
  const expectedCount = summaryDebtCount(input.summaryRows);
  if (expectedCount !== relations.length) {
    throw new Error(
      `historical_relation_manifest_summary_count_mismatch:${expectedCount}:${relations.length}`
    );
  }
  const countsByCohort = Object.fromEntries(
    HISTORICAL_RELATION_DEBT_COHORTS.map((cohort) => [
      cohort,
      relations.filter((relation) => relation.lifecycle_cohort === cohort).length
    ])
  );
  const cohortManifests = Object.fromEntries(
    HISTORICAL_RELATION_DEBT_COHORTS.map((cohort) => {
      const cohortRows = relations.filter(
        (relation) => relation.lifecycle_cohort === cohort
      );
      const relationsSha256 = sha256(
        cohortRows.map((relation) => relation.identity_sha256).join("\n")
      );
      const selectionSha256 = sha256(
        cohortRows.map((relation) => relation.selection_sha256).join("\n")
      );
      const manifestId = `hrg_${sha256(JSON.stringify([
        input.namespace,
        cohort,
        HISTORICAL_RELATION_SELECTION_VERSION,
        cohortRows.length,
        relationsSha256,
        selectionSha256
      ])).slice(0, 32)}`;
      return [cohort, {
        manifest_id: manifestId,
        relation_count: cohortRows.length,
        relations_sha256: relationsSha256,
        selection_sha256: selectionSha256
      }];
    })
  );
  return {
    schema_version: 1,
    mode: "read_only",
    namespace: input.namespace,
    generated_at: input.generatedAt ?? new Date().toISOString(),
    selection_predicate_version: HISTORICAL_RELATION_SELECTION_VERSION,
    relation_count: relations.length,
    counts_by_cohort: countsByCohort,
    relations_sha256: sha256(
      relations.map((relation) => relation.identity_sha256).join("\n")
    ),
    selection_sha256: sha256(
      relations.map((relation) => relation.selection_sha256).join("\n")
    ),
    cohort_manifests: cohortManifests,
    summary_rows: input.summaryRows,
    relations
  };
}
