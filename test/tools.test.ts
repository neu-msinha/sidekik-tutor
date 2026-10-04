import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, describe, expect, it } from 'vitest';
import { STREAMS, GetExpertMomentResponseSchema, GetStepResponseSchema } from '../src/contracts/index.js';
import { buildTestApp, DEMO, demoStore, fakeBus, IDS, INVOICE_4510, lifecycleEvent, screenEvent, SECRETS } from './helpers.js';

const STEP = (n: number) => `00000000-0000-4000-8000-${(0x100 + n).toString(16).padStart(12, '0')}`;
const GUARDRAIL = (n: number) => `00000000-0000-4000-8000-${(0x200 + n).toString(16).padStart(12, '0')}`;
const RULES_DIR = `workmaps/org/${DEMO.org}/${DEMO.workmap}/v1`;

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

async function demoApp() {
  const bus = fakeBus();
  const store = demoStore();
  store.data.clips.push({ step_id: STEP(4), storage_path: 'clips/s4.mp4' });
  store.data.storage[`${RULES_DIR}/AGENT_RULES.md`] = '# Supplier invoice coding\n';
  store.data.storage[`${RULES_DIR}/guardrails.jsonlogic.json`] = '{"G1":{}}';
  const app = await buildTestApp({ bus, store });
  await app.ready();
  close = () => app.close();
  await bus.deliver(STREAMS.lifecycle, lifecycleEvent({ event: 'started' }));
  await bus.deliver(STREAMS.screen, screenEvent({ type: 'record_opened', entity: { kind: 'invoice', id: '4510' } }));
  const tool = (name: string, payload: object) =>
    app.inject({ method: 'POST', url: `/internal/tools/${name}`, headers: { 'x-internal-token': SECRETS.internal }, payload });
  return { app, bus, store, tool };
}

describe('tool endpoints', () => {
  it('check_guardrails: what fires on the tracked record, in the expert’s words', async () => {
    const { tool } = await demoApp();
    const res = await tool('check_guardrails', { session_id: IDS.session });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      record: '4510',
      allow_save: false,
      violations: [
        {
          guardrail_id: GUARDRAIL(1),
          key: 'G1',
          blocking: true,
          step_key: 'S4',
          quote: 'Anything over five thousand net for equipment is a fixed asset, so 0400.',
          consequence: { require: { cost_center: '0400' } },
        },
        { key: 'G3', blocking: false, quote: "If I don't know the supplier, I ask the controller first." },
      ],
    });
    expect(res.json().guardrails.map((g: { key: string }) => g.key)).toEqual(['G1', 'G2', 'G3', 'G4', 'G5']);
  });

  it('check_guardrails: a submitted record, without speaking or writing anything', async () => {
    const { bus, store, tool } = await demoApp();
    const res = await tool('check_guardrails', { session_id: IDS.session, state: { ...INVOICE_4510, cost_center: '0400', asset_number: 'AN-1' } });
    expect(res.json()).toMatchObject({ allow_save: true, violations: [{ key: 'G3' }] });
    expect(bus.commands()).toEqual([]);
    expect(store.data.interventions).toEqual([]);
  });

  it('get_step: the current step, or one by id or key', async () => {
    const { bus, tool } = await demoApp();
    await bus.deliver(STREAMS.screen, screenEvent({ type: 'typing_in_progress', field: 'cost_center', entity: { kind: 'invoice', id: '4510' } }));
    const current = await tool('get_step', { session_id: IDS.session });
    expect(current.json()).toEqual({
      step_id: STEP(4),
      key: 'S4',
      ordinal: 4,
      title: 'Code the invoice to a cost center',
      decision: 'Re-coded opex (4711) to capex (0400)',
      quote: '…und dann geht die auf 0400, weil das eine Maschine ist.',
      quote_en: "…and then it goes to 0400, because it's a machine.",
      is_judgment_call: true,
      reason: { quote: "…and then it goes to 0400, because it's a machine.", source_label: 'Sabine, 03:12' },
      guardrails: [expect.objectContaining({ key: 'G1' })],
      current: true,
      total_steps: 7,
    });
    expect(GetStepResponseSchema.safeParse(current.json()).success).toBe(true);
    expect((await tool('get_step', { session_id: IDS.session, step_id: 's5' })).json()).toMatchObject({ key: 'S5', current: false });
    expect((await tool('get_step', { session_id: IDS.session, step_id: STEP(2) })).json()).toMatchObject({ key: 'S2' });
    expect((await tool('get_step', { session_id: IDS.session, step_id: 'S9' })).statusCode).toBe(404);
  });

  it('get_expert_moment: Sabine’s words at 03:12 with a signed clip', async () => {
    const { tool } = await demoApp();
    expect((await tool('get_expert_moment', { step_id: STEP(4) })).json()).toEqual({
      step_id: STEP(4),
      quote: '…und dann geht die auf 0400, weil das eine Maschine ist.',
      quote_en: "…and then it goes to 0400, because it's a machine.",
      label: 'Sabine, 03:12',
      clip_url: 'https://storage.example/captures/clips/s4.mp4?expires_in=600',
    });
    expect(GetExpertMomentResponseSchema.safeParse((await tool('get_expert_moment', { step_id: STEP(4) })).json()).success).toBe(true);
    // No clip cut for S5 yet: the moment comes without clip_url rather than with null.
    const s5 = (await tool('get_expert_moment', { step_id: STEP(5) })).json();
    expect(s5).toMatchObject({ step_id: STEP(5), quote: expect.any(String) });
    expect(s5).not.toHaveProperty('clip_url');
    expect((await tool('get_expert_moment', { step_id: 'nope' })).statusCode).toBe(404);
  });

  it('answers 404 for a session that is not a live tutor session, 401 without the token', async () => {
    const { app, tool } = await demoApp();
    expect((await tool('check_guardrails', { session_id: IDS.capture })).statusCode).toBe(404);
    const res = await app.inject({ method: 'POST', url: '/internal/tools/get_step', payload: { session_id: IDS.session } });
    expect(res.statusCode).toBe(401);
  });
});

