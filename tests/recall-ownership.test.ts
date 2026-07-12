import { describe, expect, it } from "vitest";
import fixtures from "../fixtures/recall-ownership.json";
import { analyzeRecallNeed } from "../src/memory/recallIntent";

interface RecallOwnershipFixture {
  name: string;
  prompt: string;
  expected_owner: "worker" | "local" | "none";
  worker_should_recall: boolean;
}

describe("shared VPS and Worker recall ownership contract", () => {
  for (const fixture of fixtures as RecallOwnershipFixture[]) {
    it(fixture.name, () => {
      expect(analyzeRecallNeed(fixture.prompt).shouldRecall).toBe(fixture.worker_should_recall);
    });
  }
});
