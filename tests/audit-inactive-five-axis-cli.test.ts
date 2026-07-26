import { describe, expect, it } from "vitest";
import { parseAuditArgs, usage } from "../scripts/audit-inactive-five-axis.mjs";

describe("inactive five-axis audit CLI", () => {
  it("has only an explicit remote read-only mode", () => {
    expect(() => parseAuditArgs([])).toThrow("--remote is required");
    expect(() => parseAuditArgs(["--remote", "--fix"])).toThrow("Unknown argument: --fix");
    expect(() => parseAuditArgs(["--remote", "--apply"])).toThrow("Unknown argument: --apply");
    expect(parseAuditArgs(["--remote", "--namespace", "default", "--json"]))
      .toMatchObject({ remote: true, namespace: "default", json: true });
    expect(usage()).toContain("no fix, delete, repair, or apply mode");
  });
});
