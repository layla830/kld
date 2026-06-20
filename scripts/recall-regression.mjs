#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { connect as tlsConnect } from "node:tls";
import { connect as netConnect } from "node:net";
import { URL } from "node:url";

const DEFAULT_API_URL = "https://kld.yuxin2247.workers.dev";
const DEFAULT_REPORT_PATH = "scripts/recall_regression_report.json";

function usage() {
  console.log(`Usage:
  node scripts/recall-regression.mjs
  node scripts/recall-regression.mjs --api-key <key>
  node scripts/recall-regression.mjs --api-url <url> --api-key <key>

Options:
  --api-url <url>   Worker base URL. Default: ${DEFAULT_API_URL}
  --api-key <key>   API key. Defaults to KLD_API_KEY or MEMORY_MCP_API_KEY.
  --top-k <n>       top_k per query. Default: 5.
  --report <path>   Report JSON output path. Default: ${DEFAULT_REPORT_PATH}
  --help, -h        Show this help.
`);
}

function parseArgs(argv) {
  const args = {
    apiUrl: process.env.KLD_API_URL || DEFAULT_API_URL,
    apiKey: process.env.KLD_API_KEY || process.env.MEMORY_MCP_API_KEY || "",
    topK: 5,
    reportPath: DEFAULT_REPORT_PATH,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--help" || a === "-h") { usage(); process.exit(0); }
    else if (a === "--api-url") args.apiUrl = argv[++i];
    else if (a === "--api-key") args.apiKey = argv[++i];
    else if (a === "--top-k") args.topK = Number(argv[++i]);
    else if (a === "--report") args.reportPath = argv[++i];
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (!args.apiKey) {
    console.error("Error: --api-key or KLD_API_KEY/MEMORY_MCP_API_KEY env required.");
    process.exit(2);
  }
  return args;
}

const TESTS = [
  {
    name: "angry-how-to-comfort",
    query: "她生气了怎么哄",
    expectTop1FactKey: "relationship.rule.comfort_when_crying",
    expectTop1Type: "lesson",
    expectTop1NotType: ["diary", "timeline_day", "layla_diary"],
    expectTop3NotType: ["diary", "timeline_day"],
    rationale: "guidance + boundaries; rule must lead, diary must not",
  },
  {
    name: "cold-war",
    query: "她冷战怎么办",
    expectTop1FactKey: "relationship.lesson.cold_war_absence",
    expectTop1Type: "lesson",
    expectTop1NotType: ["diary", "timeline_day", "layla_diary"],
    expectTop3NotType: ["diary", "timeline_day"],
    rationale: "guidance + cold_war thread; cold_war_absence must lead",
  },
  {
    name: "says-this-kind-of-thing",
    query: "她怎么说这种话",
    expectTop1Type: "quote",
    expectTop1NotType: ["diary", "timeline_day", "layla_diary", "lesson"],
    expectTop3NotType: ["timeline_day"],
    rationale: "utterance (怎么说 hits UTTERANCE_RE not GUIDANCE_RE after 652030d); quote must lead via utteranceLeadFirst",
  },
  {
    name: "what-do-you-think-of-me",
    query: "你怎么想我",
    expectTop1NotType: ["diary", "timeline_day", "layla_diary"],
    expectTop3NotType: ["timeline_day"],
    rationale: "general intent; bd47a9a rerank must suppress timeline_day from top; rule/lesson should lead",
  },
];

async function httpPostJson(url, body, { timeoutMs = 60000 } = {}) {
  const target = new URL(url);
  const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.https_proxy || process.env.http_proxy;
  const bodyBytes = Buffer.from(body, "utf8");
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": String(bodyBytes.length),
    Host: target.host,
  };

  let socket;
  if (proxyUrl) {
    const proxy = new URL(proxyUrl);
    socket = await new Promise((resolve, reject) => {
      const sock = netConnect({ host: proxy.hostname, port: Number(proxy.port) || 80 }, () => {
        sock.write(`CONNECT ${target.host}:443 HTTP/1.1\r\nHost: ${target.host}:443\r\nProxy-Connection: keep-alive\r\n\r\n`);
      });
      sock.once("data", (chunk) => {
        const text = chunk.toString();
        if (/^HTTP\/1\.[01] 200/.test(text)) {
          const tlsSock = tlsConnect({ socket: sock, servername: target.hostname });
          tlsSock.once("secureConnect", () => resolve(tlsSock));
          tlsSock.once("error", reject);
        } else {
          reject(new Error(`Proxy CONNECT failed: ${text.split("\r\n")[0]}`));
        }
      });
      sock.once("error", reject);
    });
  } else {
    socket = await new Promise((resolve, reject) => {
      const sock = tlsConnect({ host: target.hostname, port: 443, servername: target.hostname });
      sock.once("secureConnect", () => resolve(sock));
      sock.once("error", reject);
    });
  }

  const path = target.pathname + target.search;
  const req = `POST ${path} HTTP/1.1\r\nHost: ${target.host}\r\n${Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join("\r\n")}\r\nConnection: close\r\n\r\n`;
  socket.write(req);
  socket.write(bodyBytes);

  const chunks = [];
  const timer = setTimeout(() => { socket.destroy(new Error("timeout")); }, timeoutMs);
  await new Promise((resolve, reject) => {
    socket.on("data", (c) => chunks.push(c));
    socket.on("end", resolve);
    socket.on("error", reject);
  }).finally(() => clearTimeout(timer));

  const buf = Buffer.concat(chunks);
  const headerEnd = buf.indexOf("\r\n\r\n");
  if (headerEnd === -1) throw new Error("Malformed HTTP response: no header terminator");
  const headerText = buf.slice(0, headerEnd).toString("utf8");
  const statusLine = headerText.split("\r\n")[0];
  const status = Number(statusLine.split(" ")[1]);
  let bodyText = buf.slice(headerEnd + 4).toString("utf8");
  const transferEncoding = headerText.match(/transfer-encoding:\s*chunked/i);
  if (transferEncoding) {
    const decoded = [];
    let pos = 0;
    while (pos < bodyText.length) {
      const lineEnd = bodyText.indexOf("\r\n", pos);
      if (lineEnd === -1) break;
      const size = parseInt(bodyText.slice(pos, lineEnd), 16);
      if (!size) break;
      decoded.push(bodyText.slice(lineEnd + 2, lineEnd + 2 + size));
      pos = lineEnd + 2 + size + 2;
    }
    bodyText = decoded.join("");
  }
  if (status >= 400) throw new Error(`HTTP ${status}: ${bodyText.slice(0, 200)}`);
  return bodyText;
}

