import type { FastifyBaseLogger } from 'fastify';
import type { Guardrail, Step, WorkMap } from '../contracts/index.js';
import { compileRules, type CompiledRules } from '../guardrails/rules.js';
import type { Store, WorkMapRow } from '../store/types.js';

/** A Work Map ready to teach from: the map plus lookups the runtime needs on every event. */
export type TeachingMap = {
  workmap: WorkMap;
  orgId: string;
  /** The expert's display name, for "Sabine says …". */
  expertName: string;
  /** Steps in ordinal order. */
  steps: Step[];
  stepById: Map<string, Step>;
  guardrailById: Map<string, Guardrail>;
  /** The first step (by ordinal) that lists the guardrail; a guardrail no step lists has none. */
  stepOfGuardrail: Map<string, Step>;
  /** The guardrails compiled to JSON-Logic, blocking first. */
  rules: CompiledRules;
};

export function toTeachingMap(row: WorkMapRow, expertName: string): TeachingMap {
  const workmap = row.json;
  const steps = [...workmap.steps].sort((a, b) => a.ordinal - b.ordinal);
  const stepOfGuardrail = new Map<string, Step>();
  for (const step of steps) {
    for (const id of step.guardrail_ids) if (!stepOfGuardrail.has(id)) stepOfGuardrail.set(id, step);
  }
  return {
    rules: compileRules(workmap.guardrails, stepOfGuardrail),
    workmap,
    orgId: row.org_id,
    expertName,
    steps,
    stepById: new Map(steps.map((s) => [s.id, s])),
    guardrailById: new Map(workmap.guardrails.map((g) => [g.id, g])),
    stepOfGuardrail,
  };
}

/**
 * In-memory Work Maps keyed by `workmap_id` (DESIGN §2): every published map is loaded at boot, a
 * map is (re)loaded on `sk:workmap.published`, and any other map a session refers to is loaded on
 * first use. Older versions stay cached, so a session keeps the map it started with.
 */
export class WorkMapCache {
  private readonly maps = new Map<string, TeachingMap>();
  private readonly loading = new Map<string, Promise<TeachingMap | null>>();
  private readonly expertNames = new Map<string, string>();

  constructor(
    private readonly store: Store,
    private readonly log: FastifyBaseLogger,
  ) {}

  get size(): number {
    return this.maps.size;
  }

  /** Loads every published map. A failure is logged; maps then load on first use. */
  async loadPublished(): Promise<void> {
    try {
      const rows = await this.store.listPublishedWorkMaps();
      for (const row of rows) this.keep(toTeachingMap(row, await this.expertName(row.expert_id)));
      this.log.info({ work_maps: rows.length }, 'work map cache loaded');
    } catch (err) {
      this.log.error({ err }, 'loading published work maps failed; they load on first use');
    }
  }

  /** Reloads one map from the database (after `sk:workmap.published`). */
  async refresh(id: string, log: FastifyBaseLogger): Promise<TeachingMap | null> {
    const map = await this.fetch(id);
    if (map) log.info({ workmap_id: id, version: map.workmap.version, steps: map.steps.length }, 'work map cached');
    else log.warn({ workmap_id: id }, 'published work map not found');
    return map;
  }

  /** The cached map, loading it once if it isn't cached yet. */
  async get(id: string): Promise<TeachingMap | null> {
    return this.maps.get(id) ?? this.fetch(id);
  }

  peek(id: string): TeachingMap | undefined {
    return this.maps.get(id);
  }

  /** A step by id from any cached map, with its map. */
  findStep(stepId: string): { map: TeachingMap; step: Step } | null {
    for (const map of this.maps.values()) {
      const step = map.stepById.get(stepId);
      if (step) return { map, step };
    }
    return null;
  }

  private fetch(id: string): Promise<TeachingMap | null> {
    const pending = this.loading.get(id);
    if (pending) return pending;
    const load = (async () => {
      const row = await this.store.getWorkMap(id);
      if (!row) return null;
      return this.keep(toTeachingMap(row, await this.expertName(row.expert_id)));
    })().finally(() => this.loading.delete(id));
    this.loading.set(id, load);
    return load;
  }

  /** Caches the map; a rule that doesn't compile is logged and never applied. */
  private keep(map: TeachingMap): TeachingMap {
    for (const bad of map.rules.invalid) {
      this.log.error({ workmap_id: map.workmap.id, org_id: map.orgId, ...bad }, 'guardrail rule does not compile; it is not applied');
    }
    this.maps.set(map.workmap.id, map);
    return map;
  }

  private async expertName(expertId: string): Promise<string> {
    const known = this.expertNames.get(expertId);
    if (known) return known;
    const name = (await this.store.getExpert(expertId))?.display_name;
    if (!name) return 'the expert';
    this.expertNames.set(expertId, name);
    return name;
  }
}
