import type { AttemptRow, ExpertRow, GapFlagRow, InterventionRow, MasteryRow, SessionRow, Store, WorkMapRow } from './types.js';

export type StoredGapFlag = GapFlagRow & { status: 'open' | 'sent_to_expert' | 'resolved' };

export type ClipRow = { step_id: string; storage_path: string };

export type MemoryData = {
  sessions: SessionRow[];
  experts: ExpertRow[];
  work_maps: WorkMapRow[];
  clips: ClipRow[];
  interventions: InterventionRow[];
  learner_attempts: AttemptRow[];
  mastery: MasteryRow[];
  gap_flags: StoredGapFlag[];
  /** Storage files by `${bucket}/${path}`. */
  storage: Record<string, string>;
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
    mastery: [...(seed.mastery ?? [])],
    gap_flags: [...(seed.gap_flags ?? [])],
    storage: { ...seed.storage },
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
    async downloadText(bucket, path) {
      return data.storage[`${bucket}/${path}`] ?? null;
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
    async insertMastery(row) {
      data.mastery.push(clone(row));
    },
    async learnersIntervenedOn(guardrailId) {
      return [...new Set(data.interventions.filter((r) => r.guardrail_id === guardrailId).map((r) => r.learner_id))];
    },
    async learnersUnsureOn(stepId, below) {
      const unsure = data.learner_attempts.filter((a) => {
        const confidence = a.actual_action?.prediction_confidence;
        return a.step_id === stepId && typeof confidence === 'number' && confidence < below;
      });
      return [...new Set(unsure.map((a) => a.learner_id))];
    },
    async upsertGapFlag(row) {
      const existing = data.gap_flags.find(
        (f) => f.work_map_id === row.work_map_id && f.kind === row.kind && f.step_id === row.step_id && f.guardrail_id === row.guardrail_id,
      );
      if (!existing) {
        data.gap_flags.push({ ...clone(row), status: 'open' });
        return { created: true };
      }
      const added = row.learner_ids.filter((id) => !existing.learner_ids.includes(id));
      existing.learner_ids = [...existing.learner_ids, ...added];
      if (added.length > 0 && existing.status === 'resolved') existing.status = 'open';
      return { created: false };
    },
  };
}
