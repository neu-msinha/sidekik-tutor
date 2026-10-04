import type { FastifyBaseLogger } from 'fastify';
import type {
  Bus,
  Envelope,
  InvoiceState,
  ScreenEvent,
  SessionLifecycle,
  SpeechSignal,
  TranscriptTurn,
  WorkMapPublished,
} from '../contracts/index.js';
import type { Decider } from '../clients/brain.js';
import type { Handlers } from '../services/consumers.js';
import type { Store } from '../store/types.js';
import type { WorkMapCache } from '../workmaps/cache.js';
import { ClipLinks } from './clips.js';
import type { EffectDeps } from './interventions.js';
import { LivePolicy } from './live.js';
import { updateGapFlags } from './gap-flags.js';
import { finishSession } from './mastery.js';
import { PredictLoop } from './predict.js';
import { presave, type PresaveResult } from './presave.js';
import type { TutorSession } from './session.js';
import { TutorSessions } from './sessions.js';
import { TutorTools } from './tools.js';
import { trackStep } from './step-tracker.js';

export type TutorDeps = {
  store: Store;
  bus: Bus;
  cache: WorkMapCache;
  /** Brain `/internal/decide` (D9, D10, D11). */
  decider: Decider;
  log: FastifyBaseLogger;
};

/** The tutor runtime (DESIGN §3): one state per live tutor session, driven by the bus. */
export class Tutor implements Handlers {
  readonly sessions: TutorSessions;
  readonly clips: ClipLinks;
  /** The agent's tools (webhook and MCP). */
  readonly tools: TutorTools;
  private readonly effects: EffectDeps;
  private readonly predict: PredictLoop;
  private readonly live: LivePolicy;

  constructor(private readonly deps: TutorDeps) {
    this.sessions = new TutorSessions(deps.store, deps.cache, deps.log.child({ component: 'tutor' }));
    this.clips = new ClipLinks(deps.store);
    this.effects = { bus: deps.bus, store: deps.store, clips: this.clips };
    this.tools = new TutorTools({ sessions: this.sessions, cache: deps.cache, clips: this.clips, store: deps.store });
    this.predict = new PredictLoop({ bus: deps.bus, store: deps.store, decider: deps.decider });
    this.live = new LivePolicy({ ...this.effects, decider: deps.decider });
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
    this.predict.stop(session);
    await session.idle();
    await finishSession(this.effects, session);
    // After mastery, so this session's rows are counted. A failure must not fail `ended`: a retry
    // would find the session gone and the flags would be lost either way.
    await updateGapFlags(this.deps.store, session).catch((err: unknown) => session.log.error({ err }, 'gap flags failed'));
    session.log.info('tutor session ended');
  }

  async screen(ev: Envelope<ScreenEvent>, log: FastifyBaseLogger): Promise<void> {
    const session = await this.sessions.resolve(ev.session_id, log);
    if (!session) return;
    session.seen(ev.t_ms);
    const opened = session.applyScreen(ev.data);
    if (opened) session.log.info({ record: session.record }, 'record opened');
    this.track(session, ev.data, opened);
    // DESIGN §3: guardrails are evaluated on every field change (dom or vision).
    if (ev.data.type === 'field_changed') await this.live.onFieldChanged(session, ev.data);
  }

  /** Step tracker: moves the current step and counts touched steps as reached. */
  private track(session: TutorSession, ev: ScreenEvent, opened: boolean): void {
    const screen = { app: session.app, recordKind: session.record?.kind };
    const from = session.currentStep;
    const { current, moved, touched } = trackStep(session.map.steps, from, screen, ev, opened);
    for (const step of touched) session.attempt(step.id).reached = true;
    if (current && moved) {
      session.enterStep(current);
      session.log.info({ step_id: current.id, step_key: current.key, from: from?.key }, 'step reached');
      // Reached by changing its field, the learner has already decided: nothing left to predict.
      if (ev.type !== 'field_changed') this.predict.onStep(session, current);
    }
  }

  async turn(ev: Envelope<TranscriptTurn>, log: FastifyBaseLogger): Promise<void> {
    const session = await this.sessions.resolve(ev.session_id, log);
    if (!session) return;
    session.seen(ev.t_ms);
    await this.predict.onTurn(session, ev.data);
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
