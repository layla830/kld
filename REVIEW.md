# Code Review Status

Updated: 2026-07-17

This file tracks the quick review that originally focused on running this Worker without Cloudflare AI Gateway as the default path. It is now a status note rather than a list of still-open findings.

## Fixed

### Direct OpenAI-compatible upstream

Fixed in PR #38.

The OpenAI-compatible chat and embedding paths now prefer:

```env
UPSTREAM_BASE_URL=https://api.example.com/v1
UPSTREAM_API_KEY=sk-xxx
```

Requests use normal OpenAI-compatible URLs and `Authorization: Bearer ...`. Cloudflare AI Gateway remains available as a legacy/provider mode through `AI_GATEWAY_BASE_URL` and `CF_AIG_TOKEN`.

### Health check no longer requires AI Gateway

Fixed in PR #38.

`/health` accepts either direct upstream mode (`UPSTREAM_BASE_URL + UPSTREAM_API_KEY`) or Cloudflare AI Gateway mode (`AI_GATEWAY_BASE_URL + CF_AIG_TOKEN`), plus the core client key configuration.

### URL token boundary

Fixed in PR #40.

URL `?token=` auth is restricted to `/mcp` and `/memory-mcp`. Other API calls should use `Authorization: Bearer ...` or `x-api-key`.

### Cache namespace isolation

Fixed in PR #40.

Cache access is now limited to the caller namespace unless the profile is debug/admin-level.

### Queue fallback

Fixed in PR #41.

When `MEMORY_QUEUE` is missing, queue work is no longer run inline by default. Local/dev fallback requires:

```env
ALLOW_QUEUE_FALLBACK=true
```

Otherwise the Worker logs a warning and skips the background queue message instead of dragging heavy work into the request path.

### Anthropic image conversion

Fixed in PR #44.

OpenAI-style `image_url` data URLs are converted into Anthropic native image blocks. Unknown structured content and remote image URLs remain visible as text fallback instead of being silently dropped.

## Deliberately Deferred

### Admin board password fallback

The original review recommended using only `ADMIN_PASSWORD` for the admin board. PR #40 implemented that, but it broke the current deployed admin login because production did not yet have `ADMIN_PASSWORD` configured.

PR #43 restored the compatibility fallback:

```ts
ADMIN_PASSWORD || MEMORY_MCP_API_KEY
```

Recommended follow-up:

1. Add a dedicated `ADMIN_PASSWORD` secret in Cloudflare.
2. Confirm the admin page accepts that password.
3. Remove the `MEMORY_MCP_API_KEY` fallback in a later PR.

## Current Verification

The repository-level verification for the current code is:

```bash
npm run typecheck
npm run types:check
npm test
npm run test:lmc5-circuits
```

README wording, historical assembler phase comments, and per-deployment production smoke checks are no longer tracked as open findings in this historical review note. Deployment health belongs to the build/deploy run and its production verification record.
