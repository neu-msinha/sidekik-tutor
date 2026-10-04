import { randomUUID } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import type { InvoiceState, ScreenEvent, Step } from '../contracts/index.js';
import type { TeachingMap } from '../workmaps/cache.js';

export type RecordRef = { kind: string; id: string };

/** A guardrail the tutor has spoken about on the open record. */
export type Intervened = {
  guardrailId: string;
  stepId: string | undefined;
  /** The `interventions` row; null when nothing is written (no learner). */
  rowId: string | null;
  resolved: boolean;
  replayed: boolean;
};

/** A prediction the tutor is about to ask, or asked and is waiting to hear back on. */
export type PendingPrediction = {
  stepId: string;
  caseRef: string | null;
  prompt: string;
  phase: 'waiting_quiet' | 'asked';
  /** Wall-clock ms the phase began. */
  since: number;
  timer?: NodeJS.Timeout;
};

/** How the learner did on one step of one case (invoice); becomes a `learner_attempts` row. */
export type Attempt = {
  id: string;
  stepId: string;
  caseRef: string | null;
  /** The learner got to the step on this case (its field, or it was current). */
  reached: boolean;
  /** The row has been written at least once. */
  saved: boolean;
  predicted: string | null;
  grade: string | null;
  /** D9's confidence in the grade. */
  confidence: number | null;
  intervened: boolean;
  corrected: boolean;
};

/** The learner's voice activity, from `sk:speech.signals`. */
export type SpeechState = {
  userSpeaking: boolean;
  /** Wall-clock ms of the learner's last speech start or end. */
  lastUserSpeechAt: number | null;
  agentSpeaking: boolean;
};

/** InvoiceState fields a `field_changed` event's text `after` value can set directly. */
const TEXT_FIELDS = new Set(['invoice_id', 'supplier', 'currency', 'invoice_date', 'company_code', 'category', 'cost_center', 'asset_number']);

/** One tutor session's runtime state (DESIGN §3). Lives in memory for the session's lifetime. */
export class TutorSession {
  /** The record open on the learner's screen. */
  record: RecordRef | null = null;
  app: string | undefined;
  /** The open record, normalized; guardrails are evaluated against it. */
  invoiceState: InvoiceState = {};
  /** The step the learner is on (step tracker). */
  currentStep: Step | undefined;
  /** Latest session-timeline time seen on the bus, for the commands tutor publishes. */
  lastTms = 0;
  speech: SpeechState = { userSpeaking: false, lastUserSpeechAt: null, agentSpeaking: false };
  /** Guardrails the tutor spoke about on the open record, by guardrail id. */
  intervened = new Map<string, Intervened>();
  /** Judgment-call steps the learner has been asked to predict (once per session). */
  readonly predictionsAsked = new Set<string>();
  prediction: PendingPrediction | null = null;
  /** Attempts by `${caseRef}:${stepId}`, for every record of the session. */
  readonly attempts = new Map<string, Attempt>();
  private writes: Promise<void> = Promise.resolve();

  constructor(
    readonly id: string,
    readonly orgId: string,
    /** Null when the session row has no learner (fixtures); nothing is written for it then. */
    readonly learnerId: string | null,
    readonly language: string,
    readonly map: TeachingMap,
    readonly log: FastifyBaseLogger,
  ) {}

  get workmapId(): string {
    return this.map.workmap.id;
  }

  seen(tMs: number): void {
    if (tMs > this.lastTms) this.lastTms = tMs;
  }

  /**
   * Runs side effects (bus commands, database writes) one at a time in order, off the caller's
   * path. A failure is logged and doesn't stop the ones after it.
   */
  enqueue(what: string, fn: () => Promise<void>): void {
    this.writes = this.writes.then(fn).catch((err: unknown) => this.log.error({ err }, `${what} failed`));
  }

  /** Resolves once every enqueued side effect has run. */
  async idle(): Promise<void> {
    let current: Promise<void>;
    do {
      current = this.writes;
      await current;
    } while (current !== this.writes);
  }

  /** The attempt at a step on a case (by default the open record), created on first use. */
  attempt(stepId: string, caseRef: string | null = this.record?.id ?? null): Attempt {
    const key = `${caseRef}:${stepId}`;
    let attempt = this.attempts.get(key);
    if (!attempt) {
      attempt = {
        id: randomUUID(),
        stepId,
        caseRef,
        reached: false,
        saved: false,
        predicted: null,
        grade: null,
        confidence: null,
        intervened: false,
        corrected: false,
      };
      this.attempts.set(key, attempt);
    }
    return attempt;
  }

  /**
   * The record the page submits at save time is authoritative: it replaces the tracked state, and
   * a different invoice id means a different record is open.
   */
  applySubmitted(state: InvoiceState): void {
    if (state.invoice_id && state.invoice_id !== this.record?.id) {
      this.openRecord({ kind: this.record?.kind ?? 'invoice', id: state.invoice_id });
    }
    this.invoiceState = { ...state };
  }

  /** Makes the step current and counts it as reached on the open record. */
  enterStep(step: Step): void {
    this.currentStep = step;
    this.attempt(step.id).reached = true;
  }

  private openRecord(ref: RecordRef): void {
    this.record = ref;
    this.invoiceState = {};
    this.intervened = new Map();
    this.currentStep = undefined;
  }

  /**
   * Applies a screen event to the open record. Returns true when a different record opened. A new
   * record replaces the state; the same record merges, so a partial (vision) state keeps the rest.
   */
  applyScreen(ev: ScreenEvent): boolean {
    if (ev.state.app) this.app = ev.state.app;
    const entity = ev.entity ?? recordFromState(ev, this.record);
    const opened = entity !== null && (this.record?.kind !== entity.kind || this.record.id !== entity.id);
    if (opened) this.openRecord(entity);
    if (ev.state.record) this.invoiceState = { ...this.invoiceState, ...ev.state.record };
    // The change itself wins over a state snapshot that may lag behind it.
    if (ev.type === 'field_changed' && ev.field && TEXT_FIELDS.has(ev.field) && ev.after !== undefined) {
      const fields = this.invoiceState as Record<string, unknown>;
      if (ev.after === '') delete fields[ev.field];
      else fields[ev.field] = ev.after;
    }
    return opened;
  }
}

/** A record named only by its invoice id in the state (e.g. a vision event without an entity). */
function recordFromState(ev: ScreenEvent, current: RecordRef | null): RecordRef | null {
  const invoiceId = ev.state.record?.invoice_id;
  if (!invoiceId) return null;
  return { kind: current?.kind ?? 'invoice', id: invoiceId };
}
