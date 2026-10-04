import type { FastifyBaseLogger } from 'fastify';
import {
  STREAMS,
  type Bus,
  type Envelope,
  type ScreenEvent,
  type SessionLifecycle,
  type SpeechSignal,
  type TranscriptTurn,
  type WorkMapPublished,
} from '../contracts/index.js';
import { RecentIds } from './recent-ids.js';

/** What the tutor does with each bus event; each handler gets a logger carrying session_id, org_id and event_id. */
export type Handlers = {
  /** `sk:workmap.published`: (re)load the map into the cache. */
  workmapPublished(ev: Envelope<WorkMapPublished>, log: FastifyBaseLogger): Promise<void>;
  /** A capture session: its screen events are none of the tutor's business. */
  notTutor(sessionId: string): void;
  /** Lifecycle `started` of a tutor session: create the learner's state. */
  started(ev: Envelope<SessionLifecycle>, log: FastifyBaseLogger): Promise<void>;
  /** Lifecycle `ended` of a tutor session. */
  ended(ev: Envelope<SessionLifecycle>, log: FastifyBaseLogger): Promise<void>;
  /** Every screen event of a non-replay session; the handler ignores sessions that aren't tutor sessions. */
  screen(ev: Envelope<ScreenEvent>, log: FastifyBaseLogger): Promise<void>;
  speech(ev: Envelope<SpeechSignal>, log: FastifyBaseLogger): Promise<void>;
  /** Transcript turns: learner answers to predictions. */
  turn(ev: Envelope<TranscriptTurn>, log: FastifyBaseLogger): Promise<void>;
};

export type ConsumerDeps = {
  bus: Bus;
  handlers: Handlers;
  log: FastifyBaseLogger;
};

/**
 * Subscribes to the streams the tutor consumes (DESIGN §2) and routes them to the handlers.
 * Returns a function that stops every consumer.
 *
 * Idempotent on `event.id`: an event is remembered only after its handler succeeds, so the bus's
 * retries still re-run a failed handler. Replay sessions are ignored: every lifecycle event of a
 * replay carries `mode: "replay"`, and the session's other events are dropped once it is known as a
 * replay (the handlers also skip sessions whose row says `mode: replay`).
 */
export function startConsumers(deps: ConsumerDeps): () => void {
  const { bus, handlers } = deps;
  const replays = new RecentIds(1_000);

  const eventLog = (ev: Envelope<unknown>) =>
    deps.log.child({ session_id: ev.session_id, org_id: ev.org_id, event_id: ev.id });

  /** Wraps a handler with the event-id dedupe and the replay filter. */
  function route<T>(handle: (ev: Envelope<T>, log: FastifyBaseLogger) => Promise<void>) {
    const seen = new RecentIds();
    return async (ev: Envelope<T>) => {
      if (seen.has(ev.id) || replays.has(ev.session_id)) return;
      await handle(ev, eventLog(ev));
      seen.add(ev.id);
    };
  }

  const onLifecycle = route<SessionLifecycle>(async (ev, log) => {
    const { event, kind, mode } = ev.data;
    if (mode === 'replay') {
      replays.add(ev.session_id);
      handlers.notTutor(ev.session_id);
      log.debug({ event }, 'ignoring replay session event');
    } else if (kind === 'capture') {
      handlers.notTutor(ev.session_id);
    } else if (event === 'started') {
      await handlers.started(ev, log);
    } else if (event === 'ended') {
      await handlers.ended(ev, log);
    }
  });

  const stops = [
    bus.consume<SessionLifecycle>(STREAMS.lifecycle, onLifecycle),
    bus.consume<WorkMapPublished>(STREAMS.workmapPublished, route((ev, log) => handlers.workmapPublished(ev, log))),
    bus.consume<ScreenEvent>(STREAMS.screen, route((ev, log) => handlers.screen(ev, log))),
    bus.consume<SpeechSignal>(STREAMS.speech, route((ev, log) => handlers.speech(ev, log))),
    bus.consume<TranscriptTurn>(STREAMS.turns, route((ev, log) => handlers.turn(ev, log))),
  ];
  return () => {
    for (const stop of stops) stop();
  };
}
