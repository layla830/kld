#!/usr/bin/env node
// Bundles legacy-relations-audit.mjs + its TS imports via esbuild, then runs it.
// This avoids copying production logic into the test: the test imports the real
// filterLegacyProposals / runLegacyRelationBackfill from src.
import { build } from "esbuild";
import { createRequire } from "node:module";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const tmpDir = path.join(here, ".tmp-audit");
const outFile = path.join(tmpDir, "legacy-relations-audit.bundle.mjs");

try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
mkdirSync(tmpDir, { recursive: true });

await build({
  entryPoints: [path.join(here, "legacy-relations-audit.mjs")],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  outfile: outFile,
  // @cloudflare/workers-types is types-only; keep it external (it won't be in the bundle)
  external: ["@cloudflare/workers-types"],
  logLevel: "warning"
});

const { spawnSync } = await import("node:child_process");
const result = spawnSync(process.execPath, [outFile], { stdio: "inherit", cwd: here });
process.exitCode = result.status ?? 0;
