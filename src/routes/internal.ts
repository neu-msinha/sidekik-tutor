import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { InvoiceStateSchema } from '../contracts/index.js';
import type { Tutor } from '../tutor/tutor.js';

export type InternalRoutesOptions = { tutor: Tutor };

/** Service-to-service routes; every one needs `X-Internal-Token`. */
export const internalRoutes: FastifyPluginAsync<InternalRoutesOptions> = async (base, opts) => {
  const app = base.withTypeProvider<ZodTypeProvider>();

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
