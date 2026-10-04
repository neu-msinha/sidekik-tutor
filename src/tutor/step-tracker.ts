import type { ScreenEvent, Step } from '../contracts/index.js';

/** Events whose `field` is where the learner is working. */
const FIELD_EVENTS = new Set<ScreenEvent['type']>(['field_changed', 'typing_in_progress', 'button_clicked']);

/** The field a screen event puts the learner on, if any. */
export function fieldOf(ev: ScreenEvent): string | undefined {
  return ev.state.focused_field ?? (FIELD_EVENTS.has(ev.type) ? ev.field : undefined);
}

export type Screen = { app: string | undefined; recordKind: string | undefined };

const same = (a: string | undefined, b: string) => a === undefined || a.toLowerCase() === b.toLowerCase();

/** The step's screen signature matches the app and record kind on screen (and the field, when given). */
export function onScreen(step: Step, screen: Screen, field?: string): boolean {
  const sig = step.screen_signature;
  return same(screen.app, sig.app) && same(screen.recordKind, sig.record_kind) && (field === undefined || sig.field === field);
}

export type Tracked = {
  /** The current step after the event. */
  current: Step | undefined;
  /** The current step changed. */
  moved: boolean;
  /** Steps whose field the event touched, current or not (they count as attempted). */
  touched: Step[];
};

/**
 * DESIGN §3 step tracker, over steps in ordinal order: a newly opened record resets to the first
 * step on screen; focusing the field of a later step moves forward to it; focusing an earlier
 * step's field doesn't move back.
 */
export function trackStep(steps: Step[], current: Step | undefined, screen: Screen, ev: ScreenEvent, opened: boolean): Tracked {
  let next = opened ? steps.find((s) => onScreen(s, screen)) : current;
  const field = fieldOf(ev);
  const touched = field ? steps.filter((s) => onScreen(s, screen, field)) : [];
  const ahead = touched.find((s) => s.ordinal > (next?.ordinal ?? Number.NEGATIVE_INFINITY));
  if (ahead) next = ahead;
  if (opened && next) touched.unshift(next);
  return { current: next, moved: next?.id !== current?.id || opened, touched: [...new Set(touched)] };
}
