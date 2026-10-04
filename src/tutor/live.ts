import { randomUUID } from 'node:crypto';
import type { Decider } from '../clients/brain.js';
import type { ScreenEvent, Step } from '../contracts/index.js';
import { evaluate, type Violation } from '../guardrails/rules.js';
import { publishCommand } from '../services/commands.js';
import { onScreen } from './step-tracker.js';
import { intervene, resolveCleared, type EffectDeps } from './interventions.js';
import type { TutorSession } from './session.js';
import { quoteFor } from './words.js';

export type LiveDeps = EffectDeps & { decider: Decider };

type Style = 'hint_soft' | 'intervene_now' | 'wait_and_watch';
const STYLES = new Set<string>(['hint_soft', 'intervene_now', 'wait_and_watch']);
/** D10 must say `diverges` at least this sure for a hint (ARCHITECTURE Appendix A). */
export const DIVERGES_MIN = 0.8;

/**
 * The live rule engine and intervention policy (DESIGN §3 "Rule engine"): on every field change,
 * every guardrail is evaluated on the open record. A violation the tutor hasn't spoken about joins
 * `violationsPending`, and brain's D11 picks how to respond, given what the learner is doing and how
 * long it has been pending:
 * - `intervene_now`: `intervene`, then `replay` of the expert's moment;
 * - `hint_soft`: a softer `intervene`;
 * - `wait_and_watch`: nothing yet; D11 is asked again on the next change (and the save is checked anyway).
 * A change on a judgment-call step that no guardrail covers goes to D10, which can only lead to a
 * soft hint, never a block.
 */
export class LivePolicy {
  constructor(private readonly deps: LiveDeps) {}

  async onFieldChanged(session: TutorSession, ev: ScreenEvent): Promise<void> {
    const violations = evaluate(session.map.rules, session.invoiceState);
    resolveCleared(this.deps, session, violations);

    const firing = new Set(violations.map((v) => v.guardrail.id));
    for (const id of session.violationsPending.keys()) if (!firing.has(id)) session.violationsPending.delete(id);
    const fresh = violations.filter((v) => !session.spokenAbout(v.guardrail.id));
    const now = Date.now();
    for (const v of fresh) {
      if (!session.violationsPending.has(v.guardrail.id)) session.violationsPending.set(v.guardrail.id, { since: now, field: ev.field });
    }

    const [main, ...also] = fresh;
    if (!main) {
      await this.checkDivergence(session, ev, firing);
      return;
    }
    const style = await this.style(session, main, ev, now);
    // A pre-save check may have spoken about it while D11 was thinking.
    if (style === 'wait_and_watch' || session.spokenAbout(main.guardrail.id)) return;
    for (const v of fresh) session.violationsPending.delete(v.guardrail.id);
    intervene(this.deps, session, main, { tone: style, trigger: 'live', also, replay: style === 'intervene_now' });
  }

  /** D11; if brain fails or answers something unexpected, a soft hint (the save is still checked). */
  private async style(session: TutorSession, v: Violation, ev: ScreenEvent, now: number): Promise<Style> {
    const pending = session.violationsPending.get(v.guardrail.id)!;
    try {
      const [d11] = await this.deps.decider.decide(session.id, [
        {
          id: 'D11',
          state: {
            guardrail: { key: v.guardrail.key, kind: v.guardrail.kind, description: v.guardrail.description, blocking: v.blocking },
            pending_ms: now - pending.since,
            field: pending.field ?? null,
            changed: { field: ev.field ?? null, before: ev.before ?? null, after: ev.after ?? null },
            learner: { speaking: session.speech.userSpeaking, step: session.currentStep?.title ?? null },
            case: session.invoiceState,
          },
        },
      ]);
      const answer = String(d11!.answer);
      session.log.info({ guardrail_key: v.guardrail.key, style: answer, confidence: d11!.confidence }, 'D11 decided');
      if (STYLES.has(answer)) return answer as Style;
      session.log.warn({ answer }, 'D11 answered an unknown style; hinting softly');
    } catch (err) {
      session.log.warn({ err, guardrail_key: v.guardrail.key }, 'D11 failed; hinting softly');
    }
    return 'hint_soft';
  }

  /** D10, once per judgment-call step and record, for a change no guardrail of the step covers. */
  private async checkDivergence(session: TutorSession, ev: ScreenEvent, firing: Set<string>): Promise<void> {
    if (!ev.field) return;
    const screen = { app: session.app, recordKind: session.record?.kind };
    const step = session.map.steps.find((s) => s.is_judgment_call && onScreen(s, screen, ev.field));
    if (!step || session.divergenceChecked.has(step.id)) return;
    if (step.guardrail_ids.some((id) => firing.has(id))) return;
    session.divergenceChecked.add(step.id);
    let diverges = false;
    try {
      const [d10] = await this.deps.decider.decide(session.id, [
        {
          id: 'D10',
          state: {
            expert: session.map.expertName,
            step: {
              title: step.title,
              decision: step.decision,
              reason: step.reason ? quoteFor(session.map, session.language, step.reason) : null,
            },
            learner_action: { field: ev.field, before: ev.before ?? null, after: ev.after ?? null },
            case: session.invoiceState,
          },
        },
      ]);
      diverges = d10!.answer === 'diverges' && d10!.confidence >= DIVERGES_MIN;
      session.log.info({ step_key: step.key, divergence: d10!.answer, confidence: d10!.confidence }, 'D10 decided');
    } catch (err) {
      session.log.warn({ err, step_key: step.key }, 'D10 failed; no hint');
    }
    if (diverges) this.hintDivergence(session, step);
  }

  private hintDivergence(session: TutorSession, step: Step): void {
    // `intervene` names a guardrail; a divergence cites the step's first one.
    const guardrailId = step.guardrail_ids[0];
    const reason = step.reason ? ` ${session.map.expertName} said: "${quoteFor(session.map, session.language, step.reason)}"` : '';
    const text = `A quick hint, no need to stop: ${session.map.expertName} did this step differently: ${step.decision}.${reason}`;
    session.log.info({ step_id: step.id, step_key: step.key }, 'divergence hint');
    const learnerId = session.learnerId;
    session.enqueue('divergence hint', async () => {
      if (guardrailId) {
        await publishCommand(this.deps.bus, session, {
          type: 'intervene',
          guardrail_id: guardrailId,
          step_id: step.id,
          text,
          ...(step.screen_signature.field && { field: step.screen_signature.field }),
        });
      } else {
        session.log.warn({ step_key: step.key }, 'step has no guardrail to cite; divergence hint not sent');
      }
      if (learnerId) {
        await this.deps.store.insertIntervention({
          id: randomUUID(),
          org_id: session.orgId,
          session_id: session.id,
          learner_id: learnerId,
          guardrail_id: null,
          step_id: step.id,
          t_ms: session.lastTms,
          trigger: 'divergence',
          style: 'hint_soft',
          resolved: false,
        });
      }
    });
  }
}
