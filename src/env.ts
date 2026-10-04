import { z } from 'zod';

// Shared secrets are generated with `openssl rand -hex 32` (64 hex chars).
const secret = z.string().min(32, 'must be at least 32 characters (openssl rand -hex 32)');
const url = z.string().url();

// DESIGN §5.
export const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(8084),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  REDIS_URL: url,
  SUPABASE_URL: url,
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),

  SK_INTERNAL_TOKEN: secret,
  /** Bearer for the MCP server; shared with gateway and voice. */
  SK_TOOL_SECRET: secret,

  BRAIN_URL: url,
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment:\n${issues}`);
  }
  return parsed.data;
}
