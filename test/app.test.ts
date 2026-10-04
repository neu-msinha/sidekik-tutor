import { describe, expect, it } from 'vitest';
import { STREAMS } from '../src/contracts/index.js';
import { buildTestApp, DEMO, demoStore, fakeBus, SECRETS } from './helpers.js';

describe('app', () => {
  it('reports healthy dependencies with the package version', async () => {
    const app = await buildTestApp({ healthChecks: { redis: async () => {}, supabase: async () => {} } });
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, version: '0.1.0', deps: { redis: true, supabase: true } });
    await app.close();
  });

  it('returns 503 when a dependency is down', async () => {
    const app = await buildTestApp({
      healthChecks: {
        redis: async () => {},
        supabase: async () => {
          throw new Error('connection refused');
        },
      },
    });
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ ok: false, deps: { redis: true, supabase: false } });
    await app.close();
  });

  it('answers unknown routes with a JSON 404 and echoes x-request-id', async () => {
    const app = await buildTestApp();
    const res = await app.inject({ method: 'GET', url: '/nope', headers: { 'x-request-id': 'req-12345678' } });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: 'not_found' });
    expect(res.headers['x-request-id']).toBe('req-12345678');
    await app.close();
  });

  it('guards internal routes with X-Internal-Token', async () => {
    const app = await buildTestApp();
    app.get('/internal/ping', { onRequest: app.requireInternal }, async () => ({ ok: true }));
    const missing = await app.inject({ method: 'GET', url: '/internal/ping' });
    const wrong = await app.inject({ method: 'GET', url: '/internal/ping', headers: { 'x-internal-token': 'nope' } });
    const right = await app.inject({ method: 'GET', url: '/internal/ping', headers: { 'x-internal-token': SECRETS.internal } });
    expect(missing.statusCode).toBe(401);
    expect(wrong.statusCode).toBe(401);
    expect(right.statusCode).toBe(200);
    await app.close();
  });

  it('does not wait for the Work Map cache to be ready', async () => {
    const store = demoStore();
    let release: () => void = () => {};
    store.listPublishedWorkMaps = () => new Promise((resolve) => (release = () => resolve([])));
    const app = await buildTestApp({ store });
    await app.ready();
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    release();
    await app.cacheLoaded();
    await app.close();
  });

  it('loads published Work Maps and starts consuming once ready; stops and closes the bus on close', async () => {
    const bus = fakeBus();
    let closed = false;
    bus.close = async () => {
      closed = true;
    };
    const app = await buildTestApp({ bus });
    expect(bus.consuming(STREAMS.lifecycle)).toBe(false);

    await app.ready();
    await app.cacheLoaded();
    expect(app.cache.peek(DEMO.workmap)?.steps.map((s) => s.key)).toEqual(['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7']);
    for (const stream of [STREAMS.lifecycle, STREAMS.workmapPublished, STREAMS.screen, STREAMS.speech]) {
      expect(bus.consuming(stream)).toBe(true);
    }

    await app.close();
    expect(bus.consuming(STREAMS.lifecycle)).toBe(false);
    expect(closed).toBe(true);
  });
});
