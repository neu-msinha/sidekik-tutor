import { randomUUID } from 'node:crypto';
import type { Bus } from '../contracts/index.js';
import type { CompiledRule, Violation } from '../guardrails/rules.js';
import { publishCommand } from '../services/commands.js';
import type { InterventionRow, Store } from '../store/types.js';
import { saveAttempt } from './attempts.js';
import type { ClipLinks } from './clips.js';
import type { Intervened, TutorSession } from './session.js';
import { interventionText, quoteFor, type InterventionTone } from './words.js';

export type EffectDeps = { bus: Bus; store: Store; clips: ClipLinks };

type Trigger = InterventionRow['trigger'];

const styleOf = (tone: InterventionTone): InterventionRow['style'] =>
  tone === 'hint_soft' || tone === 'presave_notice' ? 'hint_soft' : 'intervene_now';

/**
 * Speaks about a guardrail on the open record: publishes `intervene` (mentioning `also`), then the
 * first time a `replay` of the expert's screen moment, and writes an `interventions` row for each
 * guardrail newly spoken about. Returns at once; the commands and writes run in the session's
 * queue, in order.
 */
export function intervene(
  deps: EffectDeps,
  session: TutorSession,
  main: CompiledRule,
  opts: { tone: InterventionTone; trigger: Trigger; also?: CompiledRule[]; replay: boolean },
): void {
  const style = styleOf(opts.tone);
  const rows = [main, ...(opts.also ?? [])].flatMap((rule) => {
    const row = remember(session, rule, opts.trigger, rule === main ? style : styleOf('presave_notice'));
    return row ? [row] : [];
  });
  const entry = session.intervened.get(main.guardrail.id)!;
  const step = main.step ?? session.map.steps[0];
  const replay = opts.replay && !entry.replayed && main.step !== undefined;
  if (replay) entry.replayed = true;
  const text = interventionText(session.map, session.language, opts.tone, main, opts.also);
  const field = Object.keys(main.guardrail.consequence.require ?? {})[0] ?? main.step?.screen_signature.field;
  session.log.info(
    { guardrail_id: main.guardrail.id, guardrail_key: main.guardrail.key, trigger: opts.trigger, style, replay },
    'intervening',
  );

  session.enqueue('intervene', async () => {
    if (step) {
      await publishCommand(deps.bus, session, {
        type: 'intervene',
        guardrail_id: main.guardrail.id,
        step_id: step.id,
        text,
        ...(field && { field }),
      });
    }
    if (replay && main.step) await publishReplay(deps, session, main);
  });
  // Separate from the commands, so a bus failure doesn't lose the rows.
  if (rows.length > 0) {
    session.enqueue('record intervention', async () => {
      for (const row of rows) await deps.store.insertIntervention(row);
    });
  }
}

async function publishReplay(deps: EffectDeps, session: TutorSession, rule: CompiledRule): Promise<void> {
  const step = rule.step!;
  const clipUrl = await deps.clips.forStep(step.id);
  if (!clipUrl) {
    session.log.warn({ step_id: step.id, step_key: step.key }, 'no clip for the step; replay skipped');
    return;
  }
  await publishCommand(deps.bus, session, {
    type: 'replay',
    step_id: step.id,
    clip_url: clipUrl,
    quote: quoteFor(session.map, session.language, rule.guardrail),
    label: step.reason?.source_label ?? `${session.map.expertName}, ${step.screen_moment.label}`,
  });
}

/**
 * Records that the tutor spoke about the guardrail on this record and returns the `interventions`
 * row to write. A guardrail already spoken about gets no new row, unless it had been corrected and
 * fired again.
 */
function remember(
  session: TutorSession,
  rule: CompiledRule,
  trigger: Trigger,
  style: InterventionRow['style'],
): InterventionRow | null {
  const { guardrail, step } = rule;
  const known = session.intervened.get(guardrail.id);
  if (known && !known.resolved) return null;
  const entry: Intervened = {
    guardrailId: guardrail.id,
    stepId: step?.id,
    rowId: session.learnerId ? randomUUID() : null,
    resolved: false,
    replayed: known?.replayed ?? false,
  };
  session.intervened.set(guardrail.id, entry);
  if (step) {
    const attempt = session.attempt(step.id);
    if (rule.blocking) {
      attempt.intervened = true;
      attempt.corrected = false;
    } else {
      attempt.hinted = true;
    }
  }
  return entry.rowId && session.learnerId
    ? {
        id: entry.rowId,
        org_id: session.orgId,
        session_id: session.id,
        learner_id: session.learnerId,
        guardrail_id: guardrail.id,
        step_id: step?.id ?? null,
        t_ms: session.lastTms,
        trigger,
        style,
        resolved: false,
      }
    : null;
}

/**
 * Guardrails the tutor spoke about that no longer fire are corrected: the row is marked resolved
 * and the step's attempt becomes `corrected_after_intervention`.
 */
export function resolveCleared(deps: EffectDeps, session: TutorSession, violations: Violation[]): void {
  const firing = new Set(violations.map((v) => v.guardrail.id));
  for (const id of firing) session.guardrailsSeen.add(id);
  for (const entry of session.intervened.values()) {
    if (entry.resolved || firing.has(entry.guardrailId)) continue;
    entry.resolved = true;
    const attempt = entry.stepId ? session.attempt(entry.stepId) : undefined;
    if (attempt) attempt.corrected = true;
    session.log.info({ guardrail_id: entry.guardrailId, step_id: entry.stepId }, 'violation corrected');
    session.enqueue('resolve intervention', async () => {
      if (entry.rowId) await deps.store.resolveIntervention(entry.rowId);
      if (attempt) await saveAttempt(deps.store, session, attempt);
    });
  }
}
