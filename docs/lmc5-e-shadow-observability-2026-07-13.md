# LMC-5 E-axis shadow observability — 2026-07-13

## Outcome

E-axis ranking can now be evaluated in production without changing the ranking served to callers.

For every hybrid recall candidate set, the Worker computes two orders from the same already-fetched records:

1. baseline order with the existing non-E score;
2. hypothetical order with the existing E-axis `rule` / `tension_score` / `risk_level` / boundary-thread boost.

While `E_AXIS_STARTED_AT` is missing or the configured shadow window has not elapsed, callers continue to receive the baseline order. No second vector search, model call, or raw-query persistence was added.

## Evidence paths

- Automatic `/v1/recall` results keep using `recall_context_injected`; the existing async event now contains `trace.e_axis`.
- MCP `retrieve_memory` / `memory_recall` writes `recall_search_observed` through `ctx.waitUntil()`.
- Both events store only a SHA-256 query prefix, query length, memory IDs, and bounded rank deltas. They do not store the raw query.
- The existing LMC-5 admin tab renders a read-only `E shadow 观测` card. It shows the current gate state, seven-day sample count, candidate-window change rate, average boosted candidates, and recent bounded rank changes.

There is no schema migration and no activation button in the admin UI.

## Production safety contract

- Missing or invalid `E_AXIS_STARTED_AT` means indefinite shadow mode.
- Shadow calculation must not change returned order. The unit regression asserts baseline output and hypothetical E order separately.
- Exact fact/date/literal evidence gates remain outside this change. E only compares the fusion candidate window; it does not rewrite facts or bypass output policy.
- Observation writes are post-response work. A failed observation write is logged and does not fail recall.

## Activation review

Do not configure an activation time merely because a calendar deadline arrived. Review the admin panel after it has accumulated representative traffic.

Minimum acceptance evidence:

1. at least 50 evaluated hybrid-recall samples across at least three calendar days;
2. review every displayed candidate-window change, or at least the most recent 20 if the list grows;
3. no E promotion may displace an exact dated, literal, or fact-key authority result;
4. high-risk and high-tension promotions must improve response posture without introducing an unrelated topic;
5. automatic recall and MCP retrieval must both continue returning normally, with no measurable duplicate vector/model work.

If the evidence is acceptable, set `E_AXIS_STARTED_AT` deliberately and retain a non-zero `E_AXIS_SHADOW_DAYS` countdown. If it is not acceptable, leave the start time unset and adjust the existing boost policy; no rollback or data repair is required because shadow mode never changed served ranking.

## Verification before deployment

- `npm run typecheck`
- `npm test`
- `npm run test:lmc5-circuits`
- `git diff --check`

## Production record

- Code commit: `19273c0 Observe E-axis shadow ranking`
- Worker deployment: `87d787a1-0806-42c0-842f-c01bae4ae3fd`
- Worker version: `f305293e-1293-46b3-9e7e-7ec0fe5b01cc` at 100% traffic
- Health: `/health` returned `ok: true` after deployment
- Gate: `E_AXIS_STARTED_AT` remains unset, so production remains in indefinite shadow mode
- MCP smoke: success; the response body was not printed
- D1 evidence: one `recall_search_observed` event with `mode=shadow`, 30 compared candidates, 19 boosted candidates, 4 observed rank changes, and a changed top-five candidate window

Previous production version for rollback: `7b50b312-fa9c-4ea6-9f65-835824d1d5b9`. Rolling back code does not require a D1 repair because this change added no migration and shadow observations are append-only events.
