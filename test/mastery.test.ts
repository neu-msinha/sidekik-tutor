import { describe, expect, it } from 'vitest';
import { STREAMS, type MasterySummary } from '../src/contracts/index.js';
import { caseOutcome, masterySummary } from '../src/tutor/mastery.js';
import type { Attempt } from '../src/tutor/session.js';
import { IDS, INVOICE_4510, lifecycleEvent, replayLena, screenEvent, tutorHarness } from './helpers.js';

const STEP = (n: number) => `00000000-0000-4000-8000-${(0x100 + n).toString(16).padStart(12, '0')}`;
const GUARDRAIL = (n: number) => `00000000-0000-4000-8000-${(0x200 + n).toString(16).padStart(12, '0')}`;

const attempt = (over: Partial<Attempt> = {}): Attempt => ({
  id: 'a',
  stepId: STEP(4),
  caseRef: '4510',
  reached: true,
  saved: false,
  predicted: null,
  grade: null,
  confidence: null,
  intervened: false,
  corrected: false,
  hinted: false,
  ...over,
});

describe('caseOutcome', () => {
  it.each([
    ['reached, nothing said', {}, 'independent_correct'],
    ['predicted right', { predicted: '0400', grade: 'correct_with_reason' }, 'independent_correct'],
    ['predicted wrong, so the agent explained', { predicted: '4711', grade: 'wrong' }, 'prompted_correct'],
    ['no prediction given', { grade: 'no_answer' }, 'prompted_correct'],
    ['a soft hint', { hinted: true }, 'prompted_correct'],
    ['stopped by a guardrail, then fixed', { intervened: true, corrected: true, hinted: true }, 'corrected_after_intervention'],
    ['stopped by a guardrail, never fixed', { intervened: true }, 'not_attempted'],
    ['never got there', { reached: false }, 'not_attempted'],
  ] as const)('%s → %s', (_name, over, outcome) => {
    expect(caseOutcome(attempt(over))).toBe(outcome);
  });
});

describe('mastery on ended (DESIGN §7)', () => {
  async function demoSession() {
    const h = tutorHarness();
    const session = await h.start();
    const entity = { kind: 'invoice', id: '4510' };
    await h.bus.deliver(STREAMS.screen, screenEvent({ type: 'record_opened', entity }));
    for (const state of [
      INVOICE_4510,
      { ...INVOICE_4510, cost_center: '0400' },
      { ...INVOICE_4510, cost_center: '0400', asset_number: 'AN-2026-17' },
    ]) {
      await h.tutor.presave(IDS.session, state, session.log);
    }
    await h.bus.deliver(STREAMS.screen, screenEvent({ type: 'button_clicked', entity, field: 'save' }));
    return { ...h, session };
  }

  it('the §4 demo: step 4 is corrected_after_intervention, and the summary is published last', async () => {
    const { bus, store } = await demoSession();
    await bus.deliver(STREAMS.lifecycle, lifecycleEvent({ event: 'ended', phase: 'done' }));

    const summary = bus.commands().at(-1) as { type: 'summary'; mastery: MasterySummary };
    expect(summary.type).toBe('summary');
    expect(summary.mastery.steps.map((s) => [s.key, s.outcome])).toEqual([
      ['S1', 'prompted_correct'],
      ['S2', 'not_attempted'],
      ['S3', 'not_attempted'],
      ['S4', 'corrected_after_intervention'],
      ['S5', 'corrected_after_intervention'],
      ['S6', 'not_attempted'],
      ['S7', 'independent_correct'],
    ]);
    expect(summary.mastery.counts).toEqual({ independent_correct: 1, prompted_correct: 1, corrected_after_intervention: 2, not_attempted: 3 });
    expect(summary.mastery.practice_next).toEqual([
      { step_id: STEP(4), reason: 'Code the invoice to a cost center (needed a correction)' },
      { step_id: STEP(5), reason: 'Add the asset number (needed a correction)' },
      { guardrail_id: GUARDRAIL(4), reason: 'Kranbau GmbH double-bills in December: put the invoice on hold (never came up)' },
      { guardrail_id: GUARDRAIL(5), reason: 'The Czech subsidiary (CZ01) needs a second approval (never came up)' },
    ]);

    expect(store.data.mastery).toEqual([
      expect.objectContaining({ session_id: IDS.session, learner_id: summary.mastery.learner_id, summary: summary.mastery }),
    ]);
    expect(store.data.learner_attempts.map((a) => [a.case_ref, a.step_id, a.outcome])).toEqual(
      expect.arrayContaining([
        ['4510', STEP(1), 'prompted_correct'],
        ['4510', STEP(4), 'corrected_after_intervention'],
        ['4510', STEP(5), 'corrected_after_intervention'],
        ['4510', STEP(7), 'independent_correct'],
      ]),
    );
    expect(store.data.learner_attempts).toHaveLength(4);
  });

  it('takes the weakest case per step', async () => {
    const { session, bus } = await demoSession();
    // A second invoice where she codes the cost center without help.
    await bus.deliver(STREAMS.screen, screenEvent({ type: 'record_opened', entity: { kind: 'invoice', id: '4501' } }));
    await bus.deliver(STREAMS.screen, screenEvent({ type: 'typing_in_progress', entity: { kind: 'invoice', id: '4501' }, field: 'cost_center' }));
    expect(session.attempt(STEP(4), '4501').reached).toBe(true);
    expect(masterySummary(session).steps.find((s) => s.key === 'S4')?.outcome).toBe('corrected_after_intervention');
  });

  it("Lena's fixture: G2 never fixed, so S5 is to practise", async () => {
    const { bus, store } = tutorHarness();
    await replayLena(bus);
    const summary = (bus.commands().at(-1) as { mastery: MasterySummary }).mastery;
    expect(summary.steps.find((s) => s.key === 'S5')?.outcome).toBe('not_attempted');
    expect(summary.practice_next[0]).toEqual({ step_id: STEP(5), reason: 'Add the asset number (not fixed after an intervention)' });
    expect(store.data.mastery).toHaveLength(1);
  });

  it('publishes the summary but writes nothing without a learner', async () => {
    const { bus, store, start } = tutorHarness();
    store.data.sessions[0]!.learner_id = null;
    await start();
    await bus.deliver(STREAMS.screen, screenEvent({ type: 'record_opened', entity: { kind: 'invoice', id: '4510' } }));
    await bus.deliver(STREAMS.lifecycle, lifecycleEvent({ event: 'ended', phase: 'done' }));
    expect(bus.commands().map((c) => c.type)).toEqual(['summary']);
    expect(bus.commands()[0]).toMatchObject({ mastery: { learner_id: 'anonymous' } });
    expect(store.data.mastery).toEqual([]);
    expect(store.data.learner_attempts).toEqual([]);
  });
});
