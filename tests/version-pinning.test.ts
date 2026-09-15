import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { NavigationResponse, SessionResponse } from '@shared/api';
import type { AnswerValue, Step } from '@shared/types';
import { materialise } from '@shared/variant';
import { adminHeaders, createTestApp, readConfig, readConfigText, sessionCookie, type TestApp } from './helpers';

const v1 = readConfig('funnel-v1.json');

/** A valid answer for any step type (undefined for steps that collect none). */
function validValue(step: Step): AnswerValue | undefined {
  const options = step.input?.options ?? [];
  switch (step.type) {
    case 'number':
      return typeof step.input?.min === 'number' ? step.input.min : 1;
    case 'single-select':
      return options[0].value;
    case 'multi-select':
      return [options[0].value];
    default:
      return undefined;
  }
}

describe('version pinning', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await createTestApp();
  });
  afterEach(async () => {
    await t.close();
  });

  const startSession = async (cookie?: string) => {
    const res = await t.app.inject({ method: 'POST', url: '/api/session', headers: cookie ? { cookie } : {} });
    expect(res.statusCode).toBe(200);
    return { res, body: res.json<SessionResponse>() };
  };

  const answer = async (cookie: string, stepId: string, value: AnswerValue | undefined) => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/session/answer',
      headers: { cookie },
      payload: value === undefined ? { stepId } : { stepId, value },
    });
    expect(res.statusCode, res.body).toBe(200);
    return res.json<NavigationResponse>();
  };

  const publishAndActivateV3 = async () => {
    const publish = await t.app.inject({
      method: 'POST',
      url: '/api/admin/versions',
      headers: { ...adminHeaders, 'content-type': 'application/json' },
      payload: readConfigText('iteration-2/funnel-v3.json'),
    });
    expect(publish.statusCode, publish.body).toBe(201);
    const activate = await t.app.inject({ method: 'POST', url: '/api/admin/versions/3/activate', headers: adminHeaders });
    expect(activate.statusCode, activate.body).toBe(200);
    expect(activate.json()).toEqual({ funnelId: 'workstyle-planner', activeVersion: 3 });
  };

  it('keeps serving v1 to a session created before v3 is activated; new sessions get v3', async () => {
    const { res, body: created } = await startSession();
    const cookie = sessionCookie(res)!;
    expect(cookie).toBeDefined();
    expect(created.funnelVersion).toBe(1);

    await publishAndActivateV3();

    const { body: resumed } = await startSession(cookie);
    expect(resumed.sessionId).toBe(created.sessionId);
    expect(resumed.funnelVersion).toBe(1);
    expect(resumed.config.version).toBe(1);
    expect(resumed.config.stepSequence).toEqual(materialise(v1, resumed.variant).stepSequence);

    const started = t.db
      .prepare("SELECT funnel_version, experiment_id FROM events WHERE session_id = ? AND name = 'session_started'")
      .all(created.sessionId);
    expect(started).toEqual([{ funnel_version: 1, experiment_id: v1.experiment.id }]);

    const { body: fresh } = await startSession();
    expect(fresh.sessionId).not.toBe(created.sessionId);
    expect(fresh.funnelVersion).toBe(3);
    expect(fresh.config.version).toBe(3);
    const freshStarted = t.db
      .prepare("SELECT funnel_version FROM events WHERE session_id = ? AND name = 'session_started'")
      .get(fresh.sessionId);
    expect(freshStarted).toEqual({ funnel_version: 3 });
  });

  it('★ a v1 session left mid-funnel continues to the result step after v3 is active', async () => {
    const { res, body: created } = await startSession();
    const cookie = sessionCookie(res)!;
    const config = created.config;
    const resultStepId = config.stepSequence[config.stepSequence.length - 1];

    // Leave the session mid-funnel: answer the first two steps.
    let state: NavigationResponse = created;
    for (let i = 0; i < 2; i++) {
      const step = config.steps[state.currentStepId!];
      state = await answer(cookie, step.id, validValue(step));
    }
    expect(state.currentStepId).not.toBe(resultStepId);

    await publishAndActivateV3();

    const { body: resumed } = await startSession(cookie);
    expect(resumed.funnelVersion).toBe(1);
    expect(resumed.currentStepId).toBe(state.currentStepId);

    state = resumed;
    for (let guard = 0; state.currentStepId !== resultStepId; guard++) {
      expect(guard).toBeLessThan(config.stepSequence.length);
      const step = resumed.config.steps[state.currentStepId!];
      state = await answer(cookie, step.id, validValue(step));
    }

    expect(state.currentStepId).toBe(resultStepId);
    expect(Object.keys(v1.results)).toContain(state.resultId);
    expect(state.progress.current).toBe(state.progress.total);

    const row = t.db.prepare('SELECT funnel_version, result_id FROM sessions WHERE id = ?').get(created.sessionId);
    expect(row).toEqual({ funnel_version: 1, result_id: state.resultId });
  });
});
