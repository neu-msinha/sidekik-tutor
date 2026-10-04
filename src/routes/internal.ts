import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { InvoiceStateSchema } from '../contracts/index.js';
import type { Tutor } from '../tutor/tutor.js';

export type InternalRoutesOptions = { tutor: Tutor };

/** Service-to-service routes; every one needs `X-Internal-Token`. */
export const internalRoutes: FastifyPluginAsync<InternalRoutesOptions> = async (base, opts) => {
  const app = base.withTypeProvider<ZodTypeProvider>();

  // ElevenLabs webhook tools, through the gateway's /v1/tools/* (800 ms budget). Extra fields pass through.
  app.post(
    '/internal/tools/check_guardrails',
    {
      onRequest: app.requireInternal,
      schema: { body: z.object({ session_id: z.string().min(1), state: InvoiceStateSchema.optional() }).passthrough() },
    },
    async (request) => {
      request.log = request.log.child({ session_id: request.body.session_id });
      return opts.tutor.tools.checkGuardrails(request.body, request.log);
    },
  );

  app.post(
    '/internal/tools/get_step',
    {
      onRequest: app.requireInternal,
      schema: { body: z.object({ session_id: z.string().min(1), step_id: z.string().min(1).optional() }).passthrough() },
    },
    async (request) => {
      request.log = request.log.child({ session_id: request.body.session_id });
      return opts.tutor.tools.getStep(request.body, request.log);
    },
  );

  // Also the Tutor Room's replay_moment tool, through the gateway's /v1/tools/expert_moment/:step_id.
  app.post(
    '/internal/tools/get_expert_moment',
    {
      onRequest: app.requireInternal,
      schema: { body: z.object({ step_id: z.string().min(1), session_id: z.string().optional() }).passthrough() },
    },
    async (request) => opts.tutor.tools.getExpertMoment(request.body),
  );

  // The gateway proxies the MiniERP's `POST /v1/sessions/:id/presave` here with a 250 ms budget.
  app.post(
    '/internal/presave',
    {
      onRequest: app.requireInternal,
      schema: { body: z.object({ session_id: z.string().min(1), state: InvoiceStateSchema }) },
    },
    async (request) => {
      request.log = request.log.child({ session_id: request.body.session_id });
      return opts.tutor.presave(request.body.session_id, request.body.state, request.log);
    },
  );
};
