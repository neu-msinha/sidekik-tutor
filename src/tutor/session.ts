import type { FastifyBaseLogger } from 'fastify';
import type { InvoiceState, ScreenEvent } from '../contracts/index.js';
import type { TeachingMap } from '../workmaps/cache.js';

export type RecordRef = { kind: string; id: string };

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
  /** Latest session-timeline time seen on the bus, for the commands tutor publishes. */
  lastTms = 0;
  speech: SpeechState = { userSpeaking: false, lastUserSpeechAt: null, agentSpeaking: false };

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
   * Applies a screen event to the open record. Returns true when a different record opened. A new
   * record replaces the state; the same record merges, so a partial (vision) state keeps the rest.
   */
  applyScreen(ev: ScreenEvent): boolean {
    if (ev.state.app) this.app = ev.state.app;
    const entity = ev.entity ?? recordFromState(ev, this.record);
    const opened = entity !== null && (this.record?.kind !== entity.kind || this.record.id !== entity.id);
    if (opened) {
      this.record = entity;
      this.invoiceState = {};
    }
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
