import { describe, expect, it } from 'vitest';
import { WorkMapCache } from '../src/workmaps/cache.js';
import { DEMO, demoStore, silentLog } from './helpers.js';

describe('WorkMapCache', () => {
  it('loads published maps at boot with the expert name and step lookups', async () => {
    const cache = new WorkMapCache(demoStore(), silentLog());
    await cache.loadPublished();
    const map = cache.peek(DEMO.workmap)!;
    expect(map.expertName).toBe('Sabine');
    expect(map.orgId).toBe(DEMO.org);
    const g1 = map.workmap.guardrails.find((g) => g.key === 'G1')!;
    expect(map.stepOfGuardrail.get(g1.id)?.key).toBe('S4');
    // G5 is listed by S3 and S6: the first step owns it.
    const g5 = map.workmap.guardrails.find((g) => g.key === 'G5')!;
    expect(map.stepOfGuardrail.get(g5.id)?.key).toBe('S3');
    expect(cache.findStep(map.steps[3]!.id)?.step.key).toBe('S4');
  });

  it('loads a map that is not cached once, even when asked concurrently', async () => {
    const store = demoStore();
    let loads = 0;
    const getWorkMap = store.getWorkMap.bind(store);
    store.getWorkMap = async (id) => {
      loads++;
      return getWorkMap(id);
    };
    const cache = new WorkMapCache(store, silentLog());
    const [a, b] = await Promise.all([cache.get(DEMO.workmap), cache.get(DEMO.workmap)]);
    expect(a).toBe(b);
    expect(loads).toBe(1);
    expect(await cache.get('missing')).toBeNull();
  });

  it('keeps running when the boot load fails', async () => {
    const store = demoStore();
    store.listPublishedWorkMaps = async () => {
      throw new Error('db down');
    };
    const cache = new WorkMapCache(store, silentLog());
    await cache.loadPublished();
    expect(cache.size).toBe(0);
    expect(await cache.get(DEMO.workmap)).not.toBeNull();
  });

  it('finds a step of a map it has not cached yet (after a restart)', async () => {
    const store = demoStore();
    const cache = new WorkMapCache(store, silentLog());
    const s4 = store.data.work_maps.find((w) => w.id === DEMO.workmap)!.json.steps.find((s) => s.key === 'S4')!;
    expect(cache.findStep(s4.id)).toBeNull();
    expect((await cache.findStepAnywhere(s4.id))?.step.key).toBe('S4');
    expect(await cache.findStepAnywhere('00000000-0000-4000-8000-0000000000ff')).toBeNull();
  });

  it('never teaches a map that breaks the WorkMap contract', async () => {
    const store = demoStore();
    const row = store.data.work_maps.find((w) => w.id === DEMO.workmap)!;
    row.json = { ...row.json, steps: row.json.steps.map((s, i) => (i === 0 ? { ...s, title: '' } : s)) };
    const cache = new WorkMapCache(store, silentLog());
    await cache.loadPublished();
    expect(cache.peek(DEMO.workmap)).toBeUndefined();
    expect(await cache.get(DEMO.workmap)).toBeNull();
  });
});
