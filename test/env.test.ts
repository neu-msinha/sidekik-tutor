import { describe, expect, it } from 'vitest';
import { loadEnv } from '../src/env.js';
import { RAW_ENV } from './helpers.js';

describe('loadEnv', () => {
  it('parses a complete environment', () => {
    const env = loadEnv(RAW_ENV);
    expect(env.PORT).toBe(8084);
    expect(env.BRAIN_URL).toBe('http://localhost:8082');
  });

  it('defaults PORT and LOG_LEVEL', () => {
    const { PORT: _p, LOG_LEVEL: _l, ...rest } = RAW_ENV;
    const env = loadEnv(rest);
    expect(env.PORT).toBe(8084);
    expect(env.LOG_LEVEL).toBe('info');
  });

  it('names every missing or invalid variable', () => {
    const { SK_TOOL_SECRET: _t, ...rest } = RAW_ENV;
    expect(() => loadEnv({ ...rest, SK_INTERNAL_TOKEN: 'short', BRAIN_URL: 'not-a-url' })).toThrow(
      /SK_INTERNAL_TOKEN[\s\S]*SK_TOOL_SECRET[\s\S]*BRAIN_URL/,
    );
  });
});
