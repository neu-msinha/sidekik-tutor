import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import { STREAMS } from '../src/contracts/index.js';
import { presave } from '../src/tutor/presave.js';
import {
  buildTestApp,
  demoStore,
  fakeBus,
  IDS,
  INVOICE_4510,
  lifecycleEvent,
  screenEvent,
  SECRETS,
  tutorHarness,
} from './helpers.js';

const STEP = (n: number) => `00000000-0000-4000-8000-${(0x100 + n).toString(16).padStart(12, '0')}`;
const GUARDRAIL = (n: number) => `00000000-0000-4000-8000-${(0x200 + n).toString(16).padStart(12, '0')}`;

/** The test app with Lena's tutor session started and invoice 4510 open; perception has a clip for S4. */
async function demoApp() {
  const bus = fakeBus();
  const store = demoStore();
  store.data.clips.push({ step_id: STEP(4), storage_path: 'org/demo/sessions/sabine/clips/s4.mp4' });
  const app = await buildTestApp({ bus, store });
  await app.ready();
  await bus.deliver(STREAMS.lifecycle, lifecycleEvent({ event: 'started' }));
  await bus.deliver(STREAMS.screen, screenEvent({ type: 'record_opened', entity: { kind: 'invoice', id: '4510' } }, IDS.session, 1200));
  const session = app.tutor.sessions.get(IDS.session)!;
  const save = async (state: object, sessionId = IDS.session) => {
    const res = await app.inject({
      method: 'POST',
      url: '/internal/presave',
      headers: { 'x-internal-token': SECRETS.internal },
      payload: { session_id: sessionId, state },
    });
    await session.idle();
    return res;
  };
  return { app, bus, store, session, save };
}

