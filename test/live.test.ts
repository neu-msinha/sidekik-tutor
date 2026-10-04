import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decided, stubDecider } from '../src/clients/brain.js';
import { STREAMS, type DecisionId, type InvoiceState } from '../src/contracts/index.js';
import { IDS, INVOICE_4510, screenEvent, tutorHarness } from './helpers.js';

const STEP = (n: number) => `00000000-0000-4000-8000-${(0x100 + n).toString(16).padStart(12, '0')}`;
const GUARDRAIL = (n: number) => `00000000-0000-4000-8000-${(0x200 + n).toString(16).padStart(12, '0')}`;
const OFFICE_4501: InvoiceState = {
  invoice_id: '4501',
  supplier: 'Bürobedarf Weber',
  supplier_known: true,
  net_amount: 240,
  currency: 'EUR',
  category: 'office',
  company_code: 'DE01',
  cost_center: '4711',
  approvals_count: 1,
};

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

/** A brain whose answers can change mid-test; every call is recorded. */
function scriptedBrain(answers: Partial<Record<DecisionId, [string, number] | Error>>) {
  const calls: { id: DecisionId; state: Record<string, unknown> }[] = [];
  const decider = stubDecider((id, state) => {
    calls.push({ id, state: state as Record<string, unknown> });
    const a = answers[id];
    if (a instanceof Error) throw a;
    return decided(id, a?.[0] ?? 'cannot_tell', a?.[1] ?? 0);
  });
  return { decider, calls, answers };
}

async function setup(answers: Partial<Record<DecisionId, [string, number] | Error>>, record: InvoiceState = INVOICE_4510) {
  const brain = scriptedBrain(answers);
  const h = tutorHarness({ decider: brain.decider });
  const session = await h.start();
  const entity = { kind: 'invoice', id: record.invoice_id! };
  let state = { ...record };
  await h.bus.deliver(STREAMS.screen, screenEvent({ type: 'record_opened', entity, state: { app: 'MiniERP', record: state } }));
  /** The learner changes one field; the screen event carries the whole record, as perception sends it. */
  const change = async (field: keyof InvoiceState, after: string) => {
    const before = String(state[field] ?? '');
    state = { ...state, [field]: after };
    await h.bus.deliver(
      STREAMS.screen,
      screenEvent({ type: 'field_changed', entity, field, before, after, state: { app: 'MiniERP', record: state } }),
    );
    await session.idle();
  };
  return { ...h, ...brain, session, change, commands: () => h.bus.commands() };
}

