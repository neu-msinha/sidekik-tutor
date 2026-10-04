import { describe, expect, it } from 'vitest';
import { STREAMS } from '../src/contracts/index.js';
import { trackStep } from '../src/tutor/step-tracker.js';
import { toTeachingMap } from '../src/workmaps/cache.js';
import { demoStore, IDS, INVOICE_4510, lifecycleEvent, replayLena, screenEvent, tutorHarness } from './helpers.js';

const steps = toTeachingMap(demoStore().data.work_maps[0]!, 'Sabine').steps;
const byKey = (key: string) => steps.find((s) => s.key === key)!;
const screen = { app: 'MiniERP', recordKind: 'invoice' };
const ev = (type: Parameters<typeof screenEvent>[0]['type'], field?: string, focused?: string) =>
  screenEvent({
    type,
    ...(field && { field }),
    state: { app: 'MiniERP', screen: 'invoice', record: INVOICE_4510, ...(focused && { focused_field: focused }) },
  }).data;

describe('trackStep', () => {
  it('resets to the first step when a record opens', () => {
    const t = trackStep(steps, byKey('S6'), screen, ev('record_opened'), true);
    expect(t).toMatchObject({ current: { key: 'S1' }, moved: true });
    expect(t.touched.map((s) => s.key)).toEqual(['S1']);
  });

  it('moves forward to the step whose field the learner focuses', () => {
    expect(trackStep(steps, byKey('S1'), screen, ev('typing_in_progress', 'cost_center', 'cost_center'), false)).toMatchObject({
      current: { key: 'S4' },
      moved: true,
    });
    expect(trackStep(steps, byKey('S1'), screen, ev('idle', undefined, 'company_code'), false).current?.key).toBe('S3');
    expect(trackStep(steps, byKey('S4'), screen, ev('field_changed', 'asset_number'), false).current?.key).toBe('S5');
  });

  it('does not move back, but still counts the earlier step as touched', () => {
    const t = trackStep(steps, byKey('S5'), screen, ev('field_changed', 'cost_center'), false);
    expect(t).toMatchObject({ current: { key: 'S5' }, moved: false });
    expect(t.touched.map((s) => s.key)).toEqual(['S4']);
  });

  it('ignores fields no step has, other apps and events without a field', () => {
    expect(trackStep(steps, byKey('S1'), screen, ev('field_changed', 'status'), false)).toMatchObject({ current: { key: 'S1' }, moved: false });
    expect(trackStep(steps, byKey('S1'), { app: 'Outlook', recordKind: 'mail' }, ev('field_changed', 'cost_center'), false).moved).toBe(false);
    expect(trackStep(steps, byKey('S1'), screen, ev('value_read', 'cost_center'), false).moved).toBe(false);
  });

  it('a save click is the save step', () => {
    expect(trackStep(steps, byKey('S5'), screen, ev('button_clicked', 'save'), false).current?.key).toBe('S7');
  });
});

describe('step tracking in a session', () => {
  it("follows Lena's fixture: S1 on opening 4510, S7 on saving, back to S1 on 4511", async () => {
    const { bus, start } = tutorHarness();
    const session = await start();
    await replayLena(bus, 1200);
    expect(session.currentStep?.key).toBe('S1');
    await replayLena(bus, 15000);
    expect(session.currentStep?.key).toBe('S7');
    await replayLena(bus, 59999);
    // She recoded the cost center after the save: S4 counts as reached, the tracker stays on S7.
    const reached = [...session.attempts.values()].filter((a) => a.reached && a.caseRef === '4510');
    expect(reached.map((a) => steps.find((s) => s.id === a.stepId)?.key).sort()).toEqual(['S1', 'S4', 'S7']);
    await replayLena(bus, 60200);
    expect(session.record?.id).toBe('4511');
    expect(session.currentStep?.key).toBe('S1');
  });

  it('a blocked save puts the learner back on the guardrail’s step', async () => {
    const { bus, tutor, start } = tutorHarness();
    const session = await start();
    await bus.deliver(STREAMS.screen, screenEvent({ type: 'record_opened', entity: { kind: 'invoice', id: '4510' } }));
    await bus.deliver(STREAMS.screen, screenEvent({ type: 'button_clicked', entity: { kind: 'invoice', id: '4510' }, field: 'save' }));
    expect(session.currentStep?.key).toBe('S7');
    await tutor.presave(IDS.session, INVOICE_4510, session.log);
    expect(session.currentStep?.key).toBe('S4');
  });

  it('starts fresh on every record', async () => {
    const { bus, start } = tutorHarness();
    const session = await start();
    await bus.deliver(STREAMS.lifecycle, lifecycleEvent({ event: 'started' }));
    await bus.deliver(STREAMS.screen, screenEvent({ type: 'record_opened', entity: { kind: 'invoice', id: '4510' } }));
    await bus.deliver(STREAMS.screen, screenEvent({ type: 'field_changed', entity: { kind: 'invoice', id: '4510' }, field: 'asset_number', after: 'AN-1' }));
    expect(session.currentStep?.key).toBe('S5');
    await bus.deliver(STREAMS.screen, screenEvent({ type: 'record_opened', entity: { kind: 'invoice', id: '4501' } }));
    expect(session.currentStep?.key).toBe('S1');
  });
});
