# sidekik-tutor

The tutor runtime for **Sidekik**, an AI apprentice ([sidekik.live](https://sidekik.live)). It turns a published Work Map into live coaching on the learner's own screen and **catches a guardrail violation before the save goes through**.

**Owner:** Mayukh · **Reviewer:** Aadil · **Public host:** `mcp.sidekik.live` (MCP only) · **Local port:** 8084

## What it does

- **Step tracking:** matches `(app, record_kind, focused_field)` from screen events against each step's `screen_signature`; a new record resets to the first step.
- **Predict loop:** at a judgment-call step, waits for 1.5 s of learner silence, publishes `predict` ("which cost center would Sabine use, and why?") and grades the answer with brain's D9.
- **Rule engine:** evaluates every compiled guardrail with `json-logic-js` against the normalized `InvoiceState` on each `field_changed`. D11 picks `hint_soft`, `intervene_now` or `wait_and_watch`; D10 allows only soft hints for divergences no guardrail covers.
- **Pre-save check:** `POST /internal/presave` re-evaluates every rule in under 50 ms of compute, with no model calls. A violation returns `allow:false` with the guardrail, the expert's quote and the step, and always publishes `intervene` then `replay`.
- **Mastery and gaps:** on `ended`, scores each step (`independent_correct` > `prompted_correct` > `corrected_after_intervention` > `not_attempted`) and publishes `summary`. Repeated trips across learners become `gap_flags`, which mapper turns into open items for the expert's next debrief. Experts see only aggregate gaps.
- **MCP:** `https://mcp.sidekik.live/mcp` (streamable HTTP, bearer `SK_TOOL_SECRET`) exposes the tool endpoints plus `export_agent_rules(workmap_id)`.

The full spec is in `docs/DESIGN.md`. System design and contracts are in `docs/ARCHITECTURE.md`, and the database is in `docs/SCHEMA.md`. All three are synced from [`sidekik-docs`](../sidekik-docs).

## Interfaces

| Direction | What |
|---|---|
| Consumes | `sk:workmap.published`, `sk:session.lifecycle` (`started` kind tutor, `ended`), `sk:screen.events`, `sk:transcript.turns`, `sk:speech.signals` |
| Serves | `POST /internal/presave`, `POST /internal/tools/check_guardrails`, `POST /internal/tools/get_step`, `POST /internal/tools/get_expert_moment`, MCP `/mcp` |
| Publishes | `sk:agent.commands` (`predict`, `intervene`, `replay`, `summary`), `sk:usage` |
| Calls | brain `/internal/decide` (D9, D10, D11) |
| Writes | `learner_attempts`, `interventions`, `mastery`, `gap_flags` |

The gateway calls `/internal/presave` with a 300 ms budget and `/internal/tools/*` with 800 ms. Both use `X-Internal-Token`.

## Stack

Node 20, TypeScript (strict), Fastify, zod, pino, vitest, pnpm, `json-logic-js`, `@modelcontextprotocol/sdk`, and Docker (`node:20-slim`). Contracts come from `@sidekik/contracts`, pinned to a `sidekik-platform` git tag.

## Setup

```bash
# 1. Sync docs, CLAUDE.md and .env.example from sidekik-docs
cd ../sidekik-docs
bash scripts/sync-docs.sh .. --only sidekik-tutor

# 2. Configure env (values come from the team vault; never commit .env)
cd ../sidekik-tutor
cp .env.example .env

# 3. Start the shared dev stack (Redis + Presidio) from a sidekik-platform clone
docker compose -f ../sidekik-platform/dev/docker-compose.yml up -d

# 4. Install and run (once ticket 1 lands)
pnpm install
pnpm dev            # tsx watch, reads .env
```

Until mapper publishes, use the pre-confirmed seed Work Map, and stub brain `/internal/decide`.

| Env var | What it is |
|---|---|
| `PORT` | Listen port (8084), host `::` |
| `REDIS_URL` | The bus |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | Work Maps, steps, guardrails, clips; writes the four tutor tables |
| `SK_INTERNAL_TOKEN` | Shared secret for `/internal/*` |
| `SK_TOOL_SECRET` | Bearer for the MCP server; shared with gateway and voice |
| `BRAIN_URL` | brain, for D9–D11 |
| `LOG_LEVEL` | pino level |

## The demo case

DESIGN §4 is Checkpoint 3 and the most important test in the project. It must pass as an automated test:

1. A Work Map with G1 and G2 is published.
2. The learner opens "€7,200 spindle motor, new supplier", sets cost center 4711 and saves. Presave returns `{allow:false, guardrail_id:"G1", quote:"Equipment over €5,000 is always capex."}`, publishes `intervene` then `replay` with the 03:12 clip, and also reports G3 (unknown supplier).
3. The learner switches to 0400 without an asset number and saves. G2 blocks it.
4. The learner adds the asset number. Presave returns `allow:true`, and the attempt is recorded as `corrected_after_intervention`.

The G1–G5 rules are in `docs/ARCHITECTURE.md` under "Demo guardrails". Mapper's guardrail tests use the same rules, so the two services must agree.

## Roadmap

One PR per ticket from `docs/DESIGN.md` §6. Each PR leaves the service booting with typecheck and tests green.

| PR | Branch | Ticket | Needs |
|---|---|---|---|
| 1 | `feat/scaffold` | Scaffold, env, bus wiring, Work Map cache (load from the DB at boot and on `workmap.published`) | — |
| 2 | `feat/rules` | `rules.ts`: compile and evaluate JSON-Logic, with the §4 demo case as a vitest case | `json-logic-js`, `@sidekik/contracts` |
| 3 | `feat/presave` | `/internal/presave` with a latency test (p99 under 50 ms) | |
| 4 | `feat/step-tracker` | Step tracker | |
| 5 | `feat/predict` | Predict loop with D9 | brain `/internal/decide` (stub) |
| 6 | `feat/interventions` | Intervention policy: D11 and D10, `intervene` and `replay` commands, `interventions` rows | |
| 7 | `feat/mcp` | Tool endpoints and the MCP server (streamable HTTP) | `@modelcontextprotocol/sdk` |
| | | **Checkpoint 3 (H18):** the save is blocked, the agent says "Hold on before you save" and quotes Sabine, the 03:12 clip replays, and mastery shows step 4 as `corrected_after_intervention` | |
| 8 | `feat/mastery` | Mastery and `summary` | |
| 9 | `feat/gap-flags` | Gap flags | |

If the team is behind, MCP can be cut and the tutor reached through webhook tools only (ARCHITECTURE cut order).
