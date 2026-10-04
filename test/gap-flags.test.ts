import { describe, expect, it } from 'vitest';
import { STREAMS } from '../src/contracts/index.js';
import { DEMO, IDS, INVOICE_4510, lifecycleEvent, screenEvent, testDecider, turnEvent, tutorHarness } from './helpers.js';

const STEP = (n: number) => `00000000-0000-4000-8000-${(0x100 + n).toString(16).padStart(12, '0')}`;
const GUARDRAIL = (n: number) => `00000000-0000-4000-8000-${(0x200 + n).toString(16).padStart(12, '0')}`;
const LEARNERS = ['learner-a', 'learner-b', 'learner-c'];

/** One harness, one tutor session per learner. */
function cohort(decider = testDecider()) {
  const h = tutorHarness({ decider });
  const template = h.store.data.sessions[0]!;
  LEARNERS.forEach((learner, i) => h.store.data.sessions.push({ ...template, id: `session-${i}`, learner_id: learner }));

  /** Runs a learner's session: opens 4510 and does `work`, then ends it. */
  const run = async (i: number, work: (sessionId: string) => Promise<void>) => {
    const sessionId = `session-${i}`;
    await h.bus.deliver(STREAMS.lifecycle, lifecycleEvent({ event: 'started' }, sessionId));
    await h.bus.deliver(STREAMS.screen, screenEvent({ type: 'record_opened', entity: { kind: 'invoice', id: '4510' } }, sessionId));
    await work(sessionId);
    await h.tutor.sessions.get(sessionId)?.idle();
    await h.bus.deliver(STREAMS.lifecycle, lifecycleEvent({ event: 'ended', phase: 'done' }, sessionId));
  };
  const saveOn4711 = (sessionId: string) => h.tutor.presave(sessionId, INVOICE_4510, h.tutor.sessions.get(sessionId)!.log).then(() => {});
  const predict = (answer: string) => async (sessionId: string) => {
    await h.bus.deliver(STREAMS.screen, screenEvent({ type: 'typing_in_progress', entity: { kind: 'invoice', id: '4510' }, field: 'cost_center' }, sessionId));
    await h.tutor.sessions.get(sessionId)!.idle();
    await h.bus.deliver(STREAMS.turns, turnEvent(answer, 'user', sessionId));
  };
  return { ...h, run, saveOn4711, predict };
}

describe('gap flags', () => {
  it('flags a blocking guardrail once two learners trip it, and adds later learners', async () => {
    const { store, run, saveOn4711 } = cohort();
    await run(0, saveOn4711);
    expect(store.data.gap_flags).toEqual([]);

    await run(1, saveOn4711);
    expect(store.data.gap_flags).toEqual([
      {
        org_id: DEMO.org,
        work_map_id: DEMO.workmap,
        kind: 'guardrail_tripped',
        guardrail_id: GUARDRAIL(1),
        step_id: STEP(4),
        learner_ids: ['learner-a', 'learner-b'],
        status: 'open',
      },
    ]);

    await run(2, saveOn4711);
    expect(store.data.gap_flags).toHaveLength(1);
    expect(store.data.gap_flags[0]!.learner_ids).toEqual(LEARNERS);
  });

  it('does not flag guardrails that only report (G3 fired for everyone)', async () => {
    const { store, run, saveOn4711 } = cohort();
    await run(0, saveOn4711);
    await run(1, saveOn4711);
    expect(store.data.gap_flags.map((f) => f.guardrail_id)).not.toContain(GUARDRAIL(3));
  });

  it('reopens a resolved flag when a new learner trips it', async () => {
    const { store, run, saveOn4711 } = cohort();
    await run(0, saveOn4711);
    await run(1, saveOn4711);
    store.data.gap_flags[0]!.status = 'resolved';
    await run(2, saveOn4711);
    expect(store.data.gap_flags[0]).toMatchObject({ status: 'open', learner_ids: LEARNERS });
  });

  it('flags a step when D9 is unsure (< 0.55) about two learners’ predictions', async () => {
    const { store, run, predict } = cohort(testDecider({ D9: ['partially', 0.4] }));
    await run(0, predict('Maybe 4711? Or something else'));
    expect(store.data.gap_flags).toEqual([]);
    await run(1, predict('I think 0400 but not sure why'));
    expect(store.data.gap_flags).toEqual([
      expect.objectContaining({ kind: 'prediction_unsure', step_id: STEP(4), guardrail_id: null, learner_ids: ['learner-a', 'learner-b'] }),
    ]);
  });

  it('a sure D9 grade is no gap', async () => {
    const { store, run, predict } = cohort(testDecider({ D9: ['wrong', 0.9] }));
    await run(0, predict('4711'));
    await run(1, predict('4711'));
    expect(store.data.gap_flags).toEqual([]);
  });

  it('a session without a learner raises nothing', async () => {
    const { store, bus, tutor } = tutorHarness();
    store.data.sessions[0]!.learner_id = null;
    await bus.deliver(STREAMS.lifecycle, lifecycleEvent({ event: 'started' }));
    await tutor.presave(IDS.session, INVOICE_4510, tutor.sessions.get(IDS.session)!.log);
    await bus.deliver(STREAMS.lifecycle, lifecycleEvent({ event: 'ended', phase: 'done' }));
    expect(store.data.gap_flags).toEqual([]);
  });

  it('a failing gap flag write does not fail the session end', async () => {
    const { store, run, saveOn4711, bus } = cohort();
    store.upsertGapFlag = async () => {
      throw new Error('db down');
    };
    await run(0, saveOn4711);
    await expect(run(1, saveOn4711)).resolves.toBeUndefined();
    expect(bus.commands().filter((c) => c.type === 'summary')).toHaveLength(2);
  });
});
