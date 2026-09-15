// SPEC §6 — renderer trigger points. Navigation events are emitted only after the
// server's navigation response and describe the path the server recorded.
// session_started is server-side only and is never emitted here.
import type { NavigationResponse } from '@shared/api';
import { ANSWER_STEP_TYPES, type MaterialisedConfig, type Step } from '@shared/types';
import { track, type TrackContext } from '../lib/eventQueue';

const answerBearing = new Set<string>(ANSWER_STEP_TYPES);

export function eventContext(session: { sessionId: string; config: MaterialisedConfig }): TrackContext {
  return { sessionId: session.sessionId, allowed: (session.config.events?.allowed ?? []).map((e) => e.name) };
}

/** A step is now on screen: step_viewed, plus result_viewed on the result step (server stamps result_id). */
export function emitStepViewed(ctx: TrackContext, config: MaterialisedConfig, nav: NavigationResponse): void {
  const stepId = nav.currentStepId;
  if (!stepId) return;
  const step = config.steps[stepId];
  track(ctx, 'step_viewed', stepId, {
    step_type: step?.type ?? 'unknown',
    visible_step_index: nav.visibleSteps.indexOf(stepId) + 1,
    visible_step_count: nav.visibleSteps.length,
  });
  // Only when a result is actually shown; an error screen must not count as a completion.
  if (step?.type === 'result' && nav.resultId && config.results[nav.resultId]) track(ctx, 'result_viewed', stepId, {});
}

/** After /answer moved the session off `fromId`. Never carries the answer value. */
export function emitForward(ctx: TrackContext, step: Step | undefined, fromId: string, nav: NavigationResponse): void {
  if (step && answerBearing.has(step.type)) track(ctx, 'answer_submitted', fromId, { answer_kind: step.type });
  // Every forward edge from a non-result step, including info and unknown steps (§6, §7 entry edge).
  if (step?.type !== 'result') track(ctx, 'step_completed', fromId, { next_step_id: nav.currentStepId });
}

/** After /back moved the session off `fromId`. */
export function emitBack(ctx: TrackContext, fromId: string, nav: NavigationResponse): void {
  track(ctx, 'back_clicked', fromId, { destination_step_id: nav.currentStepId });
}

/** Result CTA. recommendation_expanded is inert for configs that do not allow it (v1). */
export function emitCta(ctx: TrackContext, stepId: string | null, action: string, expanding: boolean): void {
  track(ctx, 'cta_clicked', stepId, { action });
  if (action === 'expand_recommendation' && expanding) {
    track(ctx, 'recommendation_expanded', stepId, { action, source: 'cta' });
  }
}
