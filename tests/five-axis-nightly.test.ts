import { describe, expect, it } from "vitest";
import { runFiveAxisNightlyMaintenance, type FiveAxisNightlyDependencies } from "../src/memory/fiveAxis/nightly";
import type { Env } from "../src/types";

describe("five-axis nightly orchestration", () => {
  it("runs Y once and consolidates Z/M into the operational review scan", async () => {
    const calls: string[] = [];
    const dependencies: FiveAxisNightlyDependencies = {
      runRelations: async (_env, namespace, options) => {
        calls.push(`Y:${namespace}:${options?.dryRun}:${options?.sinceIso}`);
        return { scanned: 2, inserted: 0, review: 1, proposed: 1, candidates: 3 };
      },
      scanOperational: async (_env, namespace, options) => {
        calls.push(`Z/M:${namespace}:${options?.dryRun}`);
        return {
          z: { conflicts: 1, candidates: 1 },
          m: { archive: 0, relations: 0 }
        };
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
      "Z/M:default:true"
    ]);
    expect(result).toEqual({
      relations: { scanned: 2, inserted: 0, review: 1, proposed: 1, candidates: 3 },
      operationalReview: {
        z: { conflicts: 1, candidates: 1 },
        m: { archive: 0, relations: 0 }
      }
    });
  });
});
