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
  };
}
