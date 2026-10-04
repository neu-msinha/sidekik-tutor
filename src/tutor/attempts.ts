import type { Outcome, Store } from '../store/types.js';
import type { Attempt, TutorSession } from './session.js';

/**
 * Writes the attempt's `learner_attempts` row (insert or replace by id). Nothing without a learner.
 * Until mastery sets the final outcome, a corrected attempt says `corrected_after_intervention`.
 */
export async function saveAttempt(store: Store, session: TutorSession, attempt: Attempt, outcome?: Outcome): Promise<void> {
  if (!session.learnerId) return;
  await store.upsertAttempt({
    id: attempt.id,
    org_id: session.orgId,
    session_id: session.id,
    learner_id: session.learnerId,
    work_map_id: session.workmapId,
    step_id: attempt.stepId,
    case_ref: attempt.caseRef,
    predicted: attempt.predicted,
    prediction_grade: attempt.grade,
    // D9's confidence, for the gap flags (SCHEMA has no column for it).
    actual_action: attempt.confidence === null ? null : { prediction_confidence: attempt.confidence },
    outcome: outcome ?? (attempt.corrected ? 'corrected_after_intervention' : null),
  });
  attempt.saved = true;
}
