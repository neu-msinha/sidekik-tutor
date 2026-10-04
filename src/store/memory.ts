import type { AttemptRow, ExpertRow, InterventionRow, SessionRow, Store, WorkMapRow } from './types.js';

export type ClipRow = { step_id: string; storage_path: string };

export type MemoryData = {
  sessions: SessionRow[];
  experts: ExpertRow[];
  work_maps: WorkMapRow[];
  clips: ClipRow[];
  interventions: InterventionRow[];
  learner_attempts: AttemptRow[];
};

/** In-memory store for tests and `pnpm dev:mock`. `data` is exposed so tests can inspect writes. */
export function memoryStore(seed: Partial<MemoryData> = {}): Store & { data: MemoryData } {
  const data: MemoryData = {
    sessions: [...(seed.sessions ?? [])],
    experts: [...(seed.experts ?? [])],
    work_maps: [...(seed.work_maps ?? [])],
    clips: [...(seed.clips ?? [])],
    interventions: [...(seed.interventions ?? [])],
    learner_attempts: [...(seed.learner_attempts ?? [])],
  };
  const clone = <T>(v: T): T => structuredClone(v);

  return {
    data,
    async getSession(id) {
      return clone(data.sessions.find((s) => s.id === id) ?? null);
    },
    async getExpert(id) {
      return clone(data.experts.find((e) => e.id === id) ?? null);
    },
    async getWorkMap(id) {
      return clone(data.work_maps.find((w) => w.id === id) ?? null);
    },
    async listPublishedWorkMaps() {
      return clone(data.work_maps.filter((w) => w.status === 'published'));
    },
    async getStepClipPath(stepId) {
      return [...data.clips].reverse().find((c) => c.step_id === stepId)?.storage_path ?? null;
    },
    async signStorageUrl(bucket, path, ttlS) {
      return `https://storage.example/${bucket}/${path}?expires_in=${ttlS}`;
    },
    async insertIntervention(row) {
      data.interventions.push(clone(row));
    },
    async resolveIntervention(id) {
      const row = data.interventions.find((r) => r.id === id);
      if (row) row.resolved = true;
    },
    async upsertAttempt(row) {
      const i = data.learner_attempts.findIndex((r) => r.id === row.id);
      if (i >= 0) data.learner_attempts[i] = clone(row);
      else data.learner_attempts.push(clone(row));
    },
  };
}
