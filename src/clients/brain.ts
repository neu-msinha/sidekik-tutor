import { DecisionResponseSchema, type DecisionId, type DecisionResult } from '../contracts/index.js';
import { internalClient } from './internal-http.js';

export interface Decider {
  /** One result per requested decision, in request order. */
  decide(sessionId: string, decisions: { id: DecisionId; state: unknown }[]): Promise<DecisionResult[]>;
}

/** Brain `POST /internal/decide` (ARCHITECTURE §4.3: 600 ms per call). */
export function httpDecider(baseUrl: string, internalToken: string, timeoutMs = 600): Decider {
  const client = internalClient(baseUrl, internalToken);
  return {
    async decide(sessionId, decisions) {
      const { results } = await client.post(
        '/internal/decide',
        { session_id: sessionId, decisions },
        DecisionResponseSchema,
        timeoutMs,
      );
      if (results.length !== decisions.length) {
        throw new Error(`/internal/decide returned ${results.length} results for ${decisions.length} decisions`);
      }
      return results;
    },
  };
}

/** A decision result as brain returns it, for stubs and tests. */
export function decided(id: DecisionId, answer: string | number | boolean, confidence: number): DecisionResult {
  return { id, answer, confidence, provider: 'llm', escalated: false, latency_ms: 0 };
}

/** Answers each decision with `answer(id, state)`; used by dev:mock and tests until brain ships D9–D11. */
export function stubDecider(answer: (id: DecisionId, state: unknown) => DecisionResult): Decider {
  return {
    async decide(_sessionId, decisions) {
      return decisions.map((d) => answer(d.id, d.state));
    },
  };
}
