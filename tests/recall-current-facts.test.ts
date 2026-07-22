import { describe, expect, it } from "vitest";
import {
  listActiveMemoriesByFactKeys,
  listGuidanceSeedMemories,
  searchMemoriesByText
} from "../src/db/memories";
import { searchEmotionMemories } from "../src/recall/sources/emotion";
import { isRecallEligible, TIMELINE_DAY_CONTENT_TAG } from "../src/recall/outputPolicy";
import type { Env } from "../src/types";

function sqlCapture() {
  const sql: string[] = [];
  const db = {
    prepare(statement: string) {
      sql.push(statement);
      return {
        bind() {
          return {
            all: async () => ({ results: [] })
          };
        }
      };
    }
  } as unknown as D1Database;
  return { db, sql };
}

describe("current-fact recall contract", () => {
  it("filters inactive facts in every D1 recall source", async () => {
    const state = sqlCapture();

    await searchMemoriesByText(state.db, {
      namespace: "default",
      query: "KLD",
      limit: 5
    });
    await listActiveMemoriesByFactKeys(state.db, {
      namespace: "default",
      factKeys: ["project:kld"],
      limit: 5
    });
    await listGuidanceSeedMemories(state.db, {
      namespace: "default",
      limit: 5
    });
    await searchEmotionMemories({ DB: state.db } as Env, "default", "我很难过", 4);

    expect(state.sql).toHaveLength(4);
    for (const statement of state.sql) expect(statement).toContain("active_fact != 0");
  });

  it("keeps a final eligibility guard for vector and future recall sources", () => {
    expect(isRecallEligible({ type: "project_state", status: "active", active_fact: 1 })).toBe(true);
    expect(isRecallEligible({ type: "project_state", status: "active", active_fact: 0 })).toBe(false);
    expect(isRecallEligible({ type: "project_state", status: "superseded", active_fact: 1 })).toBe(false);
    expect(isRecallEligible({ type: "diary", status: "active", active_fact: 1 })).toBe(false);
    expect(isRecallEligible({
      type: "timeline_day", status: "active", active_fact: 1, tags: [TIMELINE_DAY_CONTENT_TAG]
    })).toBe(true);
    expect(isRecallEligible({
      type: "timeline_day", status: "active", active_fact: 1, tags: ["timeline_day_fallback:verbatim"]
    })).toBe(false);
  });
});
