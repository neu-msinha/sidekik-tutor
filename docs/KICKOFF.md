# Claude Code kickoff: sidekik-tutor

**Owner:** Mayukh · **Reviewer:** Aadil · **This repo is:** the tutor runtime: step tracker, deterministic JSON-Logic rule engine, pre-save check, predict loop, interventions, mastery, gap flags, MCP server.

## 0. Setup (10 minutes, before opening Claude Code)

1. Clone `<org>/sidekik-tutor`; create it in the org first if it doesn't exist (empty, `main` protected, reviewer in CODEOWNERS).
2. From your clone of **sidekik-docs**, run `./scripts/sync-docs.sh <folder that contains your repo clones>`. It copies `CLAUDE.md`, `.env.example`, `docs/DESIGN.md`, `docs/KICKOFF.md` and the shared `docs/ARCHITECTURE.md` + `docs/SCHEMA.md` into this repo. Commit them.
3. `cp .env.example .env` and fill it in from the team vault. Never commit `.env`.
4. **Dependencies:** a published Work Map (use the pre-confirmed seed Work Map until mapper publishes), brain `/internal/decide` (stub), `@sidekik/contracts`.
5. **Contracts before the tag exists (H0–H1.5):** do ticket 1 (scaffold) first; it doesn't need contracts. If you need types early, use `github:<org>/sidekik-platform#main` and switch to the `v0.1.0` tag as soon as it's posted.
6. Start the shared dev stack from a clone of sidekik-platform: `docker compose -f dev/docker-compose.yml up -d` (Redis + Presidio).
7. Open Claude Code in the repo root and run `/memory`. You should see `CLAUDE.md`, which imports `docs/DESIGN.md`, `docs/ARCHITECTURE.md` and `docs/SCHEMA.md`.

## 1. First prompt (plan mode; press Shift+Tab until it says plan mode)

```
Read CLAUDE.md, docs/DESIGN.md, docs/ARCHITECTURE.md and the tables this service owns in docs/SCHEMA.md.
Do not write code yet. Give me:
1. This service's responsibilities in 5 bullets.
2. Every stream it consumes/produces, every endpoint it serves/calls, every table it writes — as one table.
3. Every ambiguity, contradiction or missing detail you find across the docs (quote the lines).
4. A file-by-file plan for ticket 1, plus the order you'd do the remaining tickets in.
Wait for my approval.
```

Fix any real contradictions it finds **in the docs first**, and tell the team if they touch another repo. Then approve the plan.

## 2. Ticket loop (repeat for every ticket in `docs/DESIGN.md`, in order)

```
Implement ticket <N> from docs/DESIGN.md: "<ticket title>".
- Follow CLAUDE.md rules. Import contracts from @sidekik/contracts; never redefine them.
- Write or update tests first where practical, then the code.
- Run `pnpm typecheck && pnpm test` (and `pnpm lint` if configured) and fix until green.
- Don't touch files outside this repo. Don't change docs/ARCHITECTURE.md or docs/SCHEMA.md.
- Finish with: files changed, how to run/verify it manually, and any TODOs or doc questions.
Then stop.
```

Commit after each ticket (`feat(<area>): ticket <N> …`). Open a PR to `main` at least every 2 tickets so Aadil can review without a backlog.

## 3. Repo-specific notes

- **Ticket 2's demo test (DESIGN §4) is the most important test in the whole project.** Write it first.
- **Keep the pre-save path model-free and under 50 ms.**

## 4. Integration checkpoints

### H18: Checkpoint 3

```
We're at H18: Checkpoint 3. Run this service against the shared dev stack and teammates' deployed services.
Verify exactly this and report pass/fail per item with log or test evidence:
The DESIGN §4 demo case passes end to end in the browser: the save is blocked, the agent quotes Sabine, the 03:12 clip replays, and mastery shows step 4 as corrected_after_intervention.
Fix only problems inside this repo. For problems in another repo, write a short bug note
(repo, observed, expected, payload sample) that I can paste to its owner. Then stop.
```

## 5. When a contract is wrong or missing

Don't patch it locally. Use this prompt:

```
Write a GitHub issue for sidekik-platform: the contract change needed (exact zod diff), which services
are affected, and whether it's additive (minor bump) or breaking (major bump). Keep it under 15 lines.
```

Post the issue in the team chat. Sahil bumps the tag, and every affected owner updates their pin in the same hour.

## 6. Deploy (once the team has picked hosting)

```
Add a production Dockerfile (node:20-slim), a /healthz that reports dependency status,
listen on host "::" and PORT from env, and a README section "Deploy" listing every env var from .env.example.
```

Public hostname for this service: `mcp.sidekik.live`.
