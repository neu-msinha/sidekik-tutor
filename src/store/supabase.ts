import type { SupabaseClient } from '@supabase/supabase-js';
import type { ExpertRow, SessionRow, Store, WorkMapRow } from './types.js';

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
  };
}
