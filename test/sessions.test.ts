import { describe, expect, it } from 'vitest';
import { TutorSessions } from '../src/tutor/sessions.js';
import { WorkMapCache } from '../src/workmaps/cache.js';
import { demoStore, IDS, lifecycleEvent, silentLog } from './helpers.js';

describe('TutorSessions', () => {
  it('lets an event that arrives while the session is starting wait for it', async () => {
    const store = demoStore();
    let release: () => void = () => {};
    const getSession = store.getSession.bind(store);
    let calls = 0;
    store.getSession = async (id) => {
      calls++;
      if (calls === 1) await new Promise<void>((r) => (release = r)); // `started` is still loading the row
      return getSession(id);
    };
    const sessions = new TutorSessions(store, new WorkMapCache(store, silentLog()), silentLog());

    const starting = sessions.start(lifecycleEvent({ event: 'started' }), silentLog());
    const resolving = sessions.resolve(IDS.session, silentLog()); // a screen event, mid-start
    release();
    const [started, resolved] = await Promise.all([starting, resolving]);
    expect(started).not.toBeNull();
    expect(resolved).toBe(started);
    expect(calls).toBe(1);
  });

  it('does not teach from a map that is not published', async () => {
    const store = demoStore();
    const map = store.data.work_maps[0]!;
    map.status = 'in_debrief';
    map.json = { ...map.json, status: 'in_debrief' };
    const sessions = new TutorSessions(store, new WorkMapCache(store, silentLog()), silentLog());
    expect(await sessions.start(lifecycleEvent({ event: 'started' }), silentLog())).toBeNull();
    expect(await sessions.resolve(IDS.session, silentLog())).toBeNull();
  });
});
