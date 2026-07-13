import { describe, expect, it } from "vitest";
import { runFiveAxisNightlyMaintenance, type FiveAxisNightlyDependencies } from "../src/memory/fiveAxis/nightly";
import type { Env } from "../src/types";

describe("five-axis nightly orchestration", () => {
  it("preserves the review-safe Y then Z then M order and forwards dry-run options", async () => {
    const calls: string[] = [];
    const dependencies: FiveAxisNightlyDependencies = {
      runRelations: async (_env, namespace, options) => {
        calls.push(`Y:${namespace}:${options?.dryRun}:${options?.sinceIso}`);
        return { scanned: 2, inserted: 0, review: 1, proposed: 1, candidates: 3 };
      },
      runFactAudit: async (_env, namespace, options) => {
        calls.push(`Z:${namespace}:${options?.dryRun}`);
        return { conflicts: 1, queued: 1, events: 0 };
      },
      runMetabolism: async (_env, namespace, options) => {
        calls.push(`M:${namespace}:${options?.dryRun}`);
        return { suggestions: 0, events: 0 };
      }
    };

    const result = await runFiveAxisNightlyMaintenance(
      {} as Env,
      "default",
      { dryRun: true, sinceIso: "2026-07-12T00:00:00.000Z" },
      dependencies
    );

    expect(calls).toEqual([
      "Y:default:true:2026-07-12T00:00:00.000Z",
      "Z:default:true",
      "M:default:true"
    ]);
    expect(result).toEqual({
      relations: { scanned: 2, inserted: 0, review: 1, proposed: 1, candidates: 3 },
      zAudit: { conflicts: 1, queued: 1, events: 0 },
      patrol: { suggestions: 0, events: 0 }
    });
  });
});