describe('MCP server', () => {
  async function mcpClient() {
    const { app } = await demoApp();
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const client = new Client({ name: 'test', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`${address}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${SECRETS.tool}` } },
    });
    await client.connect(transport);
    const prev = close;
    close = async () => {
      await client.close();
      await prev?.();
    };
    return { client, address };
  }

  it('lists the four tools', async () => {
    const { client } = await mcpClient();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['check_guardrails', 'export_agent_rules', 'get_expert_moment', 'get_step']);
  });

  it('calls check_guardrails and get_expert_moment', async () => {
    const { client } = await mcpClient();
    const checked = await client.callTool({ name: 'check_guardrails', arguments: { session_id: IDS.session } });
    expect(checked.structuredContent).toMatchObject({ allow_save: false, violations: [{ key: 'G1' }, { key: 'G3' }] });
    const moment = await client.callTool({ name: 'get_expert_moment', arguments: { step_id: STEP(4) } });
    expect(moment.structuredContent).toMatchObject({ label: 'Sabine, 03:12' });
  });

  it('exports the published agent rules', async () => {
    const { client } = await mcpClient();
    const res = await client.callTool({ name: 'export_agent_rules', arguments: { workmap_id: DEMO.workmap } });
    expect(res.structuredContent).toEqual({
      workmap_id: DEMO.workmap,
      version: 1,
      agent_rules_md: '# Supplier invoice coding\n',
      guardrails_jsonlogic: '{"G1":{}}',
    });
  });

  it('returns tool errors the agent can read', async () => {
    const { client } = await mcpClient();
    const res = await client.callTool({ name: 'get_step', arguments: { session_id: 'no-such-session' } });
    expect(res.isError).toBe(true);
    expect(res.content).toEqual([{ type: 'text', text: 'Not a live tutor session' }]);
  });

  it('needs the tool secret as a bearer token', async () => {
    const { app } = await demoApp();
    const none = await app.inject({ method: 'POST', url: '/mcp', payload: {} });
    const wrong = await app.inject({ method: 'POST', url: '/mcp', headers: { authorization: 'Bearer wrong' }, payload: {} });
    expect([none.statusCode, wrong.statusCode]).toEqual([401, 401]);
    const get = await app.inject({ method: 'GET', url: '/mcp', headers: { authorization: `Bearer ${SECRETS.tool}` } });
    expect(get.statusCode).toBe(405);
  });
});
