// Dev fixtures shared by pnpm dev:mock and the tests.
import { readFileSync } from 'node:fs';
import type { MemoryData } from '../store/memory.js';

const fixture = (name: string) => new URL(`../../dev/fixtures/${name}`, import.meta.url);

/** Fixed ids from sidekik-platform dev/seed/demo.ts and dev/fixtures/tutor_lena.jsonl. */
export const DEMO = {
  org: '00000000-0000-4000-8000-000000000001',
  workflow: '00000000-0000-4000-8000-000000000031',
  workmap: '00000000-0000-4000-8000-000000000041',
  expert: '00000000-0000-4000-8000-000000000011',
  learner: '00000000-0000-4000-8000-000000000021',
  /** The tutor session id used by tutor_lena.jsonl. */
  session: 'fixture-tutor-lena',
};

/** Step ids of the demo Work Map. */
export const DEMO_STEPS = {
  S4: '00000000-0000-4000-8000-000000000104',
  S5: '00000000-0000-4000-8000-000000000105',
};

/** The published demo Work Map, Sabine and Lena's tutor session (dev/fixtures/seed.json). */
export function demoSeed(): Partial<MemoryData> {
  const { _comment, ...data } = JSON.parse(readFileSync(fixture('seed.json'), 'utf8')) as Partial<MemoryData> & {
    _comment?: string;
  };
  return data;
}
