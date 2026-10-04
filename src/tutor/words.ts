import type { Guardrail } from '../contracts/index.js';
import type { CompiledRule } from '../guardrails/rules.js';
import type { TeachingMap } from '../workmaps/cache.js';

/** The expert's words in the learner's language: the original when they share it, else the English. */
export function quoteFor(map: TeachingMap, language: string, q: { quote: string; quote_en?: string | undefined }): string {
  const same = lang(language) === lang(map.workmap.language);
  return same ? q.quote : (q.quote_en ?? q.quote);
}

const lang = (tag: string) => tag.toLowerCase().split(/[-_]/)[0];

/** "Equipment over €5,000 net is always capex: cost center 0400. Sabine said: "…"" */
export function explain(map: TeachingMap, language: string, g: Guardrail): string {
  return `${g.description} ${map.expertName} said: "${quoteFor(map, language, g)}"`;
}

export type InterventionTone = 'presave' | 'presave_notice' | 'intervene_now' | 'hint_soft';

const OPENERS: Record<InterventionTone, string> = {
  presave: 'Hold on before you save.',
  presave_notice: 'Before you save, one thing to check.',
  intervene_now: 'Stop for a moment before you go on.',
  hint_soft: 'A quick hint, no need to stop:',
};

/** The `intervene` text the agent turns into speech, with any other guardrails that fired. */
export function interventionText(
  map: TeachingMap,
  language: string,
  tone: InterventionTone,
  main: CompiledRule,
  also: CompiledRule[] = [],
): string {
  const parts = [OPENERS[tone], explain(map, language, main.guardrail)];
  if (also.length > 0) parts.push(`Also: ${also.map((r) => explain(map, language, r.guardrail)).join(' ')}`);
  return parts.join(' ');
}
