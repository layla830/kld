export const RELATION_PROVENANCE_CLASSES = Object.freeze([
  "deterministic_rebuildable",
  "human_reviewed",
  "builder_backed",
  "api_written",
  "legacy_backfill",
  "unproven_source"
]);

export const RELATION_PROVENANCE_PREFIXES = Object.freeze({
  deterministic_rebuildable: Object.freeze([
    "diary_day:",
    "diary_timeline:",
    "timeline_approved:",
    "historical-structural:"
  ]),
  human_reviewed: Object.freeze([
    "y-review:approved:",
    "fact-group:approved:"
  ]),
  builder_backed: Object.freeze([
    "y:auto:",
    "dream:auto:"
  ]),
  api_written: Object.freeze([
    "api:memory-write:"
  ]),
  legacy_backfill: Object.freeze([
    "legacy-backfill:"
  ])
});

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function assertSqlAlias(alias) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(alias)) {
    throw new Error(`invalid_relation_provenance_alias:${alias}`);
  }
}

export function relationReasonPrefixPredicate(alias, prefixes) {
  assertSqlAlias(alias);
  return `(${prefixes.map((prefix) =>
    `SUBSTR(COALESCE(${alias}.reason, ''), 1, ${prefix.length}) = ${sqlString(prefix)}`
  ).join(" OR ")})`;
}

export function relationProvenanceSql(alias) {
  assertSqlAlias(alias);
  const predicates = {
    deterministic_rebuildable: relationReasonPrefixPredicate(
      alias,
      RELATION_PROVENANCE_PREFIXES.deterministic_rebuildable
    ),
    human_reviewed: relationReasonPrefixPredicate(
      alias,
      RELATION_PROVENANCE_PREFIXES.human_reviewed
    ),
    builder_backed: relationReasonPrefixPredicate(
      alias,
      RELATION_PROVENANCE_PREFIXES.builder_backed
    ),
    api_written: relationReasonPrefixPredicate(
      alias,
      RELATION_PROVENANCE_PREFIXES.api_written
    ),
    legacy_backfill: relationReasonPrefixPredicate(
      alias,
      RELATION_PROVENANCE_PREFIXES.legacy_backfill
    )
  };
  const proven = `(
    ${predicates.deterministic_rebuildable}
    OR ${predicates.human_reviewed}
    OR ${predicates.builder_backed}
    OR ${predicates.api_written}
    OR ${predicates.legacy_backfill}
  )`;
  const unproven = `NOT (${proven})`;
  const classificationCase = `CASE
    WHEN ${predicates.deterministic_rebuildable} THEN 'deterministic_rebuildable'
    WHEN ${predicates.human_reviewed} THEN 'human_reviewed'
    WHEN ${predicates.builder_backed} THEN 'builder_backed'
    WHEN ${predicates.api_written} THEN 'api_written'
    WHEN ${predicates.legacy_backfill} THEN 'legacy_backfill'
    ELSE 'unproven_source'
  END`;
  return {
    predicates: {
      ...predicates,
      unproven_source: unproven
    },
    proven,
    unproven,
    classificationCase
  };
}

export function classifyRelationReason(reason) {
  const value = typeof reason === "string" ? reason : "";
  for (const provenanceClass of RELATION_PROVENANCE_CLASSES) {
    if (provenanceClass === "unproven_source") continue;
    if (RELATION_PROVENANCE_PREFIXES[provenanceClass].some(
      (prefix) => value.startsWith(prefix)
    )) {
      return provenanceClass;
    }
  }
  return "unproven_source";
}
