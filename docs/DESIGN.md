# sidekik-tutor: DESIGN

**Owner:** Mayukh · **Reviewer:** Aadil · **Public host:** `mcp.sidekik.live` (MCP only) · **Local port:** 8084

## 1. Purpose

Tutor turns a published Work Map into live coaching on the learner's own screen. It:

- follows which step the learner is on;
- asks them to predict decisions;
- **catches a guardrail violation before the save goes through**, deterministically in code;
- explains each catch in the expert's words, with a replay of the expert's screen moment;
- produces a mastery report;
- feeds learner gaps back to the expert.

## 2. Interfaces

**Inbound**

| Interface | Detail |
|---|---|
| Consumes `sk:workmap.published` | Loads the steps and compiled guardrails into an in-memory cache keyed by `workmap_id`. |
| Consumes `sk:session.lifecycle` | `started` (kind tutor) → create learner state. `ended` → mastery and gap flags. |
| Consumes `sk:screen.events` | For tutor sessions: updates `invoiceState`, runs the step tracker, evaluates the rules. |
| Consumes `sk:transcript.turns` | Learner answers to predictions (graded with D9). |
| Consumes `sk:speech.signals` | Avoids talking over the learner. |
| `POST /internal/presave` | `{session_id, state}` → `{allow, guardrail_id?, quote?, step_id?}` in **under 50 ms of compute**. No model calls on this path. |
| `POST /internal/tools/check_guardrails` | `{session_id, state?}` → violations and guardrail descriptions |
| `POST /internal/tools/get_step` | `{session_id, step_id?}` → the current or requested step, in the expert's words |
| `POST /internal/tools/get_expert_moment` | `{step_id}` → `{quote, quote_en?, label, clip_url?}` (signed, 10 min). 404 when the expert gave no reason for the step; `clip_url` is omitted until perception has cut the clip. |
| MCP `https://mcp.sidekik.live/mcp` | Streamable HTTP, bearer `SK_TOOL_SECRET`. Exposes the same three tools plus `export_agent_rules(workmap_id)`. |

**Outbound**

| Destination | Detail |
|---|---|
| `sk:agent.commands` | `predict`, `intervene`, `replay`, `summary` |
| Brain `/internal/decide` | D9, D10, D11 |
| Tables | `learner_attempts`, `interventions`, `mastery`, `gap_flags` |
| `sk:usage` | |

## 3. Runtime (per tutor session)

```
state: { workmap, currentStepId, invoiceState, violationsPending: Map<guardrailId, {since, field}>,
         predictionsAsked: Set<stepId>, attempts: Map<stepId, Outcome>, lastSpokenAt }
```

### Step tracker

- Match `(app, record_kind, focused_field)` from screen events against each step's `screen_signature`.
- When a new record opens, reset to the first step.
- Move forward when the learner focuses the field of a later step.

### Predict loop

- When the learner reaches a step marked `is_judgment_call` that hasn't been predicted yet:
  - wait for a quiet moment (no learner speech for 1.5 s);
  - publish `predict` with a prompt such as: "€7,200 spindle motor — which cost center would Sabine use, and why?"
- Grade the next learner turn with **D9**. Record the result as an attempt.
- If it's `wrong` or `partially`, the agent explains with the step's reason quote, which is already in its Procedure.

### Rule engine (deterministic)

1. On every `field_changed` event (source dom or vision), evaluate all guardrails with `json-logic-js` against the normalized `invoiceState`.
2. When a rule fires, add it to `violationsPending`.
3. Call **D11** to choose `hint_soft`, `intervene_now` or `wait_and_watch` based on what the learner is doing and how long the violation has been pending.
   - `intervene_now` → publish `intervene`, then `replay`.
   - `hint_soft` → publish `intervene` with softer text.
4. **D10** is used only for divergences that no guardrail covers. It allows a soft hint and never blocks.

### Pre-save check (the demo's critical path)

`/internal/presave` re-evaluates every rule on the submitted state.

- **Any violation:**
  - return `allow:false` with the guardrail's ID, quote and step;
  - publish `intervene` (always; D11 is skipped here) and then `replay`;
  - insert an `interventions` row and mark the attempt `corrected_after_intervention` once the learner fixes it.
- **No violations:** return `allow:true`.
- **In capture sessions** (no Work Map yet): always return `allow:true`.

### Mastery (on `ended`)

- **Outcome per step**, in priority order: `independent_correct` > `prompted_correct` > `corrected_after_intervention` > `not_attempted`.
- **Practice next:** steps that needed an intervention, plus guardrails that never came up.
- Insert a `mastery` row and publish `summary` so the agent reads it aloud and the UI shows the panel. A session with no learner (the demo seed's learners have no user) still publishes the summary, with `learner_id: "anonymous"`, and writes no rows.

### Gap flags

- When ≥2 learners trip the same guardrail, or D9 is unsure (<0.55) on the same step for ≥2 learners, insert or update a `gap_flags` row.
- Mapper picks these up as `open_items` with origin `learner_gap` for the expert's next debrief.
- **Experts see only aggregate gaps, never individual learners.**

## 4. Demo case (must pass as an automated test)

1. Seed: Work Map with G1 and G2 published.
2. The learner opens invoice "€7,200 spindle motor, new supplier", sets cost_center 4711, and presses Save.
3. **Expected:**
   - presave returns `{allow:false, guardrail_id:"G1", quote:"Equipment over €5,000 is always capex."}`;
   - an `intervene` command is published, followed by `replay` with the 03:12 clip;
   - G3 (unknown supplier → ask the controller) is also reported.
4. The learner switches to 0400 without an asset number and presses Save → G2 blocks it.
5. The learner adds the asset number → `allow:true`, and the attempt is recorded as `corrected_after_intervention`.

## 5. Env

`PORT, REDIS_URL, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SK_INTERNAL_TOKEN, SK_TOOL_SECRET, BRAIN_URL`

## 6. Claude Code tickets

1. Scaffold, env, bus wiring, Work Map cache (load from the DB at boot plus on `workmap.published`).
2. `rules.ts`: compile and evaluate JSON-Logic, with the §4 test as a vitest case.
3. `/internal/presave` with a latency test (p99 under 50 ms).
4. Step tracker.
5. Predict loop with D9.
6. Intervention policy: D11 and D10, `intervene` and `replay` commands, `interventions` rows.
7. Tool endpoints and the MCP server (`@modelcontextprotocol/sdk`, streamable HTTP).
8. Mastery and summary.
9. Gap flags.

## 7. Definition of done (Checkpoint 3)

- The §4 demo case passes end to end in the browser.
- The agent says "Hold on before you save" and quotes Sabine.
- The replay overlay plays the 03:12 clip.
- The mastery panel shows step 4 as `corrected_after_intervention`.