async function callRetrieveMemory(apiUrl, apiKey, query, topK) {
  const url = `${apiUrl}/mcp?token=${encodeURIComponent(apiKey)}`;
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "retrieve_memory", arguments: { query, top_k: topK } },
  });
  const text = await httpPostJson(url, body);
  const json = JSON.parse(text);
  if (json.error) throw new Error(`JSON-RPC error: ${JSON.stringify(json.error)}`);
  const inner = json.result?.content?.[0]?.text;
  if (!inner) throw new Error("Empty result text");
  const parsed = JSON.parse(inner);
  return parsed.data || [];
}

function checkExpectations(test, results) {
  const failures = [];
  const warnings = [];
  if (!results.length) {
    failures.push("no results returned");
    return { failures, warnings, top1: null };
  }
  const top1 = results[0];
  if (test.expectTop1FactKey && top1.fact_key !== test.expectTop1FactKey) {
    failures.push(`top1.fact_key expected "${test.expectTop1FactKey}", got "${top1.fact_key || "-"}"`);
  }
  if (test.expectTop1Type && top1.type !== test.expectTop1Type) {
    failures.push(`top1.type expected "${test.expectTop1Type}", got "${top1.type}"`);
  }
  if (test.expectTop1NotType && test.expectTop1NotType.includes(top1.type)) {
    failures.push(`top1.type "${top1.type}" must not lead (expected non-${test.expectTop1NotType.join("/")})`);
  }
  if (test.expectTop3NotType) {
    const top3 = results.slice(0, 3);
    for (let i = 0; i < top3.length; i += 1) {
      if (test.expectTop3NotType.includes(top3[i].type)) {
        failures.push(`top${i + 1}.type "${top3[i].type}" must not be in top3`);
      }
    }
  }
  return { failures, warnings, top1 };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log(`Recall regression against ${args.apiUrl} (top_k=${args.topK})`);
  console.log(`${"=".repeat(70)}`);

  const report = { timestamp: new Date().toISOString(), apiUrl: args.apiUrl, topK: args.topK, results: [], summary: { total: 0, passed: 0, failed: 0 } };

  for (const test of TESTS) {
    let results;
    try {
      results = await callRetrieveMemory(args.apiUrl, args.apiKey, test.query, args.topK);
    } catch (err) {
      console.log(`FAIL  ${test.name}: ${err.message}`);
      report.results.push({ name: test.name, query: test.query, status: "error", error: err.message, rationale: test.rationale });
      report.summary.total += 1;
      report.summary.failed += 1;
      continue;
    }
    const { failures, warnings, top1 } = checkExpectations(test, results);
    const passed = failures.length === 0;
    report.summary.total += 1;
    if (passed) report.summary.passed += 1; else report.summary.failed += 1;

    console.log(`${passed ? "PASS" : "FAIL"}  ${test.name}  (query: ${test.query})`);
    console.log(`      rationale: ${test.rationale}`);
    if (top1) {
      console.log(`      top1: [${top1.id?.slice(0, 12)}] type=${top1.type} fk=${top1.fact_key || "-"} thread=${top1.thread || "-"}`);
    }
    results.slice(0, 3).forEach((m, i) => {
      console.log(`      top${i + 1}: type=${m.type} fk=${m.fact_key || "-"} ${(m.content || "").slice(0, 60).replace(/\n/g, " ")}`);
    });
    if (failures.length) {
      failures.forEach((f) => console.log(`      ✗ ${f}`));
    }
    console.log("");
    report.results.push({
      name: test.name,
      query: test.query,
      status: passed ? "passed" : "failed",
      rationale: test.rationale,
      expectations: {
        expectTop1FactKey: test.expectTop1FactKey || null,
        expectTop1Type: test.expectTop1Type || null,
        expectTop1NotType: test.expectTop1NotType || null,
        expectTop3NotType: test.expectTop3NotType || null,
      },
      top1: top1 ? { id: top1.id, type: top1.type, fact_key: top1.fact_key || null, thread: top1.thread || null } : null,
      topResults: results.slice(0, 3).map((m) => ({ id: m.id, type: m.type, fact_key: m.fact_key || null, thread: m.thread || null, content_preview: (m.content || "").slice(0, 120) })),
      failures,
      warnings,
    });
  }

  console.log(`${"=".repeat(70)}`);
  console.log(`Summary: ${report.summary.passed}/${report.summary.total} passed, ${report.summary.failed} failed`);

  writeFileSync(args.reportPath, JSON.stringify(report, null, 2), "utf8");
  console.log(`Report written to ${args.reportPath}`);
  process.exit(report.summary.failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
