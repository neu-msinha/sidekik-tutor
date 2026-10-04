import { randomUUID } from 'node:crypto';
import type { MasterySummary } from '../contracts/index.js';
import { publishCommand } from '../services/commands.js';
import type { Outcome } from '../store/types.js';
import { saveAttempt } from './attempts.js';
import type { EffectDeps } from './interventions.js';
import type { Attempt, TutorSession } from './session.js';

/** Stands in for `learner_id` in a summary when the session has no learner row. */
export const ANONYMOUS_LEARNER = 'anonymous';

const RANK: Record<Outcome, number> = {
  not_attempted: 0,
  corrected_after_intervention: 1,
  prompted_correct: 2,
  independent_correct: 3,
};

/** Predictions that mean the learner didn't know the expert's call: the agent explained it. */
const PROMPTING_GRADES = new Set(['wrong', 'partially', 'no_answer']);

/** The learner did something on this step of this case. */
export function attempted(a: Attempt): boolean {
  return a.reached || a.intervened || a.hinted || a.predicted !== null || a.grade !== null;
}

/**
 * One case's outcome for a step (DESIGN §3, in priority order):
 * - a blocking guardrail stopped the learner: `corrected_after_intervention` once fixed; never fixed
 *   counts as `not_attempted` (the step wasn't done);
 * - a soft hint, or a prediction that missed (`wrong`, `partially`, `no_answer`): `prompted_correct`;
 * - otherwise, if the learner got to the step: `independent_correct`.
 */
export function caseOutcome(a: Attempt): Outcome {
  if (!attempted(a)) return 'not_attempted';
  if (a.intervened) return a.corrected ? 'corrected_after_intervention' : 'not_attempted';
  if (a.hinted || (a.grade !== null && PROMPTING_GRADES.has(a.grade))) return 'prompted_correct';
  return 'independent_correct';
}

/**
 * The session's mastery: each step's outcome is its weakest over the cases (invoices) where the
 * learner attempted it, `not_attempted` if none. Practice next: steps that needed an intervention,
 * then guardrails that never came up.
 */
export function masterySummary(session: TutorSession): MasterySummary {
  const byStep = new Map<string, Attempt[]>();
  for (const a of session.attempts.values()) {
    if (!attempted(a)) continue;
    byStep.set(a.stepId, [...(byStep.get(a.stepId) ?? []), a]);
  }

  const counts = { independent_correct: 0, prompted_correct: 0, corrected_after_intervention: 0, not_attempted: 0 };
  const practice: MasterySummary['practice_next'] = [];
  const steps = session.map.steps.map((step) => {
    const cases = byStep.get(step.id) ?? [];
    const outcome = cases.length === 0 ? 'not_attempted' : cases.map(caseOutcome).reduce((w, o) => (RANK[o] < RANK[w] ? o : w));
    counts[outcome]++;
    const stopped = cases.filter((a) => a.intervened);
    if (stopped.length > 0) {
      const fixed = stopped.every((a) => a.corrected);
      practice.push({ step_id: step.id, reason: `${step.title} (${fixed ? 'needed a correction' : 'not fixed after an intervention'})` });
    }
    return { step_id: step.id, key: step.key, title: step.title, outcome };
  });

  for (const g of session.map.workmap.guardrails) {
    if (!session.guardrailsSeen.has(g.id)) practice.push({ guardrail_id: g.id, reason: `${g.description.replace(/\.$/, '')} (never came up)` });
  }

  return {
    session_id: session.id,
    workmap_id: session.workmapId,
    // The contract's MasterySummary requires a learner_id. A session with no learner (e.g. the demo
    // seed's learners have no user) still shows the panel; nothing is written to the database for it.
    learner_id: session.learnerId ?? ANONYMOUS_LEARNER,
    steps,
    practice_next: practice,
    counts,
  };
}

/**
 * Lifecycle `ended` (DESIGN §3 "Mastery"): writes every attempt's final outcome and the `mastery`
 * row, then publishes `summary` so the agent reads it aloud and the page shows the mastery panel.
 */
export async function finishSession(deps: EffectDeps, session: TutorSession): Promise<MasterySummary> {
  const summary = masterySummary(session);
  for (const attempt of session.attempts.values()) {
    if (attempted(attempt)) session.enqueue('save attempt', () => saveAttempt(deps.store, session, attempt, caseOutcome(attempt)));
  }
  const learnerId = session.learnerId;
  if (learnerId) {
    session.enqueue('insert mastery', () =>
      deps.store.insertMastery({
        id: randomUUID(),
        org_id: session.orgId,
        session_id: session.id,
        learner_id: learnerId,
        work_map_id: session.workmapId,
        summary,
      }),
    );
  }
  session.enqueue('summary', () => publishCommand(deps.bus, session, { type: 'summary', mastery: summary }));
  await session.idle();
  session.log.info({ counts: summary.counts, practice_next: summary.practice_next.length }, 'mastery recorded');
  return summary;
}
