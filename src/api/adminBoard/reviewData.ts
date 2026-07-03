import type { Env, MemoryRecord } from "../../types";
import { like, PAGE_SIZE, type PageInput } from "./utils";

export type DreamReviewMemoryRecord = MemoryRecord & { review_target?: MemoryRecord | null };

function reviewTargetId(record: MemoryRecord): string | null {
  if (!record.summary) return null;
  try {
    const parsed = JSON.parse(record.summary) as { kind?: string; target_id?: string };
    return parsed.kind === "dream_review" && typeof parsed.target_id === "string" ? parsed.target_id : null;
  } catch {
    return null;
  }
}

export async function fetchDreamReviewMemories(env: Env, input: PageInput): Promise<{ total: number; records: DreamReviewMemoryRecord[] }> {
  let where = "WHERE namespace = 'default' AND type = ?";
  const binds: unknown[] = ["dream_review"];

  if (input.status !== "all") {
    where += " AND status = ?";
    binds.push(input.status);
  }
  if (input.status === "active") {
    where += " AND tags LIKE ? ESCAPE '\\'";
    binds.push(like("pending-review"));
  }
  if (input.q) {
    const pattern = like(input.q);
    where += " AND (content LIKE ? ESCAPE '\\' OR summary LIKE ? ESCAPE '\\' OR id LIKE ? ESCAPE '\\')";
    binds.push(pattern, pattern, pattern);
  }

  const offset = (input.page - 1) * PAGE_SIZE;
  const [total, result] = await Promise.all([
    env.DB.prepare(`SELECT COUNT(*) AS count FROM memories ${where}`).bind(...binds).first<{ count: number }>(),
    env.DB.prepare(`SELECT * FROM memories ${where} ORDER BY created_at DESC, updated_at DESC LIMIT ? OFFSET ?`).bind(...binds, PAGE_SIZE, offset).all<MemoryRecord>()
  ]);

  const records: DreamReviewMemoryRecord[] = result.results ?? [];
  const targetIds = [...new Set(records.map(reviewTargetId).filter((id): id is string => Boolean(id)))];
  if (targetIds.length === 0) return { total: total?.count ?? 0, records };

  const placeholders = targetIds.map(() => "?").join(",");
  const targets = await env.DB.prepare(`SELECT * FROM memories WHERE namespace = 'default' AND id IN (${placeholders})`)
    .bind(...targetIds)
    .all<MemoryRecord>();
  const byId = new Map((targets.results ?? []).map((target) => [target.id, target]));
  for (const record of records) {
    const targetId = reviewTargetId(record);
    record.review_target = targetId ? byId.get(targetId) ?? null : null;
  }
  return { total: total?.count ?? 0, records };
}