describe('live rule engine and D11', () => {
  it('intervene_now: the learner books capex without an asset number', async () => {
    const { store, calls, change, commands } = await setup({ D11: ['intervene_now', 0.9] });
    store.data.clips.push({ step_id: STEP(5), storage_path: 'clips/s5.mp4' });
    await change('cost_center', '0400');

    expect(calls).toEqual([
      {
        id: 'D11',
        state: expect.objectContaining({
          guardrail: { key: 'G2', kind: 'condition', description: 'No asset number, no capex booking.', blocking: true },
          pending_ms: 0,
          field: 'cost_center',
          changed: { field: 'cost_center', before: '4711', after: '0400' },
        }),
      },
    ]);
    expect(commands()).toEqual([
      expect.objectContaining({ type: 'intervene', guardrail_id: GUARDRAIL(2), step_id: STEP(5), field: 'asset_number' }),
      expect.objectContaining({ type: 'replay', step_id: STEP(5), label: 'Sabine, 03:34' }),
    ]);
    expect(commands()[0]).toHaveProperty('text', expect.stringMatching(/^Stop for a moment before you go on\. No asset number.*Also: Unknown supplier/));
    expect(store.data.interventions.map((r) => [r.guardrail_id, r.trigger, r.style])).toEqual([
      [GUARDRAIL(2), 'live', 'intervene_now'],
      [GUARDRAIL(3), 'live', 'hint_soft'],
    ]);
  });

  it('hint_soft: a softer intervene and no replay', async () => {
    const { change, commands } = await setup({ D11: ['hint_soft', 0.7] });
    await change('cost_center', '0400');
    expect(commands().map((c) => c.type)).toEqual(['intervene']);
    expect(commands()[0]).toHaveProperty('text', expect.stringMatching(/^A quick hint, no need to stop: No asset number/));
  });

  it('wait_and_watch: says nothing, asks D11 again on the next change with the time it has been pending', async () => {
    const { answers, calls, session, change, commands } = await setup({ D11: ['wait_and_watch', 0.8] });
    await change('cost_center', '0400');
    expect(commands()).toEqual([]);
    expect([...session.violationsPending.keys()]).toEqual([GUARDRAIL(2), GUARDRAIL(3)]);

    vi.advanceTimersByTime(4_000);
    answers.D11 = ['intervene_now', 0.9];
    await change('company_code', 'DE01');
    expect(calls.map((c) => c.state.pending_ms)).toEqual([0, 4_000]);
    expect(commands().map((c) => c.type)).toEqual(['intervene']);
    expect(session.violationsPending.size).toBe(0);
  });

  it('a violation fixed while pending is dropped', async () => {
    const { session, change } = await setup({ D11: ['wait_and_watch', 0.8] });
    await change('cost_center', '0400');
    await change('asset_number', 'AN-1');
    expect([...session.violationsPending.keys()]).toEqual([GUARDRAIL(3)]);
  });

  it('hints softly when brain is down', async () => {
    const { change, commands } = await setup({ D11: new Error('brain unreachable') });
    await change('cost_center', '0400');
    expect(commands()[0]).toHaveProperty('text', expect.stringMatching(/^A quick hint/));
  });

  it('a corrected violation resolves its row and the step’s attempt', async () => {
    const { store, change } = await setup({ D11: ['intervene_now', 0.9] });
    await change('cost_center', '0400');
    await change('asset_number', 'AN-1');
    expect(store.data.interventions.find((r) => r.guardrail_id === GUARDRAIL(2))?.resolved).toBe(true);
    expect(store.data.learner_attempts).toEqual([expect.objectContaining({ step_id: STEP(5), outcome: 'corrected_after_intervention' })]);
  });

  it('does not speak again about what the pre-save check already said', async () => {
    const { tutor, session, calls, change, commands } = await setup({ D11: ['intervene_now', 0.9] });
    await tutor.presave(IDS.session, { ...INVOICE_4510, cost_center: '0400' }, session.log);
    await session.idle();
    const before = commands().length;
    await change('cost_center', '0400');
    expect(calls.filter((c) => c.id === 'D11')).toEqual([]);
    expect(commands()).toHaveLength(before);
  });

  it('only field changes are evaluated', async () => {
    const { bus, calls } = await setup({ D11: ['intervene_now', 0.9] });
    await bus.deliver(STREAMS.screen, screenEvent({ type: 'typing_in_progress', field: 'cost_center', entity: { kind: 'invoice', id: '4510' } }));
    await bus.deliver(STREAMS.screen, screenEvent({ type: 'idle', entity: { kind: 'invoice', id: '4510' } }));
    expect(calls).toEqual([]);
  });
});

describe('D10 divergence', () => {
  it('a judgment call no guardrail covers that diverges gets one soft hint', async () => {
    const { store, calls, change, commands } = await setup({ D10: ['diverges', 0.86] }, OFFICE_4501);
    await change('cost_center', '4712');
    expect(calls).toEqual([
      {
        id: 'D10',
        state: expect.objectContaining({
          step: expect.objectContaining({ title: 'Code the invoice to a cost center' }),
          learner_action: { field: 'cost_center', before: '4711', after: '4712' },
        }),
      },
    ]);
    expect(commands()).toEqual([
      expect.objectContaining({
        type: 'intervene',
        guardrail_id: GUARDRAIL(1),
        step_id: STEP(4),
        text: expect.stringMatching(/^A quick hint, no need to stop: Sabine did this step differently: Re-coded opex/),
      }),
    ]);
    expect(store.data.interventions).toEqual([
      expect.objectContaining({ trigger: 'divergence', style: 'hint_soft', guardrail_id: null, step_id: STEP(4) }),
    ]);

    // Once per step and record.
    await change('cost_center', '4713');
    expect(calls).toHaveLength(1);
  });

  it('no hint below 0.80, or for an acceptable variant', async () => {
    const low = await setup({ D10: ['diverges', 0.7] }, OFFICE_4501);
    await low.change('cost_center', '4712');
    const fine = await setup({ D10: ['acceptable_variant', 0.95] }, OFFICE_4501);
    await fine.change('cost_center', '4712');
    expect([...low.commands(), ...fine.commands()]).toEqual([]);
  });

  it('is not asked for a step that is not a judgment call', async () => {
    const { calls, change } = await setup({ D10: ['diverges', 0.9] }, OFFICE_4501);
    await change('asset_number', 'AN-1'); // S5
    expect(calls).toEqual([]);
  });

  it('is not asked when a guardrail fires on the change: that is D11’s', async () => {
    const { calls, change } = await setup({ D10: ['diverges', 0.9], D11: ['wait_and_watch', 0.8] }, OFFICE_4501);
    await change('cost_center', '0400'); // G2: capex without an asset number
    expect(calls.map((c) => c.id)).toEqual(['D11']);
  });
});
