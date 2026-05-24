# Code Review Status

Updated: 2026-05-24

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

## Still Open

### README is stale

The README still describes AI Gateway as the main required setup in some places and has older memory filter defaults. It should be updated to make direct upstream mode the default deployment path.

### Some assembler comments are stale

A few comments still mention later integration phases even though the assembler is already wired into the main chat path. This is low-risk documentation cleanup.

### Deployment verification still needed

These fixes were made through GitHub and reviewed by diff. A deployment verification pass should still check:

```bash
npm run typecheck
npm run dev
```

Then test non-streaming chat, streaming chat, memory recall, MCP, admin login, and image requests against the deployed Worker.
