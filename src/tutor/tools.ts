import type { FastifyBaseLogger } from 'fastify';
import type { Guardrail, InvoiceState, Step } from '../contracts/index.js';
import { HttpError, notFound } from '../errors.js';
import { evaluate } from '../guardrails/rules.js';
import type { Store } from '../store/types.js';
import type { TeachingMap, WorkMapCache } from '../workmaps/cache.js';
import type { ClipLinks } from './clips.js';
import type { TutorSession } from './session.js';
import type { TutorSessions } from './sessions.js';
import { quoteFor } from './words.js';

export type ToolDeps = { sessions: TutorSessions; cache: WorkMapCache; clips: ClipLinks; store: Store };

/**
 * The agent's tools (DESIGN §2): ElevenLabs calls them as webhook tools through the gateway, or
 * over MCP. Read-only: they never publish commands or write rows, so the agent can call them freely.
 */
export class TutorTools {
  constructor(private readonly deps: ToolDeps) {}

  /** `check_guardrails`: what fires on the submitted (or the tracked) record, in the expert's words. */
  async checkGuardrails(input: { session_id: string; state?: InvoiceState | undefined }, log: FastifyBaseLogger) {
    const session = await this.session(input.session_id, log);
    const state = input.state ?? session.invoiceState;
    const violations = evaluate(session.map.rules, state).map((v) => ({
      ...this.guardrail(session, v.guardrail),
      blocking: v.blocking,
      step_id: v.step?.id ?? null,
      step_key: v.step?.key ?? null,
    }));
    return {
      record: state.invoice_id ?? null,
      allow_save: !violations.some((v) => v.blocking),
      violations,
      guardrails: session.map.rules.rules.map((r) => ({ guardrail_id: r.guardrail.id, key: r.guardrail.key, description: r.guardrail.description })),
    };
  }

  /** `get_step`: the requested step (id or key, e.g. "S4"), or the one the learner is on, in the expert's words. */
  async getStep(input: { session_id: string; step_id?: string | undefined }, log: FastifyBaseLogger) {
    const session = await this.session(input.session_id, log);
    const map = session.map;
    const step = input.step_id
      ? (map.stepById.get(input.step_id) ?? map.steps.find((s) => s.key.toLowerCase() === input.step_id!.toLowerCase()))
      : (session.currentStep ?? map.steps[0]);
    if (!step) throw notFound(input.step_id ? `Step ${input.step_id} not found in this Work Map` : 'This Work Map has no steps');
    return {
      ...this.step(session, step),
      current: step.id === session.currentStep?.id,
      total_steps: map.steps.length,
    };
  }

  /**
   * `get_expert_moment` (GetExpertMomentResponseSchema): the expert's words for a step and a
   * 10-minute clip URL. A step the expert gave no reason for has no moment (404). `clip_url` is left
   * out while perception hasn't cut the clip yet, rather than failing the whole tool.
   */
  async getExpertMoment(input: { step_id: string }) {
    const found = await this.deps.cache.findStepAnywhere(input.step_id);
    if (!found) throw notFound('Step not found in any published Work Map');
    const { map, step } = found;
    if (!step.reason) throw notFound(`${map.expertName} gave no reason for step ${step.key}`);
    const clipUrl = await this.deps.clips.forStep(step.id);
    return {
      step_id: step.id,
      quote: step.reason.quote,
      ...(step.reason.quote_en && { quote_en: step.reason.quote_en }),
      label: step.reason.source_label,
      ...(clipUrl && { clip_url: clipUrl }),
    };
  }

  /** `export_agent_rules` (MCP only): mapper's published `AGENT_RULES.md` and `guardrails.jsonlogic.json`. */
  async exportAgentRules(input: { workmap_id: string }) {
    const map = await this.deps.cache.get(input.workmap_id);
    if (!map) throw notFound('Work Map not found');
    if (!['published', 'retired'].includes(map.workmap.status)) {
      throw new HttpError(409, 'not_published', `Work Map is ${map.workmap.status}; agent rules exist once it is published`);
    }
    const dir = `org/${map.orgId}/${map.workmap.id}/v${map.workmap.version}`;
    const [rules, guardrails] = await Promise.all([
      this.deps.store.downloadText('workmaps', `${dir}/AGENT_RULES.md`),
      this.deps.store.downloadText('workmaps', `${dir}/guardrails.jsonlogic.json`),
    ]);
    if (rules === null) throw notFound('AGENT_RULES.md has not been published for this Work Map');
    return { workmap_id: map.workmap.id, version: map.workmap.version, agent_rules_md: rules, guardrails_jsonlogic: guardrails };
  }

  private async session(id: string, log: FastifyBaseLogger): Promise<TutorSession> {
    const session = await this.deps.sessions.resolve(id, log);
    if (!session) throw notFound('Not a live tutor session');
    return session;
  }

  private guardrail(session: TutorSession, g: Guardrail) {
    return {
      guardrail_id: g.id,
      key: g.key,
      description: g.description,
      quote: quoteFor(session.map, session.language, g),
      consequence: g.consequence,
    };
  }

  private step(session: TutorSession, step: Step) {
    const map: TeachingMap = session.map;
    return {
      step_id: step.id,
      key: step.key,
      ordinal: step.ordinal,
      title: step.title,
      decision: step.decision,
      // GetStepResponseSchema: the expert's words at the top level, original and English.
      ...(step.reason && { quote: step.reason.quote }),
      ...(step.reason?.quote_en && { quote_en: step.reason.quote_en }),
      is_judgment_call: step.is_judgment_call,
      reason: step.reason
        ? { quote: quoteFor(map, session.language, step.reason), source_label: step.reason.source_label }
        : null,
      guardrails: step.guardrail_ids.flatMap((id) => {
        const g = map.guardrailById.get(id);
        return g ? [this.guardrail(session, g)] : [];
      }),
    };
  }
}
