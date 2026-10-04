# TEMPORARY: stand-in for `@sidekik/contracts`

`sidekik-platform` hasn't tagged `@sidekik/contracts` yet. These files are a copy of sidekik-mapper's stand-in, which is aligned with sidekik-platform `main` (not yet tagged) for the bus wire format, the decision types and the names below.

**Every other file in this repo imports contracts only from `src/contracts/index.ts`.** When `v0.1.0` is tagged:

1. `pnpm add github:sidekik-live/sidekik-platform#v0.1.0`
2. Replace `index.ts` with `export * from '@sidekik/contracts';` and delete the other files here.
3. Run `pnpm typecheck && pnpm test` and fix any name drift.

Wire assumptions (checked against sidekik-platform `main`):

- Bus entries: `XADD <stream> MAXLEN ~ 10000 * ev <JSON envelope>` (one field named `ev`, as in sidekik-platform `src/bus.ts`).
- Envelope `type` values: `"session.lifecycle"`, `"transcript.turn"`, `"speech.signal"`, `"screen.event"`, `"workmap.published"`, `"agent.command"`.
- Replays publish under a new session id, and every lifecycle event of a replay carries `mode: "replay"`.

Changed from the mapper's copy, to match sidekik-platform: the bus also validates `sk:screen.events` and `sk:workmap.published`, and `predict`, `intervene` and `replay` require non-empty ids, text and `clip_url`.

Switching to the package also means moving to zod 4 (the platform's version) and `fastify-type-provider-zod` 5+.
