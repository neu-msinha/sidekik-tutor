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

# 4. Install and run
pnpm install
pnpm dev            # tsx watch, reads .env
```

| Script | What it does |
|---|---|
| `pnpm dev` | Run from source with reload (reads `.env`) |
| `pnpm build` / `pnpm start` | Compile to `dist/` / run the compiled server |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm test` | vitest |
| `pnpm dev:mock` | Run against Redis only: in-memory store seeded with the published demo Work Map, no Supabase, brain stubbed (`src/dev/brain.ts`: D9 by keywords, D11 interrupts for blocking guardrails and hints for the rest, D10 can't tell) |
| `pnpm dev:replay <file.jsonl>` | Publish fixture events onto the bus (`--speed`, `--session`) |

### Running without teammates' services

```bash
docker compose -f ../sidekik-platform/dev/docker-compose.yml up -d   # Redis
pnpm dev:mock                                                         # prints the dev internal token
pnpm dev:replay dev/fixtures/tutor_lena.jsonl --speed 5               # Lena's tutor session
curl -X POST localhost:8084/internal/presave -H 'content-type: application/json' \
  -H 'x-internal-token: dev-mock-secret-not-for-production-0000000000' \
  -d '{"session_id":"fixture-tutor-lena","state":{"invoice_id":"4510","supplier":"Antriebstechnik Nord","supplier_known":false,"net_amount":7200,"currency":"EUR","category":"equipment","company_code":"DE01","cost_center":"4711","approvals_count":1}}'
# → allow:false, G1, Sabine's words; the log shows the intervene and replay commands
```

`dev/fixtures/seed.json` is generated from sidekik-platform `dev/seed/demo.ts`: the published demo Work Map (S1–S7, G1–G5), Sabine, and Lena's tutor session `fixture-tutor-lena`. `dev/fixtures/tutor_lena.jsonl` is sidekik-platform's tutor fixture: Lena opens invoice 4510 (€7,200 spindle motor, unknown supplier, on 4711), saves, recodes it to 0400, then puts Kranbau's December invoice 4511 on hold.

The service checks every env var at boot and exits with a list of the ones that are missing. `GET /healthz` returns `{ok, version, deps}`, with 503 when Redis or Supabase is down.

Runtime (`src/tutor/`): a tutor session's state is created on its lifecycle `started` (the learner and Work Map come from its `sessions` row), or on its first event after a restart. Screen events update the open record (`invoiceState`); speech signals track whether the learner is talking. Work Maps are cached in memory (`src/workmaps/cache.ts`): every published map at boot, a map again on `sk:workmap.published`, and any other map a session refers to on first use.

Rules (`src/guardrails/rules.ts`): each cached Work Map's guardrails are compiled once. A rule must be a single-operator JSON-Logic expression over the normalized `InvoiceState` variables that evaluates on test records; one that doesn't is logged and never applied. Evaluation is deterministic, with no model calls. A guardrail **blocks** the save when its consequence requires a field value (G1: cost center 0400) or blocks outright (G2). A guardrail whose consequence is only an action (G3 ask the controller, G4 hold, G5 second approval) is **reported** but doesn't block, since editing the record can't satisfy it; in the DESIGN §4 demo, G3 still fires on the final save, which must be allowed. Violations come back blocking first, then in step order. `test/rules.test.ts` runs the §4 demo case and G1–G5 against the seed map.

Step tracker (`src/tutor/step-tracker.ts`), DESIGN §3: each screen event's field (`state.focused_field`, or the `field` of a change, typing or click) is matched against the steps' `screen_signature` (app, record kind, field). A newly opened record resets to the first step; focusing the field of a later step moves forward to it; an earlier step's field doesn't move back, but that step still counts as reached on this case (invoice), which mastery uses. A save click is the save step (S7), and a blocked save puts the learner back on the step that teaches the blocking guardrail.

Predict loop (`src/tutor/predict.ts`), DESIGN §3: when the learner reaches a judgment-call step (S2, S4 in the demo) that hasn't been predicted in this session, the tutor waits for a quiet moment (nobody talking, and the learner silent for 1.5 s; it gives up after 30 s or when the learner moves past the step) and publishes `predict`, e.g. "€7,200 equipment from Antriebstechnik Nord: code the invoice to a cost center. What would Sabine do here, and why?". The learner's next turn is graded with brain's D9 (`POST /internal/decide`, 600 ms) and written to the step's `learner_attempts` row (`predicted`, `prediction_grade`, and D9's confidence in `actual_action.prediction_confidence`, since SCHEMA has no column for it). No answer within 60 s is `no_answer`; if brain is down the prediction is kept ungraded. A step the tutor already intervened on for this record isn't asked. On `wrong` or `partially` the agent explains with the step's reason, which is already in its Procedure.

Live rule engine and intervention policy (`src/tutor/live.ts`), DESIGN §3: on every `field_changed` screen event (dom or vision) every guardrail is evaluated on the open record. A violation the tutor hasn't spoken about on this record joins `violationsPending`, and brain's D11 decides, given the guardrail, the change, what the learner is doing and how long it has been pending:

- `intervene_now`: `intervene` ("Stop for a moment before you go on. …", naming any other new violations), then `replay` of the expert's moment;
- `hint_soft`: a softer `intervene` ("A quick hint, no need to stop: …"), no replay; also the fallback when brain fails;
- `wait_and_watch`: nothing yet; D11 is asked again on the next change with the longer pending time, and the save is checked anyway.

Each guardrail spoken about gets an `interventions` row (`trigger: live`); one fixed later is resolved like in the pre-save check. A change on a judgment-call step that no guardrail covers goes to D10 once per step and record; `diverges` at ≥0.80 gets one soft hint with the expert's decision and reason (`trigger: divergence`, `guardrail_id` null; the command cites the step's first guardrail, since `intervene` needs one). A step reached by changing its field isn't asked to predict: the learner has already decided.

Pre-save check (`src/tutor/presave.ts`), DESIGN §3: `POST /internal/presave {session_id, state}` (gateway, `X-Internal-Token`, 250 ms budget) re-evaluates every rule on the submitted record, which replaces the tracked one (a new `invoice_id` is a new record). The check is synchronous and model-free (p99 well under 50 ms in `test/presave.test.ts`); commands and rows are written afterwards, in order, in the session's queue.

- A **blocking** violation answers `{allow:false, guardrail_id, guardrail_key, quote, step_id, violations}`: the first blocking guardrail, the expert's words (in the learner's language: the original when it matches the map's, else `quote_en`) and the step that teaches it. It always publishes `intervene` ("Hold on before you save. … Sabine said: "…"", plus "Also: …" for other guardrails not yet mentioned on this record), and the first time a `replay` of that step's clip (signed for 10 minutes; skipped with a warning when perception has none). A repeated save reminds again without a second replay.
- **Otherwise** `{allow:true, violations}`. Guardrails that fired but don't block (G3, G4, G5) are mentioned once per record as a soft `intervene`.
- Every guardrail spoken about gets an `interventions` row (`trigger: presave`). One that no longer fires is corrected: its row is marked `resolved` and the step's `learner_attempts` row gets `corrected_after_intervention`.
- Capture sessions and sessions that aren't live tutor sessions are always allowed. Without a learner (fixtures) nothing is written, but the check still blocks and speaks.

Mastery (`src/tutor/mastery.ts`), DESIGN §3: on a tutor session's `ended`, each step gets an outcome per case (invoice) the learner attempted it on:

- a blocking guardrail stopped the learner: `corrected_after_intervention` once fixed (never fixed counts as `not_attempted`: the step wasn't done);
- a soft hint or notice, or a prediction that missed (`wrong`, `partially`, `no_answer`): `prompted_correct`;
- otherwise, if the learner got to the step: `independent_correct`.

A step's outcome is its weakest over the cases, `not_attempted` without any. Practice next: steps that needed an intervention, then guardrails that never came up. Every attempt's final outcome goes to `learner_attempts`, the summary to a `mastery` row, and `summary` is published so the agent reads it aloud and the page shows the mastery panel. In the §4 demo, S4 ends as `corrected_after_intervention`.

Agent tools (`src/tutor/tools.ts`), DESIGN §2. Read-only: they never publish commands or write rows.

| Tool | Route (gateway proxies, `X-Internal-Token`) | Answer |
|---|---|---|
| `check_guardrails` | `POST /internal/tools/check_guardrails {session_id, state?}` | every guardrail that fires on the submitted (or tracked) record, blocking first, with the expert's quote; `allow_save`; the map's guardrails |
| `get_step` | `POST /internal/tools/get_step {session_id, step_id?}` | the requested step (id or key, e.g. `S4`) or the current one: decision, reason in the expert's words, guardrails |
| `get_expert_moment` | `POST /internal/tools/get_expert_moment {step_id}` | `{step_id, quote, quote_en, label, clip_url}`; the clip URL is signed for 10 minutes, null without a clip |

A session that isn't a live tutor session is a 404. MCP (`src/routes/mcp.ts`): `POST /mcp` (`https://mcp.sidekik.live/mcp`), streamable HTTP in stateless mode (a fresh server per request, JSON responses), `Authorization: Bearer $SK_TOOL_SECRET`. It exposes the three tools plus `export_agent_rules(workmap_id)`, which returns mapper's published `AGENT_RULES.md` and `guardrails.jsonlogic.json` from Storage (`workmaps/org/{org}/{id}/v{n}/`). Tool failures come back as MCP tool errors (`isError`) the agent can read. `GET`/`DELETE /mcp` answer 405.

Bus handling: every handler is idempotent on `event.id`, every event of a replay session (`mode:"replay"`) is ignored, and capture sessions are remembered so their screen events cost no database lookup.

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
