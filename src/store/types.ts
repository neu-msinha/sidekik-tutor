import type { WorkMap, WorkMapStatus } from '../contracts/index.js';

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

export interface Store {
  getSession(id: string): Promise<SessionRow | null>;
  getExpert(id: string): Promise<ExpertRow | null>;
  getWorkMap(id: string): Promise<WorkMapRow | null>;
  /** Every Work Map with status `published`, for the cache at boot. */
  listPublishedWorkMaps(): Promise<WorkMapRow[]>;
}
