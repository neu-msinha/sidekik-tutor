import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { FastifyBaseLogger, FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { InvoiceStateSchema } from '../contracts/index.js';
import type { TutorTools } from '../tutor/tools.js';
import { VERSION } from '../version.js';

export type McpRoutesOptions = { tools: TutorTools };

/** A tool's answer as both JSON text (for any client) and structured content. */
function ok(data: Record<string, unknown>): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data };
}

/** Errors go back to the agent as a tool error it can read, not a protocol error. */
async function run(log: FastifyBaseLogger, tool: string, fn: () => Promise<Record<string, unknown>>): Promise<CallToolResult> {
  try {
    return ok(await fn());
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn({ tool, err: message }, 'mcp tool failed');
    return { isError: true, content: [{ type: 'text', text: message }] };
  }
}

/** The tutor's MCP server: the three tutor tools plus `export_agent_rules`. */
export function createMcpServer(tools: TutorTools, log: FastifyBaseLogger): McpServer {
  const server = new McpServer({ name: 'sidekik-tutor', version: VERSION });

  server.registerTool(
    'check_guardrails',
    {
      description:
        "Checks the learner's invoice against the expert's guardrails. Returns every guardrail that fires (blocking ones stop the save), with the expert's own words.",
      inputSchema: {
        session_id: z.string().describe('The tutor session id ({{session_id}})'),
        state: InvoiceStateSchema.optional().describe('The invoice to check; defaults to the one on the learner’s screen'),
      },
    },
    (args) => run(log, 'check_guardrails', () => tools.checkGuardrails(args, log)),
  );

  server.registerTool(
    'get_step',
    {
      description: 'The step the learner is on, or a requested one (id or key such as "S4"), with the expert’s decision, reason and guardrails.',
      inputSchema: {
        session_id: z.string().describe('The tutor session id ({{session_id}})'),
        step_id: z.string().optional().describe('Step id or key; defaults to the current step'),
      },
    },
    (args) => run(log, 'get_step', () => tools.getStep(args, log)),
  );

  server.registerTool(
    'get_expert_moment',
    {
      description: "The expert's words and screen moment for a step, with a clip URL valid for 10 minutes.",
      inputSchema: { step_id: z.string().describe('Step id') },
    },
    (args) => run(log, 'get_expert_moment', () => tools.getExpertMoment(args)),
  );

  server.registerTool(
    'export_agent_rules',
    {
      description: "A published Work Map as agent rules: AGENT_RULES.md and the guardrails as JSON-Logic.",
      inputSchema: { workmap_id: z.string().describe('Work Map id') },
    },
    (args) => run(log, 'export_agent_rules', () => tools.exportAgentRules(args)),
  );

  return server;
}

const METHOD_NOT_ALLOWED = { jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null };

/**
 * `https://mcp.sidekik.live/mcp` (DESIGN §2): streamable HTTP, stateless (a fresh server and
 * transport per request, no session id), JSON responses. Bearer `SK_TOOL_SECRET`.
 */
export const mcpRoutes: FastifyPluginAsync<McpRoutesOptions> = async (app, opts) => {
  app.post('/mcp', { onRequest: app.requireToolBearer }, async (request, reply) => {
    const server = createMcpServer(opts.tools, request.log);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    reply.raw.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    reply.hijack();
    await transport.handleRequest(request.raw, reply.raw, request.body);
  });

  // Stateless: no server-initiated stream to open and no session to delete.
  for (const method of ['GET', 'DELETE'] as const) {
    app.route({
      method,
      url: '/mcp',
      onRequest: app.requireToolBearer,
      handler: async (_request, reply) => reply.code(405).header('allow', 'POST').send(METHOD_NOT_ALLOWED),
    });
  }
};
