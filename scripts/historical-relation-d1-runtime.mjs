import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";

const WRANGLER_FILE_PACKAGE_ENV
  = "HISTORICAL_RELATION_WRANGLER_FILE_PACKAGE";

function repositoryWranglerEntry() {
  return path.join(
    process.cwd(),
    "node_modules",
    "wrangler",
    "bin",
    "wrangler.js"
  );
}

export function resolveHistoricalRelationWranglerInvocation(
  environment = process.env,
  useFilePackage = false
) {
  const packageName = useFilePackage
    ? String(environment[WRANGLER_FILE_PACKAGE_ENV] ?? "").trim()
    : "";
  if (!packageName) {
    return {
      command: process.execPath,
      prefixArgs: [repositoryWranglerEntry()]
    };
  }
  if (!/^wrangler@\d+\.\d+\.\d+$/.test(packageName)) {
    throw new Error(
      `${WRANGLER_FILE_PACKAGE_ENV} must be an exact wrangler@x.y.z version.`
    );
  }
  const npmExecPath = String(environment.npm_execpath ?? "").trim();
  if (!npmExecPath) {
    throw new Error(
      `${WRANGLER_FILE_PACKAGE_ENV} requires npm_execpath; run through npm.`
    );
  }
  return {
    command: process.execPath,
    prefixArgs: [
      path.join(path.dirname(npmExecPath), "npx-cli.js"),
      "--yes",
      packageName
    ]
  };
}

function parseWranglerJson(stdout) {
  const text = stdout.trim();
  if (!text) return [];
  try {
    return JSON.parse(text);
  } catch {
    const firstJson = text.indexOf("[");
    if (firstJson >= 0) return JSON.parse(text.slice(firstJson));
    throw new Error(`Could not parse wrangler JSON output: ${text.slice(0, 500)}`);
  }
}

function extractExecution(response) {
  const entries = Array.isArray(response) ? response : [];
  return {
    rows: entries.flatMap((item) => item?.results ?? []),
    changes: entries.reduce(
      (total, item) => total + Number(item?.meta?.changes ?? 0),
      0
    ),
    rowsWritten: entries.reduce(
      (total, item) => total + Number(item?.meta?.rows_written ?? 0),
      0
    )
  };
}

function executeWrangler(args, extraArgs, name, useFilePackage = false) {
  const invocation = resolveHistoricalRelationWranglerInvocation(
    process.env,
    useFilePackage
  );
  const result = spawnSync(invocation.command, [
    ...invocation.prefixArgs,
    "d1",
    "execute",
    args.db,
    "--remote",
    "--json",
    ...extraArgs
  ], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      WRANGLER_LOG_PATH: path.join(
        process.cwd(),
        ".wrangler",
        "historical-relation-governance.log"
      )
    },
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 32 * 1024 * 1024
  });
  if (result.status !== 0) {
    throw new Error(
      `historical relation command failed (${name}):\n`
      + `${result.error ? `${result.error.message}\n` : ""}`
      + `${result.stderr || result.stdout || "No output"}`
    );
  }
  return extractExecution(parseWranglerJson(result.stdout));
}

export function executeHistoricalRelationQuery(args, query) {
  return executeWrangler(args, ["--command", query.sql], query.name);
}

export function executeHistoricalRelationSqlFile(
  args,
  sql,
  name = "historical_relation_batch"
) {
  const auditDir = path.join(process.cwd(), ".audit");
  fs.mkdirSync(auditDir, { recursive: true });
  const sqlPath = path.join(
    auditDir,
    `historical-relation-${randomUUID()}.sql`
  );
  try {
    fs.writeFileSync(sqlPath, sql, { encoding: "utf8", flag: "wx" });
    return executeWrangler(
      args,
      ["--file", sqlPath, "--yes"],
      name,
      true
    );
  } finally {
    if (fs.existsSync(sqlPath)) fs.rmSync(sqlPath);
  }
}
