// `pnpm dev:mock`: the tutor against real Redis with no teammates' services and no Supabase.
// The store is in memory, seeded with the published demo Work Map and Lena's tutor session
// (dev/fixtures/seed.json). Drive it with `pnpm dev:replay dev/fixtures/tutor_lena.jsonl`.
import { buildApp } from '../app.js';
import { createBus } from '../contracts/index.js';
import { loadEnv } from '../env.js';
import { memoryStore } from '../store/memory.js';
import { demoSeed } from './fixtures.js';

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

const store = memoryStore(demoSeed());

let app: Awaited<ReturnType<typeof buildApp>>;
const bus = createBus(env.REDIS_URL, 'tutor', {
  warn: (obj, msg) => app.log.warn(obj, msg),
  error: (obj, msg) => app.log.error(obj, msg),
});

app = await buildApp({
  env,
  bus,
  store,
  healthChecks: {
    redis: async () => {
      await bus.redis.ping();
    },
  },
  logger: { level: env.LOG_LEVEL, transport: { target: 'pino-pretty' } },
});
bus.redis.on('error', (err) => app.log.warn({ err: err.message }, 'redis error'));

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    await app.close();
    process.exit(0);
  });
}

await app.listen({ host: '::', port: env.PORT });
app.log.info(`mock ready; internal token and tool secret: ${DEV_SECRET}`);
