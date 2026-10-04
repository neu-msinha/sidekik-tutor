import type { SupabaseClient } from '@supabase/supabase-js';
import type { ExpertRow, GapFlagRow, SessionRow, Store, WorkMapRow } from './types.js';

type Result<T> = { data: T | null; error: { message: string; code?: string } | null };

function unwrap<T>({ data, error }: Result<T>, what: string): T {
  if (error) throw new Error(`${what}: ${error.message}`);
  return data as T;
}

const SESSION_COLUMNS = 'id, org_id, workflow_id, kind, mode, learner_id, workmap_id, language, ended_at';
const WORK_MAP_COLUMNS = 'id, org_id, workflow_id, expert_id, version, status, json';

/** Service-role store: reads any table, writes only the tutor's tables (ARCHITECTURE §6). */
export function supabaseStore(db: SupabaseClient): Store {
  return {
    async getSession(id) {
      const res = await db.from('sessions').select(SESSION_COLUMNS).eq('id', id).maybeSingle();
      return unwrap<SessionRow | null>(res, 'load session');
    },

    async getExpert(id) {
      const res = await db.from('experts').select('id, org_id, display_name').eq('id', id).maybeSingle();
      return unwrap<ExpertRow | null>(res, 'load expert');
    },

    async getWorkMap(id) {
      const res = await db.from('work_maps').select(WORK_MAP_COLUMNS).eq('id', id).maybeSingle();
      return unwrap<WorkMapRow | null>(res, 'load work map');
    },

    async listPublishedWorkMaps() {
      const res = await db.from('work_maps').select(WORK_MAP_COLUMNS).eq('status', 'published');
      return unwrap<WorkMapRow[]>(res, 'load published work maps');
    },

    async getStepClipPath(stepId) {
      const res = await db
        .from('clips')
        .select('storage_path')
        .eq('step_id', stepId)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      return unwrap<{ storage_path: string } | null>(res, 'load clip')?.storage_path ?? null;
    },

    async signStorageUrl(bucket, path, ttlS) {
      const { data, error } = await db.storage.from(bucket).createSignedUrl(path, ttlS);
      if (error || !data) throw new Error(`sign ${bucket}/${path}: ${error?.message ?? 'no url'}`);
      return data.signedUrl;
    },

    async downloadText(bucket, path) {
      const { data, error } = await db.storage.from(bucket).download(path);
      if (error) {
        // storage-js: a missing object is a StorageApiError with status 404 or code NoSuchKey.
        const e = error as { status?: number; statusCode?: string; code?: string };
        if (e.status === 404 || e.statusCode === '404' || e.code === 'NoSuchKey') return null;
        throw new Error(`download ${bucket}/${path}: ${error.message}`);
      }
      return data.text();
    },

    async insertIntervention(row) {
      unwrap(await db.from('interventions').insert(row), 'insert intervention');
    },

    async resolveIntervention(id) {
      unwrap(await db.from('interventions').update({ resolved: true }).eq('id', id), 'resolve intervention');
    },

    async upsertAttempt(row) {
      unwrap(await db.from('learner_attempts').upsert(row), 'upsert learner attempt');
    },

    async insertMastery(row) {
      unwrap(await db.from('mastery').insert(row), 'insert mastery');
    },

    async learnersIntervenedOn(guardrailId) {
      const res = await db.from('interventions').select('learner_id').eq('guardrail_id', guardrailId);
      return [...new Set(unwrap<{ learner_id: string }[]>(res, 'load interventions').map((r) => r.learner_id))];
    },

    async learnersUnsureOn(stepId, below) {
      const res = await db
        .from('learner_attempts')
        .select('learner_id, actual_action')
        .eq('step_id', stepId)
        .not('prediction_grade', 'is', null);
      const rows = unwrap<{ learner_id: string; actual_action: { prediction_confidence?: unknown } | null }[]>(res, 'load attempts');
      const unsure = rows.filter((r) => {
        const confidence = r.actual_action?.prediction_confidence;
        return typeof confidence === 'number' && confidence < below;
      });
      return [...new Set(unsure.map((r) => r.learner_id))];
    },

    async upsertGapFlag(row) {
      // Not an upsert: the unique key has nullable columns, and NULLs never conflict in Postgres.
      let query = db.from('gap_flags').select('id, learner_ids, status').eq('work_map_id', row.work_map_id).eq('kind', row.kind);
      query = row.step_id === null ? query.is('step_id', null) : query.eq('step_id', row.step_id);
      query = row.guardrail_id === null ? query.is('guardrail_id', null) : query.eq('guardrail_id', row.guardrail_id);
      const existing = unwrap<{ id: string; learner_ids: string[]; status: string } | null>(await query.maybeSingle(), 'load gap flag');
      if (!existing) {
        unwrap(await db.from('gap_flags').insert(row), 'insert gap flag');
        return { created: true };
      }
      const added = row.learner_ids.filter((id) => !existing.learner_ids.includes(id));
      if (added.length === 0) return { created: false };
      const patch: { learner_ids: string[]; status?: string } = { learner_ids: [...existing.learner_ids, ...added] };
      if (existing.status === 'resolved') patch.status = 'open';
      unwrap(await db.from('gap_flags').update(patch).eq('id', existing.id), 'update gap flag');
      return { created: false };
    },
  };
}
