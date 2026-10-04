import { readFileSync } from 'node:fs';
import { pino } from 'pino';
import type { FastifyBaseLogger } from 'fastify';
import { buildApp, type AppDeps } from '../src/app.js';
import { decided, stubDecider } from '../src/clients/brain.js';
import {
  makeEvent,
  STREAMS,
  type AgentCommand,
  type Bus,
  type Envelope,
  type ScreenEvent,
  type SessionLifecycle,
  type SpeechSignal,
  type StreamKey,
  type TranscriptTurn,
} from '../src/contracts/index.js';
import { DEMO, demoSeed } from '../src/dev/fixtures.js';
import { loadEnv, type Env } from '../src/env.js';
import { startConsumers } from '../src/services/consumers.js';
import { memoryStore } from '../src/store/memory.js';
import { Tutor, type TutorDeps } from '../src/tutor/tutor.js';
import { WorkMapCache } from '../src/workmaps/cache.js';

export { DEMO };

export const SECRETS = { internal: 'i'.repeat(64), tool: 't'.repeat(64) };

export const RAW_ENV: Record<string, string> = {
  PORT: '8084',
  LOG_LEVEL: 'silent',
  REDIS_URL: 'redis://localhost:6379',
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
  SK_INTERNAL_TOKEN: SECRETS.internal,
  SK_TOOL_SECRET: SECRETS.tool,
  BRAIN_URL: 'http://localhost:8082',
};

export const testEnv = (overrides: Record<string, string> = {}): Env => loadEnv({ ...RAW_ENV, ...overrides });

export const silentLog = (): FastifyBaseLogger => pino({ level: 'silent' });

/** A second tutor session with a uuid id, plus a capture session, next to the fixture's. */
export const IDS = {
  session: DEMO.session,
  capture: '00000000-0000-4000-8000-00000000c001',
  replay: '00000000-0000-4000-8000-00000000c002',
};

/** The demo seed: published Work Map, Sabine, Lena's tutor session, and a capture session. */
export function demoStore() {
  const seed = demoSeed();
  const tutorRow = seed.sessions![0]!;
  return memoryStore({
    ...seed,
    sessions: [...seed.sessions!, { ...tutorRow, id: IDS.capture, kind: 'capture', learner_id: null, workmap_id: null, language: 'de' }],
  });
}

export function lifecycleEvent(
  data: Partial<SessionLifecycle> & Pick<SessionLifecycle, 'event'>,
  sessionId = IDS.session,
): Envelope<SessionLifecycle> {
  return makeEvent({
    type: 'session.lifecycle',
    org_id: DEMO.org,
    session_id: sessionId,
    t_ms: 0,
    producer: 'gateway',
    data: { kind: 'tutor', phase: 'tutoring', workflow_id: DEMO.workflow, workmap_id: DEMO.workmap, mode: 'browser', language: 'en', ...data },
  });
}

/** The €7,200 spindle motor from an unknown supplier, on opex 4711 (DESIGN §4). */
export const INVOICE_4510 = {
  invoice_id: '4510',
  supplier: 'Antriebstechnik Nord',
  supplier_known: false,
  net_amount: 7200,
  currency: 'EUR',
  category: 'equipment',
  company_code: 'DE01',
  cost_center: '4711',
  approvals_count: 1,
};

export function screenEvent(
  data: Partial<ScreenEvent> & Pick<ScreenEvent, 'type'>,
  sessionId = IDS.session,
  t_ms = 1000,
): Envelope<ScreenEvent> {
  return makeEvent({
    type: 'screen.event',
    org_id: DEMO.org,
    session_id: sessionId,
    t_ms,
    producer: 'perception',
    data: {
      event_id: `se-${Math.random().toString(36).slice(2)}`,
      state: { app: 'MiniERP', screen: 'invoice', record: INVOICE_4510 },
      confidence: 0.97,
      source: 'dom',
      ...data,
    },
  });
}

export function speechEvent(kind: SpeechSignal['kind'], sessionId = IDS.session): Envelope<SpeechSignal> {
  return makeEvent({
    type: 'speech.signal',
    org_id: DEMO.org,
    session_id: sessionId,
    t_ms: 0,
    producer: 'gateway',
    data: { kind, source: 'sdk' },
  });
}

