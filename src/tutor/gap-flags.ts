import type { GapFlagRow, Store } from '../store/types.js';
import type { TutorSession } from './session.js';

/** DESIGN §3: a gap needs at least this many learners. */
export const MIN_LEARNERS = 2;
/** D9 below this confidence counts as unsure. */
export const UNSURE_BELOW = 0.55;

/**
 * Gap flags (DESIGN §3), after a tutor session ends: a blocking guardrail this learner tripped, or a
 * step whose prediction D9 was unsure about, becomes a `gap_flags` row once at least two learners
 * share it. Mapper turns open flags into `learner_gap` open items for the expert's next debrief,
 * which shows only the aggregate, never who the learners were.
 */
export async function updateGapFlags(store: Store, session: TutorSession): Promise<GapFlagRow[]> {
  if (!session.learnerId) return [];
  const map = session.map;
  const candidates: { row: Omit<GapFlagRow, 'learner_ids'>; learners: () => Promise<string[]> }[] = [];
  const base = { org_id: session.orgId, work_map_id: session.workmapId };

  for (const rule of map.rules.rules) {
    if (!rule.blocking || !session.guardrailsSeen.has(rule.guardrail.id)) continue;
    candidates.push({
      row: { ...base, kind: 'guardrail_tripped', guardrail_id: rule.guardrail.id, step_id: rule.step?.id ?? null },
      learners: () => store.learnersIntervenedOn(rule.guardrail.id),
    });
  }
  const unsureSteps = new Set(
    [...session.attempts.values()].filter((a) => a.confidence !== null && a.confidence < UNSURE_BELOW).map((a) => a.stepId),
  );
  for (const stepId of unsureSteps) {
    candidates.push({
      row: { ...base, kind: 'prediction_unsure', step_id: stepId, guardrail_id: null },
      learners: () => store.learnersUnsureOn(stepId, UNSURE_BELOW),
    });
  }

  const flagged: GapFlagRow[] = [];
  for (const { row, learners } of candidates) {
    const learnerIds = await learners();
    if (learnerIds.length < MIN_LEARNERS) continue;
    const flag = { ...row, learner_ids: learnerIds };
    const { created } = await store.upsertGapFlag(flag);
    // Counts only: the learners stay out of the logs too.
    session.log.info(
      { kind: row.kind, guardrail_id: row.guardrail_id, step_id: row.step_id, learners: learnerIds.length, created },
      created ? 'gap flag raised' : 'gap flag updated',
    );
    flagged.push(flag);
  }
  return flagged;
}
