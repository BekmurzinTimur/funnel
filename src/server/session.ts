// Session lifecycle (SPEC §4). Route handlers in routes/session.ts are thin
// wrappers around these functions. Config is always resolved through
// sessions.funnel_version; the active version is read only in createSession.
import { randomUUID } from 'node:crypto';
import type { NavigationResponse, SessionResponse } from '@shared/api';
import { firstStep, navigationState, nextStep, prevStep, validate } from '@shared/navigation';
import { resolveResult } from '@shared/results';
import type { Answers, FunnelConfig, MaterialisedConfig } from '@shared/types';
import { ANSWER_STEP_TYPES } from '@shared/types';
import { assignVariant, materialise } from '@shared/variant';
import type { DB } from './db';
import {
  eventFromSession,
  getActiveVersion,
  getSession,
  insertEvent,
  insertSession,
  loadConfig,
  nowIso,
  touchSession,
  updateSessionState,
  type SessionRow,
} from './queries';

export interface LoadedSession {
  row: SessionRow;
  config: FunnelConfig;
  materialised: MaterialisedConfig;
  answers: Answers;
}

export interface CreateOptions {
  variantOverride?: string;
  utm: { utm_source?: string; utm_medium?: string; utm_campaign?: string };
  synthetic: boolean;
}

const HOUR_MS = 3_600_000;

export const isValidVariant = (config: FunnelConfig, variant: string | undefined): variant is string =>
  typeof variant === 'string' && Object.hasOwn(config.experiment.variants, variant);

/** TTL is read from the session's pinned config and measured from created_at. */
export function isExpired(row: SessionRow, config: FunnelConfig, now = Date.now()): boolean {
  const created = Date.parse(row.created_at);
  return !Number.isFinite(created) || now - created > config.session.ttlHours * HOUR_MS;
}

function parseAnswers(json: string): Answers {
  try {
    const parsed: unknown = JSON.parse(json);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Answers) : {};
  } catch {
    return {};
  }
}

function hydrate(row: SessionRow, config: FunnelConfig): LoadedSession {
  return { row, config, materialised: materialise(config, row.variant), answers: parseAnswers(row.answers_json) };
}

/** A live session: exists, its pinned config loads, and it is within the pinned TTL. */
export function loadLiveSession(db: DB, id: string | undefined): LoadedSession | undefined {
  if (!id) return undefined;
  const row = getSession(db, id);
  if (!row) return undefined;
  const config = loadConfig(db, row.funnel_id, row.funnel_version);
  if (!config || !isValidVariant(config, row.variant) || isExpired(row, config)) return undefined;
  return hydrate(row, config);
}

/** Creates a session on the active version and writes session_started in the same transaction. */
export function createSession(db: DB, options: CreateOptions): LoadedSession | undefined {
  const active = getActiveVersion(db); // the only serving-path read of is_active
  if (!active) return undefined;
  const config = loadConfig(db, active.funnel_id, active.version);
  if (!config) return undefined;

  const id = randomUUID();
  const forced = isValidVariant(config, options.variantOverride);
  const variant = forced
    ? (options.variantOverride as string)
    : assignVariant(id, config.experiment.id, config.experiment.variants);
  const materialised = materialise(config, variant);
  const now = nowIso();

  const row: SessionRow = {
    id,
    funnel_id: config.funnelId,
    funnel_version: config.version,
    experiment_id: config.experiment.id,
    variant,
    variant_forced: forced ? 1 : 0,
    utm_source: options.utm.utm_source ?? null,
    utm_medium: options.utm.utm_medium ?? null,
    utm_campaign: options.utm.utm_campaign ?? null,
    answers_json: '{}',
    current_step_id: firstStep(materialised, {}),
    result_id: null,
    is_synthetic: options.synthetic ? 1 : 0,
    created_at: now,
    last_seen_at: now,
  };

  db.transaction(() => {
    insertSession(db, row);
    insertEvent(db, eventFromSession(row, { event_id: randomUUID(), name: 'session_started', step_id: null, props: {} }));
  })();

  return { row, config, materialised, answers: {} };
}

export function resumeSession(db: DB, session: LoadedSession): LoadedSession {
  touchSession(db, session.row.id);
  return session;
}

export function navigationResponse(session: LoadedSession): NavigationResponse {
  const { materialised, answers, row } = session;
  return navigationState(materialised, answers, row.current_step_id, row.result_id);
}

export function sessionResponse(session: LoadedSession): SessionResponse {
  const { row } = session;
  return {
    sessionId: row.id,
    funnelVersion: row.funnel_version,
    variant: row.variant,
    variantForced: row.variant_forced === 1,
    config: session.materialised,
    answers: session.answers,
    ...navigationResponse(session),
  };
}

function persist(db: DB, session: LoadedSession, currentStepId: string | null, resultId: string | null): LoadedSession {
  const answersJson = JSON.stringify(session.answers);
  updateSessionState(db, session.row.id, {
    answers_json: answersJson,
    current_step_id: currentStepId,
    result_id: resultId,
  });
  return {
    ...session,
    row: { ...session.row, answers_json: answersJson, current_step_id: currentStepId, result_id: resultId },
  };
}

const ANSWER_TYPES: readonly string[] = ANSWER_STEP_TYPES;

export type AnswerOutcome = { ok: true; state: NavigationResponse } | { ok: false; message: string };

/**
 * Stale stepId (not the current step) and the result step are no-ops that return
 * the current state. Orphaned answers are never deleted.
 */
export function applyAnswer(db: DB, session: LoadedSession, stepId: string, value: unknown): AnswerOutcome {
  const { materialised, row } = session;
  const step = materialised.steps[stepId];
  if (stepId !== row.current_step_id || !step || step.type === 'result') {
    return { ok: true, state: navigationResponse(session) };
  }

  const check = validate(step, value);
  if (!check.ok) return { ok: false, message: check.message };

  const answers: Answers = { ...session.answers };
  if (ANSWER_TYPES.includes(step.type)) {
    if (value === undefined) delete answers[stepId];
    else answers[stepId] = value as Answers[string];
  }

  const next = nextStep(materialised, answers, stepId) ?? row.current_step_id;
  const resultId =
    next !== null && materialised.steps[next]?.type === 'result' ? resolveResult(materialised, answers) : row.result_id;

  const updated = persist(db, { ...session, answers }, next, resultId);
  return { ok: true, state: navigationResponse(updated) };
}

/** result_id is deliberately kept on back; it is recomputed when the result step is reached again. */
export function applyBack(db: DB, session: LoadedSession, stepId: string): NavigationResponse {
  const { materialised, row, answers } = session;
  if (stepId !== row.current_step_id) return navigationResponse(session);
  const prev = prevStep(materialised, answers, stepId);
  if (prev === null) return navigationResponse(session);
  return navigationResponse(persist(db, session, prev, row.result_id));
}