const DECISION_DEFAULTS: Record<string, [string, number]> = { D9: ['wrong', 0.9] };

/** Brain stand-in: fixed [answer, confidence] per decision; D9 grades every prediction `wrong` unless told otherwise. */
export function testDecider(answers: Record<string, [string, number]> = {}) {
  return stubDecider((id) => {
    const [answer, confidence] = answers[id] ?? DECISION_DEFAULTS[id] ?? ['cannot_tell', 0];
    return decided(id, answer, confidence);
  });
}

export function turnEvent(text: string, role: 'user' | 'agent' = 'user', sessionId = IDS.session): Envelope<TranscriptTurn> {
  return makeEvent({
    type: 'transcript.turn',
    org_id: DEMO.org,
    session_id: sessionId,
    t_ms: 0,
    producer: 'gateway',
    data: { turn_id: `turn-${Math.random().toString(36).slice(2)}`, role, text, lang: 'en', source: 'live', redacted: true },
  });
}

type Handler = (ev: Envelope<unknown>) => Promise<void>;

/** In-memory bus: `deliver` hands an event to the stream's consumer the way the real bus would. */
export function fakeBus() {
  const published: { stream: StreamKey; ev: Envelope<unknown> }[] = [];
  const handlers = new Map<StreamKey, Handler>();
  const bus: Bus & {
    published: typeof published;
    commands(): AgentCommand[];
    deliver(stream: StreamKey, ev: Envelope<unknown>): Promise<void>;
    consuming(stream: StreamKey): boolean;
  } = {
    published,
    commands: () => published.filter((p) => p.stream === STREAMS.commands).map((p) => p.ev.data as AgentCommand),
    async publish(stream, ev) {
      published.push({ stream, ev });
      return `${published.length}-0`;
    },
    consume(stream, handler) {
      handlers.set(stream, handler as Handler);
      return () => handlers.delete(stream);
    },
    async deliver(stream, ev) {
      const handler = handlers.get(stream);
      if (!handler) throw new Error(`no consumer for ${stream}`);
      await handler(ev);
    },
    consuming: (stream) => handlers.has(stream),
    async close() {},
  };
  return bus;
}

export function buildTestApp(overrides: Partial<AppDeps> = {}) {
  return buildApp({
    env: testEnv(),
    bus: fakeBus(),
    store: demoStore(),
    decider: testDecider(),
    healthChecks: {},
    logger: false,
    ...overrides,
  });
}

/** A Tutor on the demo seed, consuming a fake bus. */
export function tutorHarness(overrides: Partial<TutorDeps> = {}) {
  const bus = fakeBus();
  const store = demoStore();
  const cache = new WorkMapCache(store, silentLog());
  const tutor = new Tutor({ store, bus, cache, decider: testDecider(), log: silentLog(), ...overrides });
  const stop = startConsumers({ bus, handlers: tutor, log: silentLog() });
  /** Starts the demo tutor session through the bus and returns its state. */
  const start = async (sessionId = IDS.session) => {
    await bus.deliver(STREAMS.lifecycle, lifecycleEvent({ event: 'started' }, sessionId));
    return tutor.sessions.get(sessionId)!;
  };
  return { bus, store, cache, tutor, stop, start };
}

/**
 * Delivers dev/fixtures/tutor_lena.jsonl to the streams the bus consumes (others, such as DOM
 * events, are skipped), in t_ms order, up to and including `untilTms`.
 */
export async function replayLena(bus: ReturnType<typeof fakeBus>, untilTms = Number.POSITIVE_INFINITY) {
  const lines = readFileSync(new URL('../dev/fixtures/tutor_lena.jsonl', import.meta.url), 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as { stream: StreamKey; ev: Envelope<unknown> })
    .sort((a, b) => a.ev.t_ms - b.ev.t_ms);
  for (const { stream, ev } of lines) {
    if (ev.t_ms > untilTms) break;
    if (bus.consuming(stream)) await bus.deliver(stream, ev);
  }
}
