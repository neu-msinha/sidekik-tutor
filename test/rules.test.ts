import { describe, expect, it } from 'vitest';
import type { Guardrail, InvoiceState } from '../src/contracts/index.js';
import { checkRule, compileRules, evaluate, isBlocking, triggers } from '../src/guardrails/rules.js';
import { toTeachingMap, WorkMapCache } from '../src/workmaps/cache.js';
import { demoStore, INVOICE_4510, silentLog } from './helpers.js';

function demoMap() {
  const store = demoStore();
  return toTeachingMap(store.data.work_maps[0]!, 'Sabine');
}

const keys = (vs: { guardrail: Guardrail }[]) => vs.map((v) => v.guardrail.key);
const blocking = (vs: { guardrail: Guardrail; blocking: boolean }[]) => keys(vs.filter((v) => v.blocking));

describe('DESIGN §4 demo case (rules)', () => {
  it('€7,200 spindle motor on opex 4711: G1 blocks with Sabine’s words on step S4; G3 is reported', async () => {
    const map = demoMap();
    const violations = evaluate(map.rules, INVOICE_4510);
    expect(keys(violations)).toEqual(['G1', 'G3']);
    const [first] = violations;
    expect(first).toMatchObject({ blocking: true, step: { key: 'S4' } });
    expect(first!.guardrail.quote_en).toBe('Anything over five thousand net for equipment is a fixed asset, so 0400.');
    expect(first!.step!.screen_moment.label).toBe('03:12');
    expect(violations[1]).toMatchObject({ blocking: false, guardrail: { consequence: { action: 'ask_controller' } } });
  });

  it('switched to 0400 without an asset number: G2 blocks', async () => {
    const map = demoMap();
    const violations = evaluate(map.rules, { ...INVOICE_4510, cost_center: '0400' });
    expect(blocking(violations)).toEqual(['G2']);
    expect(violations[0]).toMatchObject({ step: { key: 'S5' } });
  });

  it('with the asset number added nothing blocks; the unknown supplier is still reported', async () => {
    const map = demoMap();
    const violations = evaluate(map.rules, { ...INVOICE_4510, cost_center: '0400', asset_number: 'AN-2026-17' });
    expect(blocking(violations)).toEqual([]);
    expect(keys(violations)).toEqual(['G3']);
  });
});

describe('demo guardrails G1–G5 on the seed map', () => {
  const routine: InvoiceState = {
    supplier: 'Bürobedarf Weber',
    supplier_known: true,
    net_amount: 240,
    currency: 'EUR',
    category: 'office',
    company_code: 'DE01',
    cost_center: '4711',
    approvals_count: 1,
  };

  it.each([
    ['routine office supplies', routine, []],
    ['Kranbau in December (invoice 4511)', { ...routine, supplier: 'Kranbau GmbH', category: 'services', net_amount: 2150, invoice_month: 12 }, ['G4']],
    ['Kranbau in November', { ...routine, supplier: 'Kranbau GmbH', invoice_month: 11 }, []],
    ['Czech subsidiary, one approval', { ...routine, company_code: 'CZ01' }, ['G5']],
    ['Czech subsidiary, two approvals', { ...routine, company_code: 'CZ01', approvals_count: 2 }, []],
    ['exactly €5,000 of equipment is not capex', { ...routine, category: 'equipment', net_amount: 5000 }, []],
    ['€5,000.01 of equipment is', { ...routine, category: 'equipment', net_amount: 5000.01 }, ['G1']],
  ] as const)('%s', async (_name, state, expected) => {
    const map = demoMap();
    expect(keys(evaluate(map.rules, state))).toEqual(expected);
  });

  it('only G1 and G2 block; G3–G5 are actions', async () => {
    const map = demoMap();
    expect(map.workmap.guardrails.filter(isBlocking).map((g) => g.key)).toEqual(['G1', 'G2']);
  });
});

describe('compileRules', () => {
  const g = (key: string, rule: unknown, consequence: Guardrail['consequence'] = { block: true }) =>
    ({ id: `id-${key}`, key, kind: 'condition', description: key, rule, consequence, quote: '', evidence: [] }) as Guardrail;

  it('drops rules that do not compile instead of applying them', () => {
    const compiled = compileRules(
      [g('G1', { '==': [{ var: 'cost_center' }, '0400'] }), g('G9', { '==': [{ var: 'payment_status' }, 'hold'] }), g('G8', ['x'])],
      new Map(),
    );
    expect(compiled.rules.map((r) => r.guardrail.key)).toEqual(['G1']);
    expect(compiled.invalid).toEqual([
      { guardrail_id: 'id-G9', key: 'G9', problems: ['rule reads variables outside InvoiceState: payment_status'] },
      { guardrail_id: 'id-G8', key: 'G8', problems: ['rule is not a JSON-Logic expression (an object with one operator)'] },
    ]);
  });

  it('orders blocking rules first, then by step and key', () => {
    const always = { '==': [1, 1] };
    const compiled = compileRules([g('G3', always, { action: 'hold' }), g('G2', always), g('G1', always)], new Map());
    expect(compiled.rules.map((r) => r.guardrail.key)).toEqual(['G1', 'G2', 'G3']);
  });

  it('the cache keeps a map with a broken rule and skips only that rule', async () => {
    const store = demoStore();
    const row = store.data.work_maps[0]!;
    row.json.guardrails[0]!.rule = { starts_with: [{ var: 'company_code' }, 'CZ'] };
    const map = (await new WorkMapCache(store, silentLog()).get(row.id))!;
    expect(map.rules.invalid.map((i) => i.key)).toEqual(['G1']);
    expect(map.rules.rules).toHaveLength(4);
  });
});

describe('checkRule and triggers', () => {
  it('rejects unknown operators', () => {
    expect(checkRule({ starts_with: [{ var: 'company_code' }, 'CZ'] })[0]).toMatch(/does not evaluate: Unrecognized operation starts_with/);
  });

  it('treats a missing asset number as missing (G2)', () => {
    const g2 = { and: [{ '==': [{ var: 'cost_center' }, '0400'] }, { '!': { var: 'asset_number' } }] };
    expect(triggers(g2, { cost_center: '0400' })).toBe(true);
    expect(triggers(g2, { cost_center: '0400', asset_number: '' })).toBe(true);
    expect(triggers(g2, { cost_center: '0400', asset_number: 'AN-1' })).toBe(false);
  });
});
