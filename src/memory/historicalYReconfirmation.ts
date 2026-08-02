import {
  getMemoryRelationById,
  normalizeRelationPair,
  normalizeRelationType,
  prepareMemoryRelationInsert,
  type MemoryRelationRecord
} from "../db/memoryRelations";
import { fetchMemoriesByIds } from "../db/memories";
import { relationProvenance } from "../db/relationProvenance";
import type { Env, MemoryRecord } from "../types";
import {
  fiveAxisMemoryEligibilityPredicate,
  isFiveAxisMemoryEligible
} from "./fiveAxis/eligibility";
import {
  type RelationCandidate
} from "./fiveAxis/yRelations";
import {
  historicalYContentExcerpt,
  proposeHistoricalYRelations,
  type HistoricalYProposalResult,
  type HistoricalYRelationHint
} from "./historicalYProposer";
import {
  canonicalHistoricalYBatch,
  HISTORICAL_Y_RECONFIRMABLE_RELATION_TYPES,
  HISTORICAL_Y_RECONFIRMATION_SCHEMA_VERSION,
  historicalYBatchIdFromSha256,
  normalizeHistoricalYRelationIds
} from "./historicalYReconfirmationContract.js";
import { relationProvenanceSql } from "./relationProvenanceContract.js";

const MAX_RELATIONS_PER_BATCH = 10;
const RECONFIRMABLE_TYPES = new Set(HISTORICAL_Y_RECONFIRMABLE_RELATION_TYPES);

interface HistoricalManifestRow {
  manifest_id: string;
  namespace: string;
  lifecycle_cohort: string;
  expected_relation_count: number;
  snapshot_relation_count: number;
  expected_relations_sha256: string;
  verified_relations_sha256: string | null;
  expected_selection_sha256: string;
  verified_selection_sha256: string | null;
  status: string;
}

interface HistoricalSnapshotRow {
  manifest_id: string;
  namespace: string;
  lifecycle_cohort: string;
  relation_id: string;
  source_memory_id: string;
  target_memory_id: string;
  relation_type: string;
  strength: number;
  reason: string | null;
  relation_created_at: string;
  source_eligible: number;
  source_status: string;
  source_active_fact: number;
  source_type: string;
  source_updated_at: string;
  source_five_axis_revision: number;
  target_eligible: number;
  target_status: string;
  target_active_fact: number;
  target_type: string;
  target_updated_at: string;
  target_five_axis_revision: number;
  provenance_class: string;
}

interface HistoricalBatchRow {
  batch_id: string;
  manifest_id: string;
  namespace: string;
  relation_ids_sha256: string;
  relation_ids_json: string;
  relation_count: number;
  created_at: string;
}

export interface HistoricalReconfirmationEntry {
  relation_id: string;
  before_reason: string | null;
  proposed_relation_type: string;
  proposed_strength: number | null;
  outcome: "promoted" | "not_reconfirmed" | "not_applied";
  after_reason: string | null;
  created_at: string;
}

interface HistoricalYDecision {
  snapshot: HistoricalSnapshotRow;
  proposedRelationType: string;
  proposedStrength: number | null;
  exactMatch: boolean;
  changeKind: "exact_match" | "type_changed" | "none_returned" | "missing_pair";
  provenanceClaim: boolean;
}

export class HistoricalYReconfirmationError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number
  ) {
    super(code);
  }
}

export interface HistoricalYReconfirmationDependencies {
  proposeRelations: (
    env: Env,
    candidates: RelationCandidate[],
    modelOverride?: string
  ) => Promise<HistoricalYProposalResult>;
  now: () => string;
}

const defaultDependencies: HistoricalYReconfirmationDependencies = {
  proposeRelations: proposeHistoricalYRelations,
  now: () => new Date().toISOString()
};

