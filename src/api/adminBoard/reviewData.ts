import type { Env, MemoryRecord } from "../../types";
import { like, PAGE_SIZE, type PageInput } from "./utils";

export async function fetchDreamReviewMemories(env: Env, input: PageInput): Promise<{ total: number; records: MemoryRecord[] }> {
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

  return { total: total?.count ?? 0, records: result.results ?? [] };
}
