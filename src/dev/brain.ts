// A brain stand-in for `pnpm dev:mock` until brain ships D9–D11. Crude on purpose: it only has to
// make the mock's behaviour easy to follow, not to judge well.
import { decided, stubDecider, type Decider } from '../clients/brain.js';

type D9State = { step: { decision: string; reason: string | null }; prediction: string };

const STOP = new Set(['because', 'since', 'there', 'which', 'would', 'their', 'about', 'dann', 'nicht']);

/** Numbers and long words of `text`, lower-cased, without filler words. */
const terms = (text: string) => new Set((text.toLowerCase().match(/\d{3,}|\p{L}{5,}/gu) ?? []).filter((t) => !STOP.has(t)));

/**
 * D9: no answer for "I don't know" or silence; right when the prediction shares a number or a long
 * word with the expert's reason or the decision's last value ("… to capex (0400)"), with a reason
 * if it says why; wrong otherwise.
 */
export function devD9(state: D9State): { answer: string; confidence: number } {
  const text = state.prediction.trim();
  if (!text || /\b(don'?t know|no idea|keine ahnung|weiß nicht)\b/i.test(text)) return { answer: 'no_answer', confidence: 0.9 };
  const lastValue = state.step.decision.match(/\d{3,}(?!.*\d{3,})/)?.[0] ?? '';
  const expected = terms(`${lastValue} ${state.step.reason ?? ''}`);
  const right = [...terms(text)].some((t) => expected.has(t));
  if (!right) return { answer: 'wrong', confidence: 0.8 };
  const why = /\b(because|since|so that|weil|da |denn)\b/i.test(text);
  return { answer: why ? 'correct_with_reason' : 'correct_no_reason', confidence: 0.75 };
}

/** D11: interrupt for a guardrail that blocks the save, a soft hint for the rest. */
export function devD11(state: { guardrail: { blocking: boolean } }): string {
  return state.guardrail.blocking ? 'intervene_now' : 'hint_soft';
}

export const devBrain: Decider = stubDecider((id, state) => {
  if (id === 'D9') {
    const { answer, confidence } = devD9(state as D9State);
    return decided(id, answer, confidence);
  }
  if (id === 'D11') return decided(id, devD11(state as { guardrail: { blocking: boolean } }), 0.8);
  // D10: the stand-in can't tell, so no divergence hints.
  return decided(id, 'cannot_tell', 0);
});
