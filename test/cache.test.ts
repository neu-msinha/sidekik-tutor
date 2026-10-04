import { describe, expect, it } from 'vitest';
import { WorkMapCache } from '../src/workmaps/cache.js';
import { DEMO, demoStore, silentLog } from './helpers.js';

describe('WorkMapCache', () => {
  it('loads published maps at boot with the expert name and step lookups', async () => {
    const cache = new WorkMapCache(demoStore());
    await cache.loadPublished(silentLog());
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
    const cache = new WorkMapCache(store);
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
    const cache = new WorkMapCache(store);
    await cache.loadPublished(silentLog());
    expect(cache.size).toBe(0);
    expect(await cache.get(DEMO.workmap)).not.toBeNull();
  });
});
