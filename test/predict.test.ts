import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stubDecider } from '../src/clients/brain.js';
import { STREAMS, type DecisionId } from '../src/contracts/index.js';
import { devD9 } from '../src/dev/brain.js';
import { ANSWER_MS, MAX_WAIT_MS, QUIET_MS } from '../src/tutor/predict.js';
import { screenEvent, speechEvent, testDecider, turnEvent, tutorHarness } from './helpers.js';

const S4 = '00000000-0000-4000-8000-000000000104';
const PROMPT = '€7,200 equipment from Antriebstechnik Nord: code the invoice to a cost center. What would Sabine do here, and why?';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

async function setup(overrides: Parameters<typeof tutorHarness>[0] = {}) {
  const h = tutorHarness(overrides);
  const session = await h.start();
  const screen = (type: Parameters<typeof screenEvent>[0]['type'], field?: string, id = '4510') =>
    h.bus.deliver(STREAMS.screen, screenEvent({ type, entity: { kind: 'invoice', id }, ...(field && { field }) }));
  await screen('record_opened');
  const commands = async () => {
    await session.idle();
    return h.bus.commands();
  };
  return { ...h, session, screen, commands };
}

describe('predict loop', () => {
  it('asks for a prediction at a judgment-call step and grades the answer with D9', async () => {
    const seen: { id: DecisionId; state: unknown }[] = [];
    const decider = stubDecider((id, state) => {
      seen.push({ id, state });
      return { id, answer: 'wrong', confidence: 0.92, provider: 'jev', escalated: false, latency_ms: 40 };
    });
    const { bus, store, session, screen, commands } = await setup({ decider });

    await screen('typing_in_progress', 'cost_center');
    expect(await commands()).toEqual([{ type: 'predict', step_id: S4, prompt: PROMPT }]);

    await bus.deliver(STREAMS.turns, turnEvent('Before you code this one…', 'agent'));
    await bus.deliver(STREAMS.turns, turnEvent("I'd leave it on 4711, like the office stuff."));
    await session.idle();
    expect(seen).toEqual([
      {
        id: 'D9',
        state: expect.objectContaining({
          expert: 'Sabine',
          step: { title: 'Code the invoice to a cost center', decision: 'Re-coded opex (4711) to capex (0400)', reason: "…and then it goes to 0400, because it's a machine." },
          prompt: PROMPT,
          prediction: "I'd leave it on 4711, like the office stuff.",
        }),
      },
    ]);
    expect(store.data.learner_attempts).toEqual([
      expect.objectContaining({
        step_id: S4,
        case_ref: '4510',
        predicted: "I'd leave it on 4711, like the office stuff.",
        prediction_grade: 'wrong',
        actual_action: { prediction_confidence: 0.92 },
        outcome: null,
      }),
    ]);

    // Only the first learner turn is the prediction.
    await bus.deliver(STREAMS.turns, turnEvent('Actually, 0400.'));
    expect(seen).toHaveLength(1);
  });

  it('waits until the learner has been quiet for 1.5 s', async () => {
    const { bus, screen, commands } = await setup();
    await bus.deliver(STREAMS.speech, speechEvent('user_speech_start'));
    await screen('typing_in_progress', 'cost_center');
    vi.advanceTimersByTime(QUIET_MS * 2);
    expect(await commands()).toEqual([]);

    await bus.deliver(STREAMS.speech, speechEvent('user_speech_end'));
    vi.advanceTimersByTime(QUIET_MS - 1);
    expect(await commands()).toEqual([]);
    vi.advanceTimersByTime(QUIET_MS);
    expect((await commands()).map((c) => c.type)).toEqual(['predict']);
  });

  it('does not talk over the agent either', async () => {
    const { bus, screen, commands } = await setup();
    await bus.deliver(STREAMS.speech, speechEvent('agent_speech_start'));
    await screen('typing_in_progress', 'cost_center');
    vi.advanceTimersByTime(QUIET_MS * 3);
    expect(await commands()).toEqual([]);
    await bus.deliver(STREAMS.speech, speechEvent('agent_speech_end'));
    vi.advanceTimersByTime(QUIET_MS);
    expect((await commands()).map((c) => c.type)).toEqual(['predict']);
  });

  it('only asks at judgment-call steps, once per session', async () => {
    const { screen, commands } = await setup();
    await screen('field_changed', 'asset_number'); // S5: not a judgment call
    expect(await commands()).toEqual([]);
    await screen('record_opened', undefined, '4501');
    await screen('typing_in_progress', 'invoice_date'); // S2
    await screen('record_opened', undefined, '4502');
    await screen('typing_in_progress', 'invoice_date'); // S2 again
    expect((await commands()).map((c) => c.type)).toEqual(['predict']);
  });

  it('drops a prediction the learner moved past before a quiet moment came', async () => {
    const { bus, screen, commands, session } = await setup();
    await bus.deliver(STREAMS.speech, speechEvent('user_speech_start'));
    await screen('typing_in_progress', 'invoice_date'); // S2, waiting
    await screen('typing_in_progress', 'company_code'); // S3: moved on
    await bus.deliver(STREAMS.speech, speechEvent('user_speech_end'));
    vi.advanceTimersByTime(QUIET_MS * 2);
    expect(await commands()).toEqual([]);
    expect(session.predictionsAsked.size).toBe(0);
  });

  it('gives up when no quiet moment comes', async () => {
    const { bus, screen, commands, session } = await setup();
    await bus.deliver(STREAMS.speech, speechEvent('user_speech_start'));
    await screen('typing_in_progress', 'cost_center');
    vi.advanceTimersByTime(MAX_WAIT_MS + QUIET_MS * 2);
    expect(await commands()).toEqual([]);
    expect(session.prediction).toBeNull();
  });

  it('records no_answer when the learner says nothing for a minute', async () => {
    const { store, screen, session } = await setup();
    await screen('typing_in_progress', 'cost_center');
    vi.advanceTimersByTime(ANSWER_MS);
    await session.idle();
    expect(store.data.learner_attempts).toEqual([expect.objectContaining({ step_id: S4, prediction_grade: 'no_answer', predicted: null })]);
  });

  it('keeps the prediction ungraded when brain is down', async () => {
    const decider = stubDecider(() => {
      throw new Error('brain unreachable');
    });
    const { bus, store, screen, session } = await setup({ decider });
    await screen('typing_in_progress', 'cost_center');
    await bus.deliver(STREAMS.turns, turnEvent('0400, because it is a machine'));
    await session.idle();
    expect(store.data.learner_attempts).toEqual([
      expect.objectContaining({ predicted: '0400, because it is a machine', prediction_grade: null, actual_action: null }),
    ]);
  });

  it('skips a step the tutor already intervened on for this record', async () => {
    const { screen, commands, session } = await setup({ decider: testDecider() });
    session.intervened.set('g1', { guardrailId: 'g1', stepId: S4, rowId: null, resolved: false, replayed: true });
    await screen('typing_in_progress', 'cost_center');
    expect(await commands()).toEqual([]);
  });
});

describe('dev brain D9', () => {
  const step = { decision: 'Re-coded opex (4711) to capex (0400)', reason: "…and then it goes to 0400, because it's a machine." };
  it.each([
    ["I'd leave it on 4711, like the office stuff.", 'wrong'],
    ['0400', 'correct_no_reason'],
    ['0400, because it is a machine', 'correct_with_reason'],
    ["I don't know", 'no_answer'],
    ['Put it on hold, because Kranbau double-bills', 'wrong'],
  ])('%s → %s', (prediction, answer) => {
    expect(devD9({ step, prediction }).answer).toBe(answer);
  });
});
