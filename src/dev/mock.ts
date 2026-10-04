// `pnpm dev:mock`: the tutor against real Redis with no teammates' services and no Supabase.
// The store is in memory, seeded with the published demo Work Map and Lena's tutor session
// (dev/fixtures/seed.json), plus a stand-in clip for S4 (signed URLs point at storage.example).
// Brain is a stand-in (src/dev/brain.ts). Drive it with `pnpm dev:replay dev/fixtures/tutor_lena.jsonl`, and try the pre-save check with
// `curl -X POST localhost:8084/internal/presave -H 'x-internal-token: …' -H 'content-type: application/json'
//   -d '{"session_id":"fixture-tutor-lena","state":{…}}'`.
import { buildApp } from '../app.js';
import { createBus } from '../contracts/index.js';
import { loadEnv } from '../env.js';
import { createServiceLogger } from '../logger.js';
import { redisHealth } from '../redis-health.js';
import { memoryStore } from '../store/memory.js';
import { devBrain } from './brain.js';
import { DEMO_STEPS, demoSeed } from './fixtures.js';

const DEV_SECRET = 'dev-mock-secret-not-for-production-0000000000';
const env = loadEnv({
  REDIS_URL: 'redis://localhost:6379',
  SUPABASE_URL: 'http://localhost:54321',
  SUPABASE_SERVICE_ROLE_KEY: 'unused-in-mock',
  SK_INTERNAL_TOKEN: DEV_SECRET,
  SK_TOOL_SECRET: DEV_SECRET,
  BRAIN_URL: 'http://localhost:8082',
  LOG_LEVEL: 'debug',
  ...process.env,
});

const store = memoryStore({
  ...demoSeed(),
  clips: [{ step_id: DEMO_STEPS.S4, storage_path: 'org/demo/sessions/sabine/clips/s4.mp4' }],
});

const log = createServiceLogger(env.LOG_LEVEL);
const bus = createBus(env.REDIS_URL, 'tutor', { logger: log.child({ component: 'bus' }) });
const redis = redisHealth(env.REDIS_URL, log);

const app = await buildApp({
  env,
  bus,
  store,
  decider: devBrain,
  healthChecks: {
    redis: redis.check,
  },
  loggerInstance: log,
});
app.addHook('onClose', redis.close);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    await app.close();
    process.exit(0);
  });
}

await app.listen({ host: '::', port: env.PORT });
app.log.info(`mock ready; internal token and tool secret: ${DEV_SECRET}`);
