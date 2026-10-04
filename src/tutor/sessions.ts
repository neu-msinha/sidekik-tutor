import type { FastifyBaseLogger } from 'fastify';
import type { Envelope, SessionLifecycle } from '../contracts/index.js';
import { RecentIds } from '../services/recent-ids.js';
import type { Store } from '../store/types.js';
import type { WorkMapCache } from '../workmaps/cache.js';
import { TutorSession } from './session.js';

/** Work Map statuses a tutor session may teach from. */
const TEACHABLE: readonly string[] = ['published', 'retired'];

/**
 * Live tutor sessions. A session is created on its lifecycle `started`, or on first use after a
 * restart (from its `sessions` row). Sessions that aren't live tutor sessions (capture, replay,
 * ended, unknown) are remembered so their screen events don't each cost a database lookup.
 */
export class TutorSessions {
  private readonly live = new Map<string, TutorSession>();
  private readonly other = new RecentIds(10_000);
  private readonly starting = new Map<string, Promise<TutorSession | null>>();
  private readonly resolving = new Map<string, Promise<TutorSession | null>>();

  constructor(
    private readonly store: Store,
    private readonly cache: WorkMapCache,
    /** Base logger; each session logs through a child carrying session_id, org_id and workmap_id. */
    private readonly log: FastifyBaseLogger,
  ) {}

  get(id: string): TutorSession | undefined {
    return this.live.get(id);
  }

  /** Not a live tutor session: ignore its events. */
  markOther(id: string): void {
    this.other.add(id);
  }

  /** Lifecycle `started` (kind tutor): create the learner's state. Idempotent. */
  start(ev: Envelope<SessionLifecycle>, log: FastifyBaseLogger): Promise<TutorSession | null> {
    const existing = this.live.get(ev.session_id);
    if (existing) return Promise.resolve(existing);
    const pending = this.starting.get(ev.session_id);
    if (pending) return pending;
    const start = (async () => {
      const row = await this.store.getSession(ev.session_id);
      const workmapId = ev.data.workmap_id ?? row?.workmap_id ?? null;
      if (!row) log.warn('tutor session has no sessions row; running without a learner');
      return this.create(
        { id: ev.session_id, orgId: ev.org_id, learnerId: row?.learner_id ?? null, language: ev.data.language, workmapId },
        log,
      );
    })().finally(() => this.starting.delete(ev.session_id));
    this.starting.set(ev.session_id, start);
    return start;
  }

  /** The live session, loading it from the database once if this process hasn't seen it start. */
  async resolve(id: string, log: FastifyBaseLogger): Promise<TutorSession | null> {
    const live = this.live.get(id);
    if (live) return live;
    // An event that arrives while `started` is still loading the session waits for it, instead of
    // finding no row yet and marking the session as not a tutor session.
    const starting = this.starting.get(id);
    if (starting) return starting;
    if (this.other.has(id)) return null;
    const pending = this.resolving.get(id);
    if (pending) return pending;
    const load = (async () => {
      const row = await this.store.getSession(id);
      if (!row || row.kind !== 'tutor' || row.mode === 'replay' || row.ended_at) {
        this.markOther(id);
        return null;
      }
      const session = await this.create(
        { id, orgId: row.org_id, learnerId: row.learner_id, language: row.language, workmapId: row.workmap_id },
        log,
      );
      if (session) log.info({ workmap_id: session.workmapId }, 'tutor session resumed');
      return session;
    })().finally(() => this.resolving.delete(id));
    this.resolving.set(id, load);
    return load;
  }

  /** Removes the session (lifecycle `ended`) and returns its final state. */
  end(id: string): TutorSession | undefined {
    const session = this.live.get(id);
    this.live.delete(id);
    this.markOther(id);
    return session;
  }

  private async create(
    s: { id: string; orgId: string; learnerId: string | null; language: string; workmapId: string | null },
    log: FastifyBaseLogger,
  ): Promise<TutorSession | null> {
    if (!s.workmapId) {
      log.warn('tutor session has no work map; ignoring it');
      this.markOther(s.id);
      return null;
    }
    const map = await this.cache.get(s.workmapId);
    if (!map) {
      log.warn({ workmap_id: s.workmapId }, 'work map of tutor session not found; ignoring it');
      this.markOther(s.id);
      return null;
    }
    // Teach only what the expert confirmed and mapper published (retired: a session on an older version).
    if (!TEACHABLE.includes(map.workmap.status)) {
      log.warn({ workmap_id: map.workmap.id, status: map.workmap.status }, 'work map of tutor session is not published; ignoring it');
      this.markOther(s.id);
      return null;
    }
    // A concurrent start/resolve may have finished first.
    const existing = this.live.get(s.id);
    if (existing) return existing;
    const sessionLog = this.log.child({ session_id: s.id, org_id: s.orgId, workmap_id: map.workmap.id });
    const session = new TutorSession(s.id, s.orgId, s.learnerId, s.language, map, sessionLog);
    this.live.set(s.id, session);
    return session;
  }
}
