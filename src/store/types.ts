import type { MasterySummary, WorkMap, WorkMapStatus } from '../contracts/index.js';

// Rows as SCHEMA.md defines them; only the columns the tutor reads or writes.

/** gateway's `sessions`. Tutor sessions carry the learner and the Work Map they practise. */
export type SessionRow = {
  id: string;
  org_id: string;
  workflow_id: string;
  kind: 'capture' | 'tutor';
  mode: 'browser' | 'meeting' | 'replay';
  learner_id: string | null;
  workmap_id: string | null;
  language: string;
  ended_at: string | null;
};

export type ExpertRow = { id: string; org_id: string; display_name: string };

/** mapper's `work_maps`; `json` is the full WorkMap (ARCHITECTURE Appendix B). */
export type WorkMapRow = {
  id: string;
  org_id: string;
  workflow_id: string;
  expert_id: string;
  version: number;
  status: WorkMapStatus;
  json: WorkMap;
};

export type Outcome = 'independent_correct' | 'prompted_correct' | 'corrected_after_intervention' | 'not_attempted';

/** tutor's `interventions`. The id is generated here, so rows can be updated without a read back. */
export type InterventionRow = {
  id: string;
  org_id: string;
  session_id: string;
  learner_id: string;
  guardrail_id: string | null;
  step_id: string | null;
  t_ms: number;
  trigger: 'presave' | 'live' | 'divergence';
  style: 'hint_soft' | 'intervene_now';
  resolved: boolean;
};

/** tutor's `learner_attempts`: one per step and case (invoice) in a session. */
export type AttemptRow = {
  id: string;
  org_id: string;
  session_id: string;
  learner_id: string;
  work_map_id: string;
  step_id: string;
  case_ref: string | null;
  predicted: string | null;
  prediction_grade: string | null;
  actual_action: Record<string, unknown> | null;
  outcome: Outcome | null;
};

/** tutor's `mastery`: one per finished tutor session. */
export type MasteryRow = {
  id: string;
  org_id: string;
  session_id: string;
  learner_id: string;
  work_map_id: string;
  summary: MasterySummary;
};

/** tutor's `gap_flags`: one per (work_map_id, step_id, guardrail_id, kind). */
export type GapFlagRow = {
  org_id: string;
  work_map_id: string;
  step_id: string | null;
  guardrail_id: string | null;
  kind: 'guardrail_tripped' | 'prediction_unsure';
  learner_ids: string[];
};

export interface Store {
  getSession(id: string): Promise<SessionRow | null>;
  getExpert(id: string): Promise<ExpertRow | null>;
  getWorkMap(id: string): Promise<WorkMapRow | null>;
  /** Every Work Map with status `published`, for the cache at boot. */
  listPublishedWorkMaps(): Promise<WorkMapRow[]>;
  /** Storage path (bucket `captures`) of perception's newest clip for the step, if any. */
  getStepClipPath(stepId: string): Promise<string | null>;
  signStorageUrl(bucket: string, path: string, ttlS: number): Promise<string>;
  /** A text file from Storage, or null when it doesn't exist. */
  downloadText(bucket: string, path: string): Promise<string | null>;
  insertIntervention(row: InterventionRow): Promise<void>;
  resolveIntervention(id: string): Promise<void>;
  /** Inserts the attempt or replaces it by id. */
  upsertAttempt(row: AttemptRow): Promise<void>;
  insertMastery(row: MasteryRow): Promise<void>;
  /** Distinct learners with an `interventions` row for the guardrail, across sessions. */
  learnersIntervenedOn(guardrailId: string): Promise<string[]>;
  /** Distinct learners whose prediction for the step D9 graded with confidence below `below`. */
  learnersUnsureOn(stepId: string, below: number): Promise<string[]>;
  /**
   * Inserts the flag, or adds its learners to the existing one (reopening it if it was resolved).
   * Returns whether it was new.
   */
  upsertGapFlag(row: GapFlagRow): Promise<{ created: boolean }>;
}
