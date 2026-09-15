import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { NavigationResponse, SessionResponse } from '@shared/api';
import { assignVariant } from '@shared/variant';
import { adminHeaders, createTestApp, readConfig, readConfigText, sessionCookie, type TestApp } from './helpers';

const v1 = readConfig('funnel-v1.json');
const v3 = readConfig('iteration-2/funnel-v3.json');

/** 4000 fixed, UUID-shaped session IDs — deterministic, so the test cannot be flaky. */
const FIXED_IDS = Array.from({ length: 4000 }, (_, i) => {
  const h = createHash('sha256').update(`fixed-session-${i}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
});

describe('variant assignment distribution', () => {
  for (const config of [v1, v3]) {
    it(`matches the 50/50 weights within ±3pp for ${config.experiment.id}`, () => {
      const counts: Record<string, number> = {};
      for (const id of FIXED_IDS) {
        const variant = assignVariant(id, config.experiment.id, config.experiment.variants);
        counts[variant] = (counts[variant] ?? 0) + 1;
      }
      expect(Object.keys(counts).sort()).toEqual(['A', 'B']);
      for (const [key, def] of Object.entries(config.experiment.variants)) {
        const share = (counts[key] / FIXED_IDS.length) * 100;
        expect(Math.abs(share - def.weight)).toBeLessThanOrEqual(3);
      }
    });
  }

  it('is deterministic for the same session and experiment', () => {
    for (const id of FIXED_IDS.slice(0, 50)) {
      expect(assignVariant(id, v1.experiment.id, v1.experiment.variants)).toBe(
        assignVariant(id, v1.experiment.id, v1.experiment.variants),
      );
    }
  });
});

describe('variant stickiness over HTTP', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await createTestApp();
  });
  afterEach(async () => {
    await t.close();
  });

  const postSession = async (url = '/api/session', cookie?: string) => {
    const res = await t.app.inject({ method: 'POST', url, headers: cookie ? { cookie } : {} });
    expect(res.statusCode, res.body).toBe(200);
    return { res, body: res.json<SessionResponse>() };
  };

  it('repeated fetches return the same session and variant, including across a publish + activate', async () => {
    const { res, body: first } = await postSession();
    const cookie = sessionCookie(res)!;

    for (let i = 0; i < 3; i++) {
      const { body } = await postSession('/api/session', cookie);
      expect(body.sessionId).toBe(first.sessionId);
      expect(body.variant).toBe(first.variant);
      expect(body.variantForced).toBe(false);
    }

    const publish = await t.app.inject({
      method: 'POST',
      url: '/api/admin/versions',
      headers: { ...adminHeaders, 'content-type': 'application/json' },
      payload: readConfigText('iteration-2/funnel-v3.json'),
    });
    expect(publish.statusCode).toBe(201);
    const activate = await t.app.inject({ method: 'POST', url: '/api/admin/versions/3/activate', headers: adminHeaders });
    expect(activate.statusCode).toBe(200);

    const { body: after } = await postSession('/api/session', cookie);
    expect(after.sessionId).toBe(first.sessionId);
    expect(after.variant).toBe(first.variant);
    expect(after.funnelVersion).toBe(1);

    const variants = t.db.prepare('SELECT DISTINCT variant FROM sessions WHERE id = ?').all(first.sessionId);
    expect(variants).toEqual([{ variant: first.variant }]);
  });

  it('?variant=B on an existing A session creates a new session instead of mutating it', async () => {
    const { res, body: a } = await postSession('/api/session?variant=A');
    expect(a.variant).toBe('A');
    expect(a.variantForced).toBe(true);
    const cookieA = sessionCookie(res)!;

    // Same variant as the session: resumes.
    const { body: sameA } = await postSession('/api/session?variant=A', cookieA);
    expect(sameA.sessionId).toBe(a.sessionId);

    // Invalid variant key: ignored, resumes.
    const { body: ignored } = await postSession('/api/session?variant=Z', cookieA);
    expect(ignored.sessionId).toBe(a.sessionId);

    const { res: resB, body: b } = await postSession('/api/session?variant=B', cookieA);
    expect(b.sessionId).not.toBe(a.sessionId);
    expect(b.variant).toBe('B');
    expect(b.variantForced).toBe(true);
    expect(b.config.stepSequence).toEqual(v1.experiment.variants.B.stepSequence);
    expect(sessionCookie(resB)).toBe(`fsid=${b.sessionId}`);

    const oldRow = t.db.prepare('SELECT variant, variant_forced FROM sessions WHERE id = ?').get(a.sessionId);
    expect(oldRow).toEqual({ variant: 'A', variant_forced: 1 });
    expect(t.db.prepare('SELECT COUNT(*) AS n FROM sessions').get()).toEqual({ n: 2 });
  });

  it('?reset=1 starts a new session', async () => {
    const { res, body: first } = await postSession();
    const { res: resetRes, body: reset } = await postSession('/api/session?reset=1', sessionCookie(res));
    expect(reset.sessionId).not.toBe(first.sessionId);
    expect(sessionCookie(resetRes)).toBe(`fsid=${reset.sessionId}`);
    expect(reset.currentStepId).toBe(reset.config.stepSequence[0]);
  });

  it('captures UTM first-touch only and marks synthetic sessions', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/session?utm_source=news&utm_medium=email&utm_campaign=launch',
      headers: { 'x-synthetic': '1' },
    });
    const cookie = sessionCookie(res)!;
    const id = res.json<SessionResponse>().sessionId;
    await postSession('/api/session?utm_source=other&utm_campaign=later', cookie);

    expect(t.db.prepare('SELECT utm_source, utm_medium, utm_campaign, is_synthetic FROM sessions WHERE id = ?').get(id)).toEqual({
      utm_source: 'news',
      utm_medium: 'email',
      utm_campaign: 'launch',
      is_synthetic: 1,
    });
    expect(
      t.db.prepare("SELECT utm_campaign, is_synthetic FROM events WHERE session_id = ? AND name = 'session_started'").get(id),
    ).toEqual({ utm_campaign: 'launch', is_synthetic: 1 });
  });

  it('a stale stepId changes nothing and returns the current state', async () => {
    const { res, body: created } = await postSession('/api/session?variant=A');
    const cookie = sessionCookie(res)!;
    const nav = (url: string, payload: Record<string, unknown>) =>
      t.app.inject({ method: 'POST', url, headers: { cookie }, payload });

    const afterIntro = (await nav('/api/session/answer', { stepId: 'intro' })).json<NavigationResponse>();
    expect(afterIntro.currentStepId).toBe('team_size');

    // Double-click on intro: no change.
    const stale = await nav('/api/session/answer', { stepId: 'intro' });
    expect(stale.statusCode).toBe(200);
    expect(stale.json()).toEqual(afterIntro);

    const staleBack = await nav('/api/session/back', { stepId: 'work_mode' });
    expect(staleBack.json()).toEqual(afterIntro);

    const row = t.db.prepare('SELECT current_step_id, answers_json FROM sessions WHERE id = ?').get(created.sessionId);
    expect(row).toEqual({ current_step_id: 'team_size', answers_json: '{}' });

    // Invalid answer and bad body are rejected without changing state.
    const invalid = await nav('/api/session/answer', { stepId: 'team_size', value: 0 });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ error: 'invalid_answer' });
    expect((await nav('/api/session/answer', { value: 3 })).statusCode).toBe(400);

    // Back is persisted.
    const back = (await nav('/api/session/back', { stepId: 'team_size' })).json<NavigationResponse>();
    expect(back.currentStepId).toBe('intro');
    const { body: resumed } = await postSession('/api/session', cookie);
    expect(resumed.currentStepId).toBe('intro');
  });

  it('navigation without a live session returns 404 session_not_found', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/api/session/answer', payload: { stepId: 'intro' } });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'session_not_found' });

    const { res: created, body } = await postSession();
    t.db.prepare('UPDATE sessions SET created_at = ? WHERE id = ?').run('2000-01-01T00:00:00.000Z', body.sessionId);
    const expired = await t.app.inject({
      method: 'POST',
      url: '/api/session/back',
      headers: { cookie: sessionCookie(created)! },
      payload: { stepId: 'intro' },
    });
    expect(expired.statusCode).toBe(404);

    // An expired session is not resumed.
    const { body: renewed } = await postSession('/api/session', sessionCookie(created));
    expect(renewed.sessionId).not.toBe(body.sessionId);
  });
});
