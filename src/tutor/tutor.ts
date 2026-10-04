import type { FastifyBaseLogger } from 'fastify';
import type {
  Bus,
  Envelope,
  InvoiceState,
  ScreenEvent,
  SessionLifecycle,
  SpeechSignal,
  WorkMapPublished,
} from '../contracts/index.js';
import type { Handlers } from '../services/consumers.js';
import type { Store } from '../store/types.js';
import type { WorkMapCache } from '../workmaps/cache.js';
import { ClipLinks } from './clips.js';
import type { EffectDeps } from './interventions.js';
import { presave, type PresaveResult } from './presave.js';
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
  readonly clips: ClipLinks;
  private readonly effects: EffectDeps;

  constructor(private readonly deps: TutorDeps) {
    this.sessions = new TutorSessions(deps.store, deps.cache, deps.log.child({ component: 'tutor' }));
    this.clips = new ClipLinks(deps.store);
    this.effects = { bus: deps.bus, store: deps.store, clips: this.clips };
  }

  /**
   * The MiniERP pre-save check. Sessions that aren't live tutor sessions (capture sessions have no
   * Work Map to teach) are always allowed.
   */
  async presave(sessionId: string, state: InvoiceState, log: FastifyBaseLogger): Promise<PresaveResult> {
    const session = await this.sessions.resolve(sessionId, log);
    if (!session) {
      log.info('presave for a session that is not a live tutor session; allowed');
      return { allow: true, violations: [] };
    }
    const { compute_ms, ...result } = presave(this.effects, session, state);
    session.log.info(
      {
        allow: result.allow,
        guardrail_key: result.guardrail_key,
        violations: result.violations.map((v) => v.key),
        compute_ms: Math.round(compute_ms * 100) / 100,
      },
      'presave checked',
    );
    return result;
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
    session.seen(ev.t_ms);
    await session.idle();
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
