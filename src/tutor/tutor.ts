import type { FastifyBaseLogger } from 'fastify';
import type { Bus, Envelope, ScreenEvent, SessionLifecycle, SpeechSignal, WorkMapPublished } from '../contracts/index.js';
import type { Handlers } from '../services/consumers.js';
import type { Store } from '../store/types.js';
import type { WorkMapCache } from '../workmaps/cache.js';
import { TutorSessions } from './sessions.js';

export type TutorDeps = {
  store: Store;
  bus: Bus;
  cache: WorkMapCache;
  log: FastifyBaseLogger;
};

/** The tutor runtime (DESIGN §3): one state per live tutor session, driven by the bus. */
export class Tutor implements Handlers {
  readonly sessions: TutorSessions;

  constructor(private readonly deps: TutorDeps) {
    this.sessions = new TutorSessions(deps.store, deps.cache, deps.log.child({ component: 'tutor' }));
  }

  async workmapPublished(ev: Envelope<WorkMapPublished>, log: FastifyBaseLogger): Promise<void> {
    await this.deps.cache.refresh(ev.data.workmap_id, log);
  }

  notTutor(sessionId: string): void {
    this.sessions.markOther(sessionId);
  }

  async started(ev: Envelope<SessionLifecycle>, log: FastifyBaseLogger): Promise<void> {
    const session = await this.sessions.start(ev, log);
    if (!session) return;
    session.seen(ev.t_ms);
    session.log.info({ learner_id: session.learnerId, steps: session.map.steps.length }, 'tutor session started');
  }

  async ended(ev: Envelope<SessionLifecycle>, _log: FastifyBaseLogger): Promise<void> {
    const session = this.sessions.end(ev.session_id);
    if (!session) return;
    session.log.info('tutor session ended');
  }

  async screen(ev: Envelope<ScreenEvent>, log: FastifyBaseLogger): Promise<void> {
    const session = await this.sessions.resolve(ev.session_id, log);
    if (!session) return;
    session.seen(ev.t_ms);
    if (session.applyScreen(ev.data)) session.log.info({ record: session.record }, 'record opened');
  }

  async speech(ev: Envelope<SpeechSignal>, log: FastifyBaseLogger): Promise<void> {
    const session = await this.sessions.resolve(ev.session_id, log);
    if (!session) return;
    session.seen(ev.t_ms);
    const speech = session.speech;
    switch (ev.data.kind) {
      case 'user_speech_start':
        speech.userSpeaking = true;
        speech.lastUserSpeechAt = Date.now();
        break;
      case 'user_speech_end':
        speech.userSpeaking = false;
        speech.lastUserSpeechAt = Date.now();
        break;
      case 'agent_speech_start':
        speech.agentSpeaking = true;
        break;
      case 'agent_speech_end':
        speech.agentSpeaking = false;
        break;
      case 'typing':
        break;
    }
  }
}
