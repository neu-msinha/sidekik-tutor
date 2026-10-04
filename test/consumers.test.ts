import { describe, expect, it } from 'vitest';
import { makeEvent, STREAMS } from '../src/contracts/index.js';
import { DEMO, IDS, lifecycleEvent, screenEvent, speechEvent, tutorHarness } from './helpers.js';

describe('bus wiring', () => {
  it('creates the learner state on started, with the learner and Work Map from the session', async () => {
    const { start } = tutorHarness();
    const session = await start();
    expect(session).toMatchObject({ learnerId: DEMO.learner, language: 'en', orgId: DEMO.org });
    expect(session.workmapId).toBe(DEMO.workmap);
    expect(session.map.expertName).toBe('Sabine');
  });

  it('handles a redelivered started once and keeps the same state', async () => {
    const { bus, tutor } = tutorHarness();
    const ev = lifecycleEvent({ event: 'started' });
    await bus.deliver(STREAMS.lifecycle, ev);
    const first = tutor.sessions.get(IDS.session);
    await bus.deliver(STREAMS.lifecycle, ev);
    await bus.deliver(STREAMS.lifecycle, lifecycleEvent({ event: 'started' }));
    expect(tutor.sessions.get(IDS.session)).toBe(first);
  });

  it('updates the open record from screen events', async () => {
    const { bus, start } = tutorHarness();
    const session = await start();
    await bus.deliver(STREAMS.screen, screenEvent({ type: 'record_opened', entity: { kind: 'invoice', id: '4510' } }));
    expect(session.record).toEqual({ kind: 'invoice', id: '4510' });
    expect(session.invoiceState).toMatchObject({ cost_center: '4711', net_amount: 7200, supplier_known: false });

    await bus.deliver(
      STREAMS.screen,
      screenEvent({ type: 'field_changed', entity: { kind: 'invoice', id: '4510' }, field: 'cost_center', before: '4711', after: '0400' }),
    );
    expect(session.invoiceState.cost_center).toBe('0400');
  });

  it('tracks whether the learner is speaking', async () => {
    const { bus, start } = tutorHarness();
    const session = await start();
    await bus.deliver(STREAMS.speech, speechEvent('user_speech_start'));
    expect(session.speech.userSpeaking).toBe(true);
    await bus.deliver(STREAMS.speech, speechEvent('user_speech_end'));
    expect(session.speech).toMatchObject({ userSpeaking: false, lastUserSpeechAt: expect.any(Number) });
  });

  it('resumes a tutor session it never saw start (after a restart) from its sessions row', async () => {
    const { bus, tutor } = tutorHarness();
    await bus.deliver(STREAMS.screen, screenEvent({ type: 'record_opened', entity: { kind: 'invoice', id: '4510' } }));
    expect(tutor.sessions.get(IDS.session)?.record).toEqual({ kind: 'invoice', id: '4510' });
  });

  it('ignores capture sessions without loading them', async () => {
    const { bus, tutor, store } = tutorHarness();
    let lookups = 0;
    const getSession = store.getSession.bind(store);
    store.getSession = async (id) => {
      lookups++;
      return getSession(id);
    };
    await bus.deliver(STREAMS.lifecycle, lifecycleEvent({ event: 'started', kind: 'capture', phase: 'capture' }, IDS.capture));
    await bus.deliver(STREAMS.screen, screenEvent({ type: 'record_opened' }, IDS.capture));
    await bus.deliver(STREAMS.screen, screenEvent({ type: 'idle' }, IDS.capture));
    expect(tutor.sessions.get(IDS.capture)).toBeUndefined();
    expect(lookups).toBe(0);
  });

  it('ignores every event of a replay session', async () => {
    const { bus, tutor } = tutorHarness();
    await bus.deliver(STREAMS.lifecycle, lifecycleEvent({ event: 'started', mode: 'replay' }, IDS.replay));
    await bus.deliver(STREAMS.screen, screenEvent({ type: 'record_opened' }, IDS.replay));
    expect(tutor.sessions.get(IDS.replay)).toBeUndefined();
  });

  it('forgets the session on ended and ignores its later events', async () => {
    const { bus, tutor, start } = tutorHarness();
    await start();
    await bus.deliver(STREAMS.lifecycle, lifecycleEvent({ event: 'ended', phase: 'done' }));
    expect(tutor.sessions.get(IDS.session)).toBeUndefined();
    await bus.deliver(STREAMS.screen, screenEvent({ type: 'idle' }));
    expect(tutor.sessions.get(IDS.session)).toBeUndefined();
  });

  it('ignores a tutor session whose Work Map does not exist', async () => {
    const { bus, tutor } = tutorHarness();
    await bus.deliver(STREAMS.lifecycle, lifecycleEvent({ event: 'started', workmap_id: 'missing' }, 'other-session'));
    expect(tutor.sessions.get('other-session')).toBeUndefined();
  });

  it('reloads a Work Map on workmap.published', async () => {
    const { bus, cache, store } = tutorHarness();
    const row = store.data.work_maps[0]!;
    const v2 = '00000000-0000-4000-8000-0000000000a2'; // the WorkMap contract requires a uuid id
    store.data.work_maps.push({ ...row, id: v2, version: 2, json: { ...row.json, id: v2, version: 2 } });
    await bus.deliver(
      STREAMS.workmapPublished,
      makeEvent({
        type: 'workmap.published',
        org_id: DEMO.org,
        session_id: 'capture-session',
        t_ms: 0,
        producer: 'mapper',
        data: { workmap_id: v2, workflow_id: DEMO.workflow, version: 2 },
      }),
    );
    expect(cache.peek(v2)?.workmap.version).toBe(2);
  });

  it('re-runs a handler that failed, since the bus retries the same event', async () => {
    const { bus, store, tutor } = tutorHarness();
    const getSession = store.getSession.bind(store);
    let failures = 1;
    store.getSession = async (id) => {
      if (failures-- > 0) throw new Error('db down');
      return getSession(id);
    };
    const ev = lifecycleEvent({ event: 'started' });
    await expect(bus.deliver(STREAMS.lifecycle, ev)).rejects.toThrow('db down');
    await bus.deliver(STREAMS.lifecycle, ev);
    expect(tutor.sessions.get(IDS.session)).toBeDefined();
  });
});
