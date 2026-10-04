import Fastify, { LogController, type FastifyError, type FastifyServerOptions } from 'fastify';
import {
  hasZodFastifySchemaValidationErrors,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { requireBearer, requireSharedSecret } from './auth.js';
import type { Decider } from './clients/brain.js';
import type { Bus } from './contracts/index.js';
import type { Env } from './env.js';
import { HttpError } from './errors.js';
import { genReqId, registerRequestLogging } from './logging.js';
import { healthRoutes, type HealthCheck } from './routes/health.js';
import { internalRoutes } from './routes/internal.js';
import { mcpRoutes } from './routes/mcp.js';
import { startConsumers } from './services/consumers.js';
import type { Store } from './store/types.js';
import { Tutor } from './tutor/tutor.js';
import { VERSION } from './version.js';
import { WorkMapCache } from './workmaps/cache.js';

export type AppDeps = {
  env: Env;
  /** Closed by the app on shutdown. */
  bus: Bus;
  store: Store;
  decider: Decider;
  healthChecks: Record<string, HealthCheck>;
  logger?: FastifyServerOptions['logger'];
};

export async function buildApp(deps: AppDeps) {
  const { env } = deps;

  const logger = deps.logger ?? { level: env.LOG_LEVEL };
  const app = Fastify({
    // Every line names the service and version; Railway shows all services in one stream.
    logger:
      typeof logger === 'object' ? { ...logger, base: { service: 'sidekik-tutor', version: VERSION, pid: process.pid } } : logger,
    // registerRequestLogging writes one line per request instead of Fastify's two.
    logController: new LogController({ disableRequestLogging: true, requestIdLogLabel: 'req_id' }),
    genReqId,
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.setErrorHandler<FastifyError>((err, request, reply) => {
    if (hasZodFastifySchemaValidationErrors(err)) {
      return reply.code(400).send({
        error: 'bad_request',
        message: 'Request validation failed',
        issues: err.validation.map((v) => ({ path: v.instancePath, message: v.message })),
      });
    }
    if (err instanceof HttpError) {
      return reply.code(err.statusCode).send({ error: err.code, message: err.message });
    }
    const status = err.statusCode ?? 500;
    if (status >= 500) {
      request.log.error({ err }, 'unhandled error');
      return reply.code(500).send({ error: 'internal_error', message: 'Internal Server Error' });
    }
    return reply.code(status).send({ error: err.code ?? 'error', message: err.message });
  });

  app.setNotFoundHandler((request, reply) =>
    reply.code(404).send({ error: 'not_found', message: `Route ${request.method} ${request.url} not found` }),
  );

  registerRequestLogging(app);
  app.decorate('requireInternal', requireSharedSecret('x-internal-token', env.SK_INTERNAL_TOKEN));
  app.decorate('requireToolBearer', requireBearer(env.SK_TOOL_SECRET));

  const cache = new WorkMapCache(deps.store, app.log.child({ component: 'cache' }));
  const tutor = new Tutor({ store: deps.store, bus: deps.bus, cache, decider: deps.decider, log: app.log });

  // Once the app is ready: load the published Work Maps, then start consuming. On close: stop
  // consuming, then close the bus.
  let stopConsumers: (() => void) | undefined;
  app.addHook('onReady', async () => {
    await cache.loadPublished();
    stopConsumers = startConsumers({ bus: deps.bus, handlers: tutor, log: app.log.child({ component: 'consumers' }) });
  });
  app.addHook('onClose', async () => {
    stopConsumers?.();
    await deps.bus.close();
  });

  await app.register(healthRoutes, { version: VERSION, checks: deps.healthChecks });
  await app.register(internalRoutes, { tutor });
  await app.register(mcpRoutes, { tools: tutor.tools });

  return Object.assign(app, { tutor, cache });
}

export type App = Awaited<ReturnType<typeof buildApp>>;