describe('DESIGN §4 demo case: the save is caught before it goes through', () => {
  it('blocks G1 with Sabine’s words, replays 03:12, reports G3, then G2, then lets the fixed invoice through', async () => {
    const { app, bus, store, save } = await demoApp();

    // 1. €7,200 spindle motor, new supplier, on opex 4711.
    const first = await save(INVOICE_4510);
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({
      allow: false,
      guardrail_id: GUARDRAIL(1),
      guardrail_key: 'G1',
      quote: 'Anything over five thousand net for equipment is a fixed asset, so 0400.',
      step_id: STEP(4),
      violations: [
        { guardrail_id: GUARDRAIL(1), key: 'G1', description: expect.any(String), blocking: true, step_id: STEP(4) },
        { guardrail_id: GUARDRAIL(3), key: 'G3', description: 'Unknown supplier: stop and ask the controller.', blocking: false, step_id: STEP(1) },
      ],
    });
    const [intervene, replay, ...more] = bus.commands();
    expect(intervene).toMatchObject({ type: 'intervene', guardrail_id: GUARDRAIL(1), step_id: STEP(4), field: 'cost_center' });
    expect(intervene).toHaveProperty('text', expect.stringMatching(/^Hold on before you save\. .*Sabine said: "Anything over five thousand/));
    expect(intervene).toHaveProperty('text', expect.stringContaining('Also: Unknown supplier: stop and ask the controller.'));
    expect(replay).toEqual({
      type: 'replay',
      step_id: STEP(4),
      clip_url: 'https://storage.example/captures/org/demo/sessions/sabine/clips/s4.mp4?expires_in=600',
      quote: 'Anything over five thousand net for equipment is a fixed asset, so 0400.',
      label: 'Sabine, 03:12',
    });
    expect(more).toEqual([]);
    expect(store.data.interventions.map((r) => [r.guardrail_id, r.trigger, r.style, r.resolved])).toEqual([
      [GUARDRAIL(1), 'presave', 'intervene_now', false],
      [GUARDRAIL(3), 'presave', 'hint_soft', false],
    ]);

    // 2. Switched to 0400 without an asset number: G2 blocks; G1 counts as corrected.
    const second = await save({ ...INVOICE_4510, cost_center: '0400' });
    expect(second.json()).toMatchObject({ allow: false, guardrail_key: 'G2', step_id: STEP(5) });
    expect(bus.commands().slice(2)).toEqual([expect.objectContaining({ type: 'intervene', guardrail_id: GUARDRAIL(2) })]);
    expect(bus.commands()[2]).toHaveProperty('text', expect.not.stringContaining('Also:'));
    expect(store.data.interventions.find((r) => r.guardrail_id === GUARDRAIL(1))?.resolved).toBe(true);
    expect(store.data.learner_attempts).toEqual([
      expect.objectContaining({ step_id: STEP(4), case_ref: '4510', outcome: 'corrected_after_intervention', learner_id: expect.any(String) }),
    ]);

    // 3. Asset number added: allowed. G3 still fires but was already mentioned.
    const third = await save({ ...INVOICE_4510, cost_center: '0400', asset_number: 'AN-2026-17' });
    expect(third.json()).toEqual({
      allow: true,
      violations: [{ guardrail_id: GUARDRAIL(3), key: 'G3', description: expect.any(String), blocking: false, step_id: STEP(1) }],
    });
    expect(bus.commands()).toHaveLength(3);
    expect(store.data.interventions.find((r) => r.guardrail_id === GUARDRAIL(2))?.resolved).toBe(true);
    expect(store.data.learner_attempts.map((a) => [a.step_id, a.outcome])).toEqual([
      [STEP(4), 'corrected_after_intervention'],
      [STEP(5), 'corrected_after_intervention'],
    ]);
    await app.close();
  });
});

describe('POST /internal/presave', () => {
  it('reminds again on a repeated blocked save, without a second replay or row', async () => {
    const { bus, store, save } = await demoApp();
    await save(INVOICE_4510);
    await save(INVOICE_4510);
    expect(bus.commands().map((c) => c.type)).toEqual(['intervene', 'replay', 'intervene']);
    expect(store.data.interventions).toHaveLength(2);
  });

  it('skips the replay when perception has no clip for the step', async () => {
    const { bus, save } = await demoApp();
    await save({ ...INVOICE_4510, cost_center: '0400' });
    expect(bus.commands().map((c) => c.type)).toEqual(['intervene']);
  });

  it('allows a save that only trips an action guardrail, mentioning it once as a soft notice', async () => {
    const { bus, store, save } = await demoApp();
    const kranbau = { invoice_id: '4511', supplier: 'Kranbau GmbH', supplier_known: true, net_amount: 2150, category: 'services', company_code: 'DE01', invoice_month: 12, approvals_count: 1 };
    expect((await save(kranbau)).json()).toMatchObject({ allow: true, violations: [{ key: 'G4', blocking: false }] });
    expect((await save(kranbau)).json()).toMatchObject({ allow: true });
    expect(bus.commands()).toEqual([
      expect.objectContaining({ type: 'intervene', guardrail_id: GUARDRAIL(4), text: expect.stringMatching(/^Before you save, one thing to check\. Kranbau/) }),
    ]);
    expect(store.data.interventions).toEqual([expect.objectContaining({ guardrail_id: GUARDRAIL(4), style: 'hint_soft', trigger: 'presave' })]);
  });

  it('treats a different invoice id as a new record', async () => {
    const { bus, save, session } = await demoApp();
    await save(INVOICE_4510);
    await save({ ...INVOICE_4510, invoice_id: '4512' });
    expect(session.record).toEqual({ kind: 'invoice', id: '4512' });
    // A new record: G1 is intervened and replayed as new.
    expect(bus.commands().map((c) => c.type)).toEqual(['intervene', 'replay', 'intervene', 'replay']);
  });

  it('always allows capture sessions and unknown sessions', async () => {
    const { bus, save } = await demoApp();
    expect((await save(INVOICE_4510, IDS.capture)).json()).toEqual({ allow: true, violations: [] });
    expect((await save(INVOICE_4510, 'no-such-session')).json()).toEqual({ allow: true, violations: [] });
    expect(bus.commands()).toEqual([]);
  });

  it('resumes a tutor session after a restart and still blocks', async () => {
    const app = await buildTestApp();
    const res = await app.inject({
      method: 'POST',
      url: '/internal/presave',
      headers: { 'x-internal-token': SECRETS.internal },
      payload: { session_id: IDS.session, state: INVOICE_4510 },
    });
    expect(res.json()).toMatchObject({ allow: false, guardrail_key: 'G1' });
    await app.close();
  });

  it('needs the internal token and a valid body', async () => {
    const { app } = await demoApp();
    const noToken = await app.inject({ method: 'POST', url: '/internal/presave', payload: { session_id: IDS.session, state: {} } });
    expect(noToken.statusCode).toBe(401);
    const bad = await app.inject({
      method: 'POST',
      url: '/internal/presave',
      headers: { 'x-internal-token': SECRETS.internal },
      payload: { session_id: IDS.session, state: { net_amount: 'lots' } },
    });
    expect(bad.statusCode).toBe(400);
  });

  it('writes nothing for a session without a learner, but still blocks and speaks', async () => {
    const { bus, store, tutor } = tutorHarness();
    store.data.sessions[0]!.learner_id = null;
    await bus.deliver(STREAMS.lifecycle, lifecycleEvent({ event: 'started' }));
    const result = await tutor.presave(IDS.session, INVOICE_4510, tutor.sessions.get(IDS.session)!.log);
    await tutor.sessions.get(IDS.session)!.idle();
    expect(result.allow).toBe(false);
    expect(bus.commands()[0]?.type).toBe('intervene');
    expect(store.data.interventions).toEqual([]);
  });
});

describe('pre-save latency (DESIGN §6: p99 under 50 ms)', () => {
  const p99 = (samples: number[]) => [...samples].sort((a, b) => a - b)[Math.floor(samples.length * 0.99)]!;

  it('computes the check in well under 50 ms', async () => {
    const { start } = tutorHarness();
    const session = await start();
    const deps = { bus: fakeBus(), store: demoStore(), clips: { forStep: async () => null } as never };
    const samples: number[] = [];
    for (let i = 0; i < 500; i++) {
      const state = { ...INVOICE_4510, cost_center: i % 2 ? '0400' : '4711', ...(i % 3 === 0 && { asset_number: 'AN-1' }) };
      samples.push(presave(deps, session, state).compute_ms);
    }
    expect(p99(samples)).toBeLessThan(50);
  });

  it('answers the route in under 50 ms at p99', async () => {
    const { app, session } = await demoApp();
    const samples: number[] = [];
    for (let i = 0; i < 300; i++) {
      const t0 = performance.now();
      await app.inject({
        method: 'POST',
        url: '/internal/presave',
        headers: { 'x-internal-token': SECRETS.internal },
        payload: { session_id: IDS.session, state: { ...INVOICE_4510, cost_center: i % 2 ? '0400' : '4711' } },
      });
      samples.push(performance.now() - t0);
    }
    await session.idle();
    expect(p99(samples)).toBeLessThan(50);
  });
});
