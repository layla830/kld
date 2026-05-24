import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

const secrets = {};

for (const name of ["CHATBOX_API_KEY", "IM_API_KEY", "DEBUG_API_KEY", "UPSTREAM_API_KEY", "CF_AIG_TOKEN"]) {
  const value = process.env[name];
  if (value) secrets[name] = value;
}

if (!secrets.CHATBOX_API_KEY) {
  throw new Error("Missing required GitHub secret: CHATBOX_API_KEY");
}

if (!secrets.UPSTREAM_API_KEY && !secrets.CF_AIG_TOKEN) {
  throw new Error("Missing upstream secret: set UPSTREAM_API_KEY or CF_AIG_TOKEN");
}

writeFileSync(resolve(".wrangler-secrets.json"), JSON.stringify(secrets, null, 2));
console.log(`Prepared ${Object.keys(secrets).length} Worker secrets.`);
