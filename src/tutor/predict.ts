import type { Bus, Step, TranscriptTurn } from '../contracts/index.js';
import type { Decider } from '../clients/brain.js';
import { publishCommand } from '../services/commands.js';
import type { Store } from '../store/types.js';
import { saveAttempt } from './attempts.js';
import type { SpeechState, TutorSession } from './session.js';
import { predictPrompt, quoteFor } from './words.js';

/** DESIGN §3: ask only after the learner has been quiet this long. */
export const QUIET_MS = 1_500;
/** Give up on a prediction that never finds a quiet moment. */
export const MAX_WAIT_MS = 30_000;
/** No learner turn this long after asking counts as `no_answer`. */
export const ANSWER_MS = 60_000;

export type PredictDeps = { bus: Bus; store: Store; decider: Decider };

/** Ms until nobody is talking and the learner has been quiet for QUIET_MS (0 = now). */
export function quietIn(speech: SpeechState, now: number): number {
  if (speech.userSpeaking || speech.agentSpeaking) return QUIET_MS;
  return Math.max(0, (speech.lastUserSpeechAt ?? Number.NEGATIVE_INFINITY) + QUIET_MS - now);
}

/**
 * The predict loop (DESIGN §3): when the learner reaches a judgment-call step not yet predicted,
 * wait for a quiet moment, publish `predict`, and grade the learner's next turn with brain's D9.
 * The grade goes on the step's attempt; when it's `wrong` or `partially`, the agent explains with
 * the step's reason, which is already in its Procedure.
 */
export class PredictLoop {
  constructor(private readonly deps: PredictDeps) {}

  /** The current step changed. */
  onStep(session: TutorSession, step: Step): void {
    const pending = session.prediction;
    if (pending?.phase === 'waiting_quiet' && pending.stepId !== step.id) this.cancel(session, 'learner moved on');
    if (!step.is_judgment_call || session.predictionsAsked.has(step.id) || session.prediction) return;
    // The tutor already spoke about this step's guardrail on this record: nothing left to predict.
    if ([...session.intervened.values()].some((i) => i.stepId === step.id)) return;
    session.prediction = {
      stepId: step.id,
      caseRef: session.record?.id ?? null,
      prompt: predictPrompt(session.map, session.invoiceState, step),
      phase: 'waiting_quiet',
      since: Date.now(),
    };
    this.tryAsk(session);
  }

  /** A transcript turn: the learner's first turn after `predict` is the prediction. */
  async onTurn(session: TutorSession, turn: TranscriptTurn): Promise<void> {
    const pending = session.prediction;
    if (pending?.phase !== 'asked' || turn.role !== 'user') return;
    clearTimeout(pending.timer);
    session.prediction = null;
    const step = session.map.stepById.get(pending.stepId)!;
    const attempt = session.attempt(step.id, pending.caseRef);
    attempt.predicted = turn.text;
    try {
      const [d9] = await this.deps.decider.decide(session.id, [
        {
          id: 'D9',
          state: {
            expert: session.map.expertName,
            step: {
              title: step.title,
              decision: step.decision,
              reason: step.reason ? quoteFor(session.map, session.language, step.reason) : null,
            },
            case: session.invoiceState,
            prompt: pending.prompt,
            prediction: turn.text,
          },
        },
      ]);
      attempt.grade = String(d9!.answer);
      attempt.confidence = d9!.confidence;
      session.log.info({ step_key: step.key, grade: attempt.grade, confidence: d9!.confidence }, 'prediction graded');
    } catch (err) {
      session.log.warn({ err, step_key: step.key }, 'D9 failed; prediction kept ungraded');
    }
    session.enqueue('save attempt', () => saveAttempt(this.deps.store, session, attempt));
  }

  /** Session over: drop any pending prediction. */
  stop(session: TutorSession): void {
    clearTimeout(session.prediction?.timer);
    session.prediction = null;
  }

  private tryAsk(session: TutorSession): void {
    const pending = session.prediction;
    if (pending?.phase !== 'waiting_quiet') return;
    if (session.currentStep?.id !== pending.stepId || (session.record?.id ?? null) !== pending.caseRef) {
      return this.cancel(session, 'learner moved on');
    }
    const now = Date.now();
    if (now - pending.since > MAX_WAIT_MS) return this.cancel(session, 'no quiet moment');
    const wait = quietIn(session.speech, now);
    if (wait > 0) {
      pending.timer = setTimeout(() => this.tryAsk(session), wait);
      return;
    }
    pending.phase = 'asked';
    pending.since = now;
    session.predictionsAsked.add(pending.stepId);
    session.enqueue('predict', () =>
      publishCommand(this.deps.bus, session, { type: 'predict', step_id: pending.stepId, prompt: pending.prompt }),
    );
    pending.timer = setTimeout(() => this.noAnswer(session, pending.stepId), ANSWER_MS);
  }

  private noAnswer(session: TutorSession, stepId: string): void {
    const pending = session.prediction;
    if (pending?.phase !== 'asked' || pending.stepId !== stepId) return;
    session.prediction = null;
    const attempt = session.attempt(stepId, pending.caseRef);
    attempt.grade = 'no_answer';
    session.log.info({ step_id: stepId }, 'no prediction given');
    session.enqueue('save attempt', () => saveAttempt(this.deps.store, session, attempt));
  }

  private cancel(session: TutorSession, why: string): void {
    const pending = session.prediction;
    if (!pending) return;
    clearTimeout(pending.timer);
    session.prediction = null;
    session.log.debug({ step_id: pending.stepId, why }, 'prediction not asked');
  }
}
