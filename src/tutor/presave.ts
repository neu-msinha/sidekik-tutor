import { performance } from 'node:perf_hooks';
import type { InvoiceState } from '../contracts/index.js';
import { evaluate } from '../guardrails/rules.js';
import { intervene, resolveCleared, type EffectDeps } from './interventions.js';
import type { TutorSession } from './session.js';
import { quoteFor } from './words.js';

export type PresaveViolation = {
  guardrail_id: string;
  key: string;
  description: string;
  blocking: boolean;
  step_id?: string;
};

/**
 * `POST /internal/presave` answer. The first four fields are the gateway's contract; `violations`
 * lists every guardrail that fired (blocking first), so non-blocking ones such as G3 are reported.
 */
export type PresaveResult = {
  allow: boolean;
  guardrail_id?: string;
  guardrail_key?: string;
  quote?: string;
  step_id?: string;
  violations: PresaveViolation[];
};

/**
 * The pre-save check (DESIGN §3), deterministic and model-free. Every rule is re-evaluated on the
 * submitted record:
 * - a blocking violation answers `allow:false` with the guardrail, the expert's words and the step,
 *   and always publishes `intervene` (D11 is skipped) and, the first time, `replay`;
 * - otherwise the save is allowed, and guardrails that fired but don't block (G3) are mentioned once
 *   per record as a soft notice.
 * Guardrails the tutor spoke about that no longer fire count as corrected. The answer doesn't wait
 * for any of the commands or writes.
 */
export function presave(deps: EffectDeps, session: TutorSession, state: InvoiceState): PresaveResult & { compute_ms: number } {
  const started = performance.now();
  session.applySubmitted(state);
  const violations = evaluate(session.map.rules, session.invoiceState);
  resolveCleared(deps, session, violations);

  const report = violations.map(
    (v): PresaveViolation => ({
      guardrail_id: v.guardrail.id,
      key: v.guardrail.key,
      description: v.guardrail.description,
      blocking: v.blocking,
      ...(v.step && { step_id: v.step.id }),
    }),
  );
  const unmentioned = (id: string) => !session.intervened.has(id) || session.intervened.get(id)!.resolved;
  const main = violations.find((v) => v.blocking);

  let result: PresaveResult;
  if (main) {
    const also = violations.filter((v) => v !== main && unmentioned(v.guardrail.id));
    intervene(deps, session, main, { tone: 'presave', trigger: 'presave', also, replay: true });
    result = {
      allow: false,
      guardrail_id: main.guardrail.id,
      guardrail_key: main.guardrail.key,
      quote: quoteFor(session.map, session.language, main.guardrail),
      ...(main.step && { step_id: main.step.id }),
      violations: report,
    };
  } else {
    const [notice, ...rest] = violations.filter((v) => unmentioned(v.guardrail.id));
    if (notice) intervene(deps, session, notice, { tone: 'presave_notice', trigger: 'presave', also: rest, replay: false });
    result = { allow: true, violations: report };
  }
  return { ...result, compute_ms: performance.now() - started };
}
