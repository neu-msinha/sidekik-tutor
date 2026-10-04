import jsonLogic from 'json-logic-js';
import { JSONLOGIC_VARIABLES, type Guardrail, type InvoiceState, type JsonLogic, type Step } from '../contracts/index.js';

const ALLOWED = new Set<string>(JSONLOGIC_VARIABLES);

/** States every rule is test-run against when compiled: an empty record and one with every variable set. */
const PROBES: InvoiceState[] = [
  {},
  {
    net_amount: 1000,
    currency: 'EUR',
    category: 'equipment',
    supplier: 'Probe GmbH',
    supplier_known: true,
    invoice_month: 1,
    company_code: 'DE01',
    cost_center: '4711',
    asset_number: 'AN-1',
    approvals_count: 1,
  },
];

/**
 * Problems that make a rule unusable: not a single-operator JSON-Logic object, a variable outside
 * the normalized InvoiceState, or an operator json-logic-js doesn't know. Empty means valid.
 * Same checks as sidekik-mapper's compiler, so a published map's rules all pass.
 */
export function checkRule(rule: unknown): string[] {
  if (typeof rule !== 'object' || rule === null || Array.isArray(rule) || Object.keys(rule).length !== 1) {
    return ['rule is not a JSON-Logic expression (an object with one operator)'];
  }
  const problems: string[] = [];
  const unknownVars = jsonLogic
    .uses_data(rule)
    .map((v: unknown) => String(v).split('.')[0]!)
    .filter((v: string) => !ALLOWED.has(v));
  if (unknownVars.length > 0) problems.push(`rule reads variables outside InvoiceState: ${[...new Set(unknownVars)].join(', ')}`);
  for (const probe of PROBES) {
    try {
      jsonLogic.apply(rule as JsonLogic, probe);
    } catch (err) {
      problems.push(`rule does not evaluate: ${err instanceof Error ? err.message : String(err)}`);
      break;
    }
  }
  return problems;
}

/** True when the rule fires for this record. */
export function triggers(rule: JsonLogic, state: InvoiceState): boolean {
  return jsonLogic.truthy(jsonLogic.apply(rule, state));
}

/**
 * A guardrail that blocks the save: it requires a field value (G1: cost center 0400) or blocks
 * outright (G2). Guardrails whose consequence is only an action (ask the controller, hold, second
 * approval) can't be satisfied by editing the record, so they are reported but never block.
 */
export function isBlocking(g: Pick<Guardrail, 'consequence'>): boolean {
  return g.consequence.block === true || Object.keys(g.consequence.require ?? {}).length > 0;
}

export type CompiledRule = {
  guardrail: Guardrail;
  /** The step that teaches this guardrail (the first one listing it), if any. */
  step: Step | undefined;
  blocking: boolean;
};

export type CompiledRules = {
  /** Valid rules, blocking first, then by step ordinal and key. */
  rules: CompiledRule[];
  /** Rules that failed `checkRule`; they are never evaluated. */
  invalid: { guardrail_id: string; key: string; problems: string[] }[];
};

/** Compiles a Work Map's guardrails once, when the map is cached. */
export function compileRules(guardrails: Guardrail[], stepOfGuardrail: Map<string, Step>): CompiledRules {
  const rules: CompiledRule[] = [];
  const invalid: CompiledRules['invalid'] = [];
  for (const guardrail of guardrails) {
    const problems = checkRule(guardrail.rule);
    if (problems.length > 0) invalid.push({ guardrail_id: guardrail.id, key: guardrail.key, problems });
    else rules.push({ guardrail, step: stepOfGuardrail.get(guardrail.id), blocking: isBlocking(guardrail) });
  }
  rules.sort(byPriority);
  return { rules, invalid };
}

function byPriority(a: CompiledRule, b: CompiledRule): number {
  if (a.blocking !== b.blocking) return a.blocking ? -1 : 1;
  const ordinal = (r: CompiledRule) => r.step?.ordinal ?? Number.MAX_SAFE_INTEGER;
  return ordinal(a) - ordinal(b) || a.guardrail.key.localeCompare(b.guardrail.key);
}

export type Violation = CompiledRule;

/**
 * Every rule that fires for this record, in priority order (blocking first). Deterministic and
 * model-free: the pre-save check runs on it.
 */
export function evaluate(compiled: CompiledRules, state: InvoiceState): Violation[] {
  return compiled.rules.filter((r) => triggers(r.guardrail.rule, state));
}