function requestError(code: string, status = 400): never {
  throw new HistoricalYReconfirmationError(code, status);
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function sameNullable(left: string | null, right: string | null): boolean {
  return left === right;
}

function expectedPromotedReason(snapshot: HistoricalSnapshotRow): string {
  const provenance = relationProvenance.yAuto(
    snapshot.source_memory_id,
    snapshot.source_five_axis_revision
  );
  return snapshot.reason == null || snapshot.reason === ""
    ? provenance
    : `${provenance}|previous_reason:${snapshot.reason}`;
}

function assertManifestVerified(manifest: HistoricalManifestRow | null): asserts manifest is HistoricalManifestRow {
  if (!manifest) requestError("historical_y_manifest_missing", 404);
  if (manifest.lifecycle_cohort !== "eligible_unproven") {
    requestError("historical_y_manifest_wrong_cohort", 409);
  }
  if (manifest.status !== "verified"
    || manifest.snapshot_relation_count !== manifest.expected_relation_count
    || manifest.verified_relations_sha256 !== manifest.expected_relations_sha256
    || manifest.verified_selection_sha256 !== manifest.expected_selection_sha256) {
    requestError("historical_y_manifest_not_verified", 409);
  }
}

function assertSnapshotCurrent(
  snapshot: HistoricalSnapshotRow,
  relation: MemoryRelationRecord | null,
  source: MemoryRecord | undefined,
  target: MemoryRecord | undefined
): asserts relation is MemoryRelationRecord {
  if (snapshot.lifecycle_cohort !== "eligible_unproven"
    || snapshot.provenance_class !== "unproven_source"
    || snapshot.source_eligible !== 1
    || snapshot.target_eligible !== 1) {
    requestError(`historical_y_snapshot_not_eligible:${snapshot.relation_id}`, 409);
  }
  if (!RECONFIRMABLE_TYPES.has(snapshot.relation_type)) {
    requestError(`historical_y_relation_type_not_reconfirmable:${snapshot.relation_id}`, 409);
  }
  const normalizedPair = normalizeRelationPair(
    snapshot.source_memory_id,
    snapshot.target_memory_id,
    snapshot.relation_type
  );
  if (normalizedPair.sourceMemoryId !== snapshot.source_memory_id
    || normalizedPair.targetMemoryId !== snapshot.target_memory_id) {
    requestError(`historical_y_relation_pair_not_canonical:${snapshot.relation_id}`, 409);
  }
  if (!relation
    || relation.source_memory_id !== snapshot.source_memory_id
    || relation.target_memory_id !== snapshot.target_memory_id
    || relation.relation_type !== snapshot.relation_type
    || Number(relation.strength) !== Number(snapshot.strength)
    || !sameNullable(relation.reason, snapshot.reason)
    || relation.created_at !== snapshot.relation_created_at) {
    requestError(`historical_y_relation_drift:${snapshot.relation_id}`, 409);
  }
  const sourceMatches = source
    && source.status === snapshot.source_status
    && source.active_fact === snapshot.source_active_fact
    && source.type === snapshot.source_type
    && source.updated_at === snapshot.source_updated_at
    && (source.five_axis_revision ?? 1) === snapshot.source_five_axis_revision
    && isFiveAxisMemoryEligible(source);
  const targetMatches = target
    && target.status === snapshot.target_status
    && target.active_fact === snapshot.target_active_fact
    && target.type === snapshot.target_type
    && target.updated_at === snapshot.target_updated_at
    && (target.five_axis_revision ?? 1) === snapshot.target_five_axis_revision
    && isFiveAxisMemoryEligible(target);
  if (!sourceMatches || !targetMatches) {
    requestError(`historical_y_endpoint_drift:${snapshot.relation_id}`, 409);
  }
}

async function loadStoredBatch(
  db: D1Database,
  input: {
    batchId: string;
    manifestId: string;
    namespace: string;
    relationIdsSha256: string;
    relationIds: string[];
  }
): Promise<{ batch: HistoricalBatchRow; entries: HistoricalReconfirmationEntry[] } | null> {
  const batch = await db.prepare(
    `SELECT batch_id, manifest_id, namespace, relation_ids_sha256,
            relation_ids_json, relation_count, created_at
     FROM historical_relation_reconfirmation_batches
     WHERE batch_id = ?`
  ).bind(input.batchId).first<HistoricalBatchRow>();
  if (!batch) return null;
  if (batch.manifest_id !== input.manifestId
    || batch.namespace !== input.namespace
    || batch.relation_ids_sha256 !== input.relationIdsSha256
    || batch.relation_count !== input.relationIds.length
    || batch.relation_ids_json !== JSON.stringify(input.relationIds)) {
    requestError("historical_y_batch_identity_conflict", 409);
  }
  const result = await db.prepare(
    `SELECT relation_id, before_reason, proposed_relation_type,
            proposed_strength, outcome, after_reason, created_at
     FROM historical_relation_reconfirmation_entries
     WHERE batch_id = ?
     ORDER BY relation_id`
  ).bind(input.batchId).all<HistoricalReconfirmationEntry>();
  const entries = result.results ?? [];
  if (entries.length !== batch.relation_count) {
    requestError("historical_y_batch_incomplete", 500);
  }
  return { batch, entries };
}

async function loadPreflight(
  db: D1Database,
  namespace: string,
  manifestId: string,
  relationIds: string[]
): Promise<{
  snapshots: HistoricalSnapshotRow[];
  memories: Map<string, MemoryRecord>;
}> {
  const marks = placeholders(relationIds.length);
  const [manifest, snapshotResult, existingEntryResult] = await Promise.all([
    db.prepare(
      `SELECT manifest_id, namespace, lifecycle_cohort,
              expected_relation_count, snapshot_relation_count,
              expected_relations_sha256, verified_relations_sha256,
              expected_selection_sha256, verified_selection_sha256, status
       FROM historical_relation_manifests
       WHERE manifest_id = ? AND namespace = ?`
    ).bind(manifestId, namespace).first<HistoricalManifestRow>(),
    db.prepare(
      `SELECT manifest_id, namespace, lifecycle_cohort, relation_id,
              source_memory_id, target_memory_id, relation_type, strength,
              reason, relation_created_at, source_eligible, source_status,
              source_active_fact, source_type, source_updated_at,
              source_five_axis_revision, target_eligible, target_status,
              target_active_fact, target_type, target_updated_at,
              target_five_axis_revision, provenance_class
       FROM historical_relation_snapshots
       WHERE manifest_id = ? AND relation_id IN (${marks})
       ORDER BY relation_id`
    ).bind(manifestId, ...relationIds).all<HistoricalSnapshotRow>(),
    db.prepare(
      `SELECT relation_id, batch_id
       FROM historical_relation_reconfirmation_entries
       WHERE manifest_id = ? AND relation_id IN (${marks})`
    ).bind(manifestId, ...relationIds).all<{ relation_id: string; batch_id: string }>()
  ]);
  assertManifestVerified(manifest);
  if (manifest.namespace !== namespace) requestError("historical_y_manifest_namespace_mismatch", 409);
  if ((existingEntryResult.results ?? []).length > 0) {
    requestError("historical_y_relation_already_processed", 409);
  }
  const snapshots = snapshotResult.results ?? [];
  if (snapshots.length !== relationIds.length
    || snapshots.some((snapshot, index) => snapshot.relation_id !== relationIds[index])) {
    requestError("historical_y_snapshot_selection_mismatch", 409);
  }
  const endpointIds = [...new Set(snapshots.flatMap((snapshot) => [
    snapshot.source_memory_id,
    snapshot.target_memory_id
  ]))];
  const [records, relations] = await Promise.all([
    fetchMemoriesByIds(db, { namespace, ids: endpointIds }),
    Promise.all(snapshots.map((snapshot) => getMemoryRelationById(db, {
      namespace,
      id: snapshot.relation_id
    })))
  ]);
  const memories = new Map(records.map((record) => [record.id, record]));
  snapshots.forEach((snapshot, index) => assertSnapshotCurrent(
    snapshot,
    relations[index] ?? null,
    memories.get(snapshot.source_memory_id),
    memories.get(snapshot.target_memory_id)
  ));
  return { snapshots, memories };
}

const PROVENANCE_CLAIM_TYPES = new Set(["derived_from", "instance_of", "origin_split"]);

export function chooseHistoricalYDecision(
  snapshot: HistoricalSnapshotRow,
  hints: HistoricalYRelationHint[]
): HistoricalYDecision {
  const matchingHints = hints.filter((hint) => hint.pair_id === snapshot.relation_id);
  const exact = matchingHints.find(
    (hint) => normalizeRelationType(hint.relation_type) === snapshot.relation_type
  );
  const selected = exact ?? matchingHints[0];
  const normalizedType = selected
    ? normalizeRelationType(selected.relation_type).slice(0, 100)
    : "none";
  return {
    snapshot,
    proposedRelationType: normalizedType || "none",
    proposedStrength: selected ? selected.strength : null,
    exactMatch: Boolean(exact) && RECONFIRMABLE_TYPES.has(snapshot.relation_type),
    changeKind: !selected
      ? "missing_pair"
      : normalizedType === "none"
        ? "none_returned"
        : exact
          ? "exact_match"
          : "type_changed",
    provenanceClaim: PROVENANCE_CLAIM_TYPES.has(normalizedType)
  };
}

function exactSnapshotGuard(
  snapshot: HistoricalSnapshotRow,
  batchId: string
): { sql: string; binds: unknown[] } {
  const sourceEligible = fiveAxisMemoryEligibilityPredicate("source_memory");
  const targetEligible = fiveAxisMemoryEligibilityPredicate("target_memory");
  const provenance = relationProvenanceSql("relation");
  return {
    sql: `EXISTS (
      SELECT 1
      FROM historical_relation_reconfirmation_batches AS batch
      JOIN historical_relation_snapshots AS snapshot
        ON snapshot.manifest_id = batch.manifest_id
       AND snapshot.relation_id = ?
      JOIN historical_relation_manifests AS manifest
        ON manifest.manifest_id = snapshot.manifest_id
      JOIN memory_relations AS relation
        ON relation.namespace = snapshot.namespace
       AND relation.id = snapshot.relation_id
      JOIN memories AS source_memory
        ON source_memory.namespace = relation.namespace
       AND source_memory.id = relation.source_memory_id
      JOIN memories AS target_memory
        ON target_memory.namespace = relation.namespace
       AND target_memory.id = relation.target_memory_id
      WHERE batch.batch_id = ?
        AND batch.namespace = ?
        AND manifest.status = 'verified'
        AND manifest.lifecycle_cohort = 'eligible_unproven'
        AND snapshot.provenance_class = 'unproven_source'
        AND relation.source_memory_id = snapshot.source_memory_id
        AND relation.target_memory_id = snapshot.target_memory_id
        AND relation.relation_type = snapshot.relation_type
        AND relation.strength = snapshot.strength
        AND relation.reason IS snapshot.reason
        AND relation.created_at = snapshot.relation_created_at
        AND source_memory.status = snapshot.source_status
        AND source_memory.active_fact = snapshot.source_active_fact
        AND source_memory.type = snapshot.source_type
        AND source_memory.updated_at = snapshot.source_updated_at
        AND source_memory.five_axis_revision = snapshot.source_five_axis_revision
        AND target_memory.status = snapshot.target_status
        AND target_memory.active_fact = snapshot.target_active_fact
        AND target_memory.type = snapshot.target_type
        AND target_memory.updated_at = snapshot.target_updated_at
        AND target_memory.five_axis_revision = snapshot.target_five_axis_revision
        AND ${sourceEligible.sql}
        AND ${targetEligible.sql}
        AND ${provenance.unproven}
        AND NOT EXISTS (
          SELECT 1
          FROM historical_relation_reconfirmation_entries AS entry
          WHERE entry.manifest_id = snapshot.manifest_id
            AND entry.relation_id = snapshot.relation_id
        )
    )`,
    binds: [
      snapshot.relation_id,
      batchId,
      snapshot.namespace,
      ...sourceEligible.binds,
      ...targetEligible.binds
    ]
  };
}

function prepareBatchClaim(
  db: D1Database,
  input: {
    batchId: string;
    manifestId: string;
    namespace: string;
    relationIdsSha256: string;
    relationIds: string[];
    createdAt: string;
  }
): D1PreparedStatement {
  const marks = placeholders(input.relationIds.length);
  const sourceEligible = fiveAxisMemoryEligibilityPredicate("source_memory");
  const targetEligible = fiveAxisMemoryEligibilityPredicate("target_memory");
  const provenance = relationProvenanceSql("relation");
  const typeValues = HISTORICAL_Y_RECONFIRMABLE_RELATION_TYPES
    .map((value) => `'${value}'`)
    .join(", ");
  return db.prepare(
    `INSERT OR IGNORE INTO historical_relation_reconfirmation_batches (
       batch_id, manifest_id, namespace, lifecycle_cohort,
       relation_ids_sha256, relation_ids_json, relation_count, created_at
     )
     SELECT ?, ?, ?, 'eligible_unproven', ?, ?, ?, ?
     WHERE EXISTS (
       SELECT 1
       FROM historical_relation_manifests AS manifest
       WHERE manifest.manifest_id = ?
         AND manifest.namespace = ?
         AND manifest.lifecycle_cohort = 'eligible_unproven'
         AND manifest.status = 'verified'
         AND manifest.snapshot_relation_count = manifest.expected_relation_count
         AND manifest.verified_relations_sha256 = manifest.expected_relations_sha256
         AND manifest.verified_selection_sha256 = manifest.expected_selection_sha256
     )
       AND (
         SELECT COUNT(*)
         FROM historical_relation_snapshots AS snapshot
         JOIN memory_relations AS relation
           ON relation.namespace = snapshot.namespace
          AND relation.id = snapshot.relation_id
         JOIN memories AS source_memory
           ON source_memory.namespace = relation.namespace
          AND source_memory.id = relation.source_memory_id
         JOIN memories AS target_memory
           ON target_memory.namespace = relation.namespace
          AND target_memory.id = relation.target_memory_id
         WHERE snapshot.manifest_id = ?
           AND snapshot.relation_id IN (${marks})
           AND snapshot.lifecycle_cohort = 'eligible_unproven'
           AND snapshot.provenance_class = 'unproven_source'
           AND snapshot.source_eligible = 1
           AND snapshot.target_eligible = 1
           AND snapshot.relation_type IN (${typeValues})
           AND relation.source_memory_id = snapshot.source_memory_id
           AND relation.target_memory_id = snapshot.target_memory_id
           AND relation.relation_type = snapshot.relation_type
           AND relation.strength = snapshot.strength
           AND relation.reason IS snapshot.reason
           AND relation.created_at = snapshot.relation_created_at
           AND source_memory.status = snapshot.source_status
           AND source_memory.active_fact = snapshot.source_active_fact
           AND source_memory.type = snapshot.source_type
           AND source_memory.updated_at = snapshot.source_updated_at
           AND source_memory.five_axis_revision = snapshot.source_five_axis_revision
           AND target_memory.status = snapshot.target_status
           AND target_memory.active_fact = snapshot.target_active_fact
           AND target_memory.type = snapshot.target_type
           AND target_memory.updated_at = snapshot.target_updated_at
           AND target_memory.five_axis_revision = snapshot.target_five_axis_revision
           AND ${sourceEligible.sql}
           AND ${targetEligible.sql}
           AND ${provenance.unproven}
       ) = ?
       AND NOT EXISTS (
         SELECT 1
         FROM historical_relation_reconfirmation_entries AS entry
         WHERE entry.manifest_id = ?
           AND entry.relation_id IN (${marks})
       )`
  ).bind(
    input.batchId,
    input.manifestId,
    input.namespace,
    input.relationIdsSha256,
    JSON.stringify(input.relationIds),
    input.relationIds.length,
    input.createdAt,
    input.manifestId,
    input.namespace,
    input.manifestId,
    ...input.relationIds,
    ...sourceEligible.binds,
    ...targetEligible.binds,
    input.relationIds.length,
    input.manifestId,
    ...input.relationIds
  );
}

function prepareLedgerInsert(
  db: D1Database,
  batchId: string,
  decision: HistoricalYDecision,
  createdAt: string
): D1PreparedStatement {
  const expectedAfter = decision.exactMatch
    ? expectedPromotedReason(decision.snapshot)
    : decision.snapshot.reason;
  const outcomeSql = decision.exactMatch
    ? "CASE WHEN relation.reason IS ? THEN 'promoted' ELSE 'not_applied' END"
    : "'not_reconfirmed'";
  const outcomeBinds = decision.exactMatch ? [expectedAfter] : [];
  return db.prepare(
    `INSERT OR IGNORE INTO historical_relation_reconfirmation_entries (
       batch_id, manifest_id, namespace, relation_id, before_reason,
       proposed_relation_type, proposed_strength, outcome, after_reason, created_at
     )
     SELECT batch.batch_id, snapshot.manifest_id, snapshot.namespace,
            snapshot.relation_id, snapshot.reason, ?, ?, ${outcomeSql},
            relation.reason, ?
     FROM historical_relation_reconfirmation_batches AS batch
     JOIN historical_relation_snapshots AS snapshot
       ON snapshot.manifest_id = batch.manifest_id
      AND snapshot.relation_id = ?
     JOIN memory_relations AS relation
       ON relation.namespace = snapshot.namespace
      AND relation.id = snapshot.relation_id
     WHERE batch.batch_id = ?
       AND batch.namespace = ?
       AND (relation.reason IS snapshot.reason OR relation.reason IS ?)
       AND NOT EXISTS (
         SELECT 1
         FROM historical_relation_reconfirmation_entries AS existing
         WHERE existing.manifest_id = snapshot.manifest_id
           AND existing.relation_id = snapshot.relation_id
       )`
  ).bind(
    decision.proposedRelationType,
    decision.proposedStrength,
    ...outcomeBinds,
    createdAt,
    decision.snapshot.relation_id,
    batchId,
    decision.snapshot.namespace,
    expectedAfter
  );
}

async function applyDecisions(
  db: D1Database,
  input: {
    batchId: string;
    manifestId: string;
    namespace: string;
    relationIdsSha256: string;
    relationIds: string[];
    decisions: HistoricalYDecision[];
    createdAt: string;
  }
): Promise<void> {
  const statements: D1PreparedStatement[] = [prepareBatchClaim(db, input)];
  for (const decision of input.decisions) {
    if (decision.exactMatch) {
      const relation = prepareMemoryRelationInsert(db, {
        namespace: input.namespace,
        sourceMemoryId: decision.snapshot.source_memory_id,
        targetMemoryId: decision.snapshot.target_memory_id,
        relationType: decision.snapshot.relation_type,
        strength: decision.snapshot.strength,
        reason: relationProvenance.yAuto(
          decision.snapshot.source_memory_id,
          decision.snapshot.source_five_axis_revision
        )
      }, exactSnapshotGuard(decision.snapshot, input.batchId));
      if (!relation) requestError("historical_y_relation_statement_rejected", 409);
      statements.push(relation);
    }
    statements.push(prepareLedgerInsert(db, input.batchId, decision, input.createdAt));
  }
  await db.batch(statements);
}

export async function runHistoricalYReconfirmation(
  env: Env,
  namespace: string,
  options: {
    manifestId: string;
    relationIds: string[];
    dryRun?: boolean;
    confirm?: string;
  },
  dependencies: HistoricalYReconfirmationDependencies = defaultDependencies
): Promise<{
  schema_version: number;
  mode: "dry_run" | "apply" | "replay";
  batch_id: string;
  manifest_id: string;
  namespace: string;
  relation_count: number;
  promoted: number;
  not_reconfirmed: number;
  not_applied: number;
  entries: Array<HistoricalReconfirmationEntry | {
    relation_id: string;
    before_reason: string | null;
    proposed_relation_type: string;
    proposed_strength: number | null;
    outcome: "would_promote" | "not_reconfirmed";
    after_reason: string | null;
    change_kind: "exact_match" | "type_changed" | "none_returned" | "missing_pair";
    provenance_claim: boolean;
    review_evidence: {
      original_relation_type: string;
      original_strength: number;
      source: {
        id: string;
        type: string;
        status: string;
        active_fact: number;
        five_axis_revision: number;
        created_at: string;
        content_excerpt: string;
      };
      target: {
        id: string;
        type: string;
        status: string;
        active_fact: number;
        five_axis_revision: number;
        created_at: string;
        content_excerpt: string;
      };
    };
  }>;
}> {
  const manifestId = options.manifestId.trim();
  if (!/^hrg_[0-9a-f]{32}$/.test(manifestId)) {
    requestError("historical_y_manifest_id_invalid");
  }
  const relationIds = normalizeHistoricalYRelationIds(options.relationIds);
  if (relationIds.length < 1 || relationIds.length > MAX_RELATIONS_PER_BATCH) {
    requestError(`historical_y_relation_count_must_be_1_to_${MAX_RELATIONS_PER_BATCH}`);
  }
  if (relationIds.some((id) => id.length > 200)) {
    requestError("historical_y_relation_id_too_long");
  }
  const dryRun = options.dryRun ?? true;
  if (!dryRun && options.confirm !== manifestId) {
    requestError("historical_y_apply_confirmation_mismatch");
  }
  const canonicalBatch = canonicalHistoricalYBatch(manifestId, relationIds);
  const relationIdsSha256 = await sha256Hex(canonicalBatch);
  const batchId = historicalYBatchIdFromSha256(relationIdsSha256);
  const stored = await loadStoredBatch(env.DB, {
    batchId,
    manifestId,
    namespace,
    relationIdsSha256,
    relationIds
  });
  if (stored) {
    return {
      schema_version: HISTORICAL_Y_RECONFIRMATION_SCHEMA_VERSION,
      mode: "replay",
      batch_id: batchId,
      manifest_id: manifestId,
      namespace,
      relation_count: relationIds.length,
      promoted: stored.entries.filter((entry) => entry.outcome === "promoted").length,
      not_reconfirmed: stored.entries.filter((entry) => entry.outcome === "not_reconfirmed").length,
      not_applied: stored.entries.filter((entry) => entry.outcome === "not_applied").length,
      entries: stored.entries
    };
  }

  const { snapshots, memories } = await loadPreflight(
    env.DB,
    namespace,
    manifestId,
    relationIds
  );
  const candidates: RelationCandidate[] = snapshots.map((snapshot) => ({
    pairId: snapshot.relation_id,
    source: memories.get(snapshot.source_memory_id)!,
    target: memories.get(snapshot.target_memory_id)!,
    // Historical pairs are exact manifest rows, not vector-ranked discoveries.
    // RelationCandidate still requires this field; the historical proposer does not use it.
    vectorScore: Number(snapshot.strength)
  }));
  const proposal = await dependencies.proposeRelations(
    env,
    candidates,
    env.HISTORICAL_Y_RECONFIRM_MODEL
  );
  if (proposal.error) {
    requestError(`historical_y_model_error:${proposal.error}`, 502);
  }
  const decisions = snapshots.map((snapshot) => chooseHistoricalYDecision(snapshot, proposal.hints));
  const dryEntries = decisions.map((decision) => ({
    relation_id: decision.snapshot.relation_id,
    before_reason: decision.snapshot.reason,
    proposed_relation_type: decision.proposedRelationType,
    proposed_strength: decision.proposedStrength,
    outcome: decision.exactMatch ? "would_promote" as const : "not_reconfirmed" as const,
    after_reason: decision.exactMatch
      ? expectedPromotedReason(decision.snapshot)
      : decision.snapshot.reason,
    change_kind: decision.changeKind,
    provenance_claim: decision.provenanceClaim,
    review_evidence: {
      original_relation_type: decision.snapshot.relation_type,
      original_strength: Number(decision.snapshot.strength),
      source: {
        id: decision.snapshot.source_memory_id,
        type: decision.snapshot.source_type,
        status: decision.snapshot.source_status,
        active_fact: decision.snapshot.source_active_fact,
        five_axis_revision: decision.snapshot.source_five_axis_revision,
        created_at: memories.get(decision.snapshot.source_memory_id)!.created_at,
        content_excerpt: historicalYContentExcerpt(
          memories.get(decision.snapshot.source_memory_id)!
        )
      },
      target: {
        id: decision.snapshot.target_memory_id,
        type: decision.snapshot.target_type,
        status: decision.snapshot.target_status,
        active_fact: decision.snapshot.target_active_fact,
        five_axis_revision: decision.snapshot.target_five_axis_revision,
        created_at: memories.get(decision.snapshot.target_memory_id)!.created_at,
        content_excerpt: historicalYContentExcerpt(
          memories.get(decision.snapshot.target_memory_id)!
        )
      }
    }
  }));
  if (dryRun) {
    return {
      schema_version: HISTORICAL_Y_RECONFIRMATION_SCHEMA_VERSION,
      mode: "dry_run",
      batch_id: batchId,
      manifest_id: manifestId,
      namespace,
      relation_count: relationIds.length,
      promoted: dryEntries.filter((entry) => entry.outcome === "would_promote").length,
      not_reconfirmed: dryEntries.filter((entry) => entry.outcome === "not_reconfirmed").length,
      not_applied: 0,
      entries: dryEntries
    };
  }

  const createdAt = dependencies.now();
  await applyDecisions(env.DB, {
    batchId,
    manifestId,
    namespace,
    relationIdsSha256,
    relationIds,
    decisions,
    createdAt
  });
  const applied = await loadStoredBatch(env.DB, {
    batchId,
    manifestId,
    namespace,
    relationIdsSha256,
    relationIds
  });
  if (!applied) requestError("historical_y_batch_drift_rejected", 409);
  return {
    schema_version: HISTORICAL_Y_RECONFIRMATION_SCHEMA_VERSION,
    mode: "apply",
    batch_id: batchId,
    manifest_id: manifestId,
    namespace,
    relation_count: relationIds.length,
    promoted: applied.entries.filter((entry) => entry.outcome === "promoted").length,
    not_reconfirmed: applied.entries.filter((entry) => entry.outcome === "not_reconfirmed").length,
    not_applied: applied.entries.filter((entry) => entry.outcome === "not_applied").length,
    entries: applied.entries
  };
}
