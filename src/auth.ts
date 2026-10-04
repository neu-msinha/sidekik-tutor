import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyRequest, onRequestAsyncHookHandler } from 'fastify';
import { unauthorized } from './errors.js';

declare module 'fastify' {
  interface FastifyInstance {
    /** Service-to-service calls (`X-Internal-Token`). Every /internal route uses it. */
    requireInternal: onRequestAsyncHookHandler;
    /** The MCP server: `Authorization: Bearer $SK_TOOL_SECRET` (ARCHITECTURE §4.4). */
    requireToolBearer: onRequestAsyncHookHandler;
  }
}

/** Builds an onRequest hook that checks a header against a shared secret in constant time. */
export function requireSharedSecret(header: string, expected: string): onRequestAsyncHookHandler {
  const expectedDigest = digest(expected);
  return async (request: FastifyRequest) => {
    const value = request.headers[header];
    if (typeof value !== 'string' || !timingSafeEqual(digest(value), expectedDigest)) {
      throw unauthorized(`Missing or invalid ${header}`);
    }
  };
}

/** Builds an onRequest hook that checks `Authorization: Bearer <secret>` in constant time. */
export function requireBearer(expected: string): onRequestAsyncHookHandler {
  const expectedDigest = digest(`Bearer ${expected}`);
  return async (request: FastifyRequest) => {
    const value = request.headers.authorization;
    if (typeof value !== 'string' || !timingSafeEqual(digest(value), expectedDigest)) {
      throw unauthorized('Missing or invalid bearer token');
    }
  };
}

// Hashing first makes the comparison constant-time regardless of input length.
const digest = (s: string) => createHash('sha256').update(s).digest();
