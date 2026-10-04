import { AgentCommandSchema, makeEvent, STREAMS, type AgentCommand, type Bus } from '../contracts/index.js';
import type { TutorSession } from '../tutor/session.js';

/**
 * Publishes an agent command for the session (ARCHITECTURE §4.5); the gateway forwards it to the
 * page. Validated first, so a malformed command fails here instead of at every consumer.
 */
export async function publishCommand(bus: Bus, session: TutorSession, cmd: AgentCommand): Promise<void> {
  const data = AgentCommandSchema.parse(cmd);
  await bus.publish(
    STREAMS.commands,
    makeEvent({ type: 'agent.command', org_id: session.orgId, session_id: session.id, t_ms: session.lastTms, producer: 'tutor', data }),
  );
  session.log.info({ command: cmd.type, ...ids(cmd) }, 'command published');
}

function ids(cmd: AgentCommand): Record<string, string> {
  const out: Record<string, string> = {};
  if ('step_id' in cmd) out.step_id = cmd.step_id;
  if ('guardrail_id' in cmd) out.guardrail_id = cmd.guardrail_id;
  return out;
}
