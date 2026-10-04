import type { ExpertRow, SessionRow, Store, WorkMapRow } from './types.js';

export type MemoryData = {
  sessions: SessionRow[];
  experts: ExpertRow[];
  work_maps: WorkMapRow[];
};

/** In-memory store for tests and `pnpm dev:mock`. `data` is exposed so tests can inspect writes. */
export function memoryStore(seed: Partial<MemoryData> = {}): Store & { data: MemoryData } {
  const data: MemoryData = {
    sessions: [...(seed.sessions ?? [])],
    experts: [...(seed.experts ?? [])],
    work_maps: [...(seed.work_maps ?? [])],
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
  };
}
