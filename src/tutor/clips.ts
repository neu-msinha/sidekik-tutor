import type { Store } from '../store/types.js';

/** Signed clip URLs live 10 minutes (ARCHITECTURE §6). */
export const CLIP_TTL_S = 600;
/** A cached URL is reused while it has at least this long left. */
const MIN_LEFT_MS = 2 * 60_000;

/**
 * Signed URLs for the expert's screen moment of each step (perception's `clips`, bucket
 * `captures`). Cached per step, so a replay doesn't wait on Storage every time.
 */
export class ClipLinks {
  private readonly cached = new Map<string, { url: string; expiresAt: number }>();

  constructor(private readonly store: Store) {}

  /** The step's clip URL, or null when perception has no clip for it. */
  async forStep(stepId: string): Promise<string | null> {
    const hit = this.cached.get(stepId);
    if (hit && hit.expiresAt - Date.now() > MIN_LEFT_MS) return hit.url;
    const path = await this.store.getStepClipPath(stepId);
    if (!path) return null;
    const url = await this.store.signStorageUrl('captures', path, CLIP_TTL_S);
    this.cached.set(stepId, { url, expiresAt: Date.now() + CLIP_TTL_S * 1000 });
    return url;
  }
}
