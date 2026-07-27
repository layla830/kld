import {
  activeDiarySplitOriginPredicate,
  sqlString
} from "./inactive-five-axis-audit.mjs";

export const MAX_DIARY_ORIGIN_REPAIR_LIMIT = 100;

function boundedLimit(value) {
  return Math.min(Math.max(Math.floor(value), 1), MAX_DIARY_ORIGIN_REPAIR_LIMIT);
}

function invalidOriginSelection(namespace) {
  return `FROM memory_diary_timeline_memberships AS membership
    LEFT JOIN memories AS origin
      ON origin.namespace = membership.namespace
     AND origin.id = membership.origin_diary_id
    WHERE membership.namespace = ${namespace}
      AND (
        origin.id IS NULL
        OR NOT (${activeDiarySplitOriginPredicate("origin")})
      )`;
}

function selectedOrigins(namespace, limit) {
  return `SELECT DISTINCT membership.origin_diary_id
    ${invalidOriginSelection(namespace)}
    ORDER BY membership.origin_diary_id
    LIMIT ${limit}`;
}

function ownedDiaryRelationForSelectedOrigin(relationAlias, selectedAlias) {
  return `${relationAlias}.relation_type = 'in_episode'
    AND SUBSTR(
      COALESCE(${relationAlias}.reason, ''),
      1,
      LENGTH('diary_day:' || ${selectedAlias}.origin_diary_id || ':')
    ) = 'diary_day:' || ${selectedAlias}.origin_diary_id || ':'`;
}

export function buildDiaryOriginRepairDryRunQuery(input) {
  const namespace = sqlString(input.namespace);
  const limit = boundedLimit(input.limit);
  const invalid = invalidOriginSelection(namespace);
  const selected = selectedOrigins(namespace, limit);
  return {
    name: "diary-origin-timeline",
    sql: `WITH invalid_origins AS (
      SELECT DISTINCT membership.origin_diary_id
      ${invalid}
    ),
    selected_origins AS (
      ${selected}
    )
    SELECT
      (SELECT COUNT(*) FROM invalid_origins) AS repairable_origins,
      (
        SELECT COUNT(*)
        FROM memory_diary_timeline_memberships AS membership
        JOIN selected_origins AS selected
          ON selected.origin_diary_id = membership.origin_diary_id
        WHERE membership.namespace = ${namespace}
      ) AS membership_rows,
      (
        SELECT COUNT(*)
        FROM memory_relations AS relation
        JOIN selected_origins AS selected
          ON ${ownedDiaryRelationForSelectedOrigin("relation", "selected")}
        WHERE relation.namespace = ${namespace}
      ) AS owned_in_episode_rows,
      (SELECT COUNT(*) FROM selected_origins) AS selected,
      CASE
        WHEN (SELECT COUNT(*) FROM invalid_origins) > ${limit} THEN 1
        ELSE 0
      END AS has_more`
  };
}

export function buildDiaryOriginRepairApplyQueries(input) {
  const namespace = sqlString(input.namespace);
  const limit = boundedLimit(input.limit);
  const selected = selectedOrigins(namespace, limit);
  return [
    {
      name: "diary-origin-owned-relations",
      sql: `WITH selected_origins AS (
        ${selected}
      )
      DELETE FROM memory_relations AS relation
      WHERE relation.namespace = ${namespace}
        AND EXISTS (
          SELECT 1
          FROM selected_origins AS selected
          WHERE ${ownedDiaryRelationForSelectedOrigin("relation", "selected")}
        )
      RETURNING id`
    },
    {
      name: "diary-origin-memberships",
      sql: `WITH selected_origins AS (
        ${selected}
      )
      DELETE FROM memory_diary_timeline_memberships
      WHERE namespace = ${namespace}
        AND origin_diary_id IN (
          SELECT origin_diary_id FROM selected_origins
        )
      RETURNING memory_id`
    }
  ];
}

export function assertReadOnlyDiaryOriginRepairQuery(query) {
  const sql = query.sql.trim();
  if (!/^(?:SELECT|WITH)\b/i.test(sql)) {
    throw new Error(`diary_origin_repair_dry_run_not_select:${query.name}`);
  }
  if (/\b(?:INSERT|UPDATE|DELETE|REPLACE|CREATE|ALTER|DROP|PRAGMA|VACUUM|ATTACH|DETACH)\b/i.test(sql)) {
    throw new Error(`diary_origin_repair_dry_run_contains_write:${query.name}`);
  }
}
