import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SessionResponse, VersionListResponse } from '@shared/api';
import { adminHeaders, createTestApp, readConfig, readConfigText, type TestApp } from './helpers';

const V3_TEXT = readConfigText('iteration-2/funnel-v3.json');
const jsonHeaders = { ...adminHeaders, 'content-type': 'application/json' };

describe('publish and rollback', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await createTestApp();
  });
  afterEach(async () => {
    await t.close();
  });

  const publish = (payload: string, headers: Record<string, string> = jsonHeaders) =>
    t.app.inject({ method: 'POST', url: '/api/admin/versions', headers, payload });
  const activate = (version: number) =>
    t.app.inject({ method: 'POST', url: `/api/admin/versions/${version}/activate`, headers: adminHeaders });
  const list = async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/admin/versions', headers: adminHeaders });
    expect(res.statusCode).toBe(200);
    return res.json<VersionListResponse>().versions;
  };
  const activeCount = () =>
    (t.db.prepare('SELECT COUNT(*) AS n FROM funnel_versions WHERE is_active = 1').get() as { n: number }).n;
  const versionCount = () => (t.db.prepare('SELECT COUNT(*) AS n FROM funnel_versions').get() as { n: number }).n;
  const newSession = async () => {
    const res = await t.app.inject({ method: 'POST', url: '/api/session' });
    expect(res.statusCode).toBe(200);
    return res.json<SessionResponse>();
  };

  it('publishing funnel-v3.json onto a v1-only DB stores version 3, verbatim and inactive', async () => {
    expect((await list()).map((v) => v.version)).toEqual([1]);

    const res = await publish(V3_TEXT);
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toEqual({ funnelId: 'workstyle-planner', version: 3, isActive: false });

    const versions = await list();
    expect(versions.map((v) => v.version)).toEqual([1, 3]);
    expect(versions.map((v) => v.isActive)).toEqual([true, false]);
    expect(versions[1]).toMatchObject({ title: readConfig('iteration-2/funnel-v3.json').title, liveSessions: 0, totalSessions: 0 });

    const stored = t.db.prepare('SELECT config_json FROM funnel_versions WHERE version = 3').get() as { config_json: string };
    expect(stored.config_json).toBe(V3_TEXT);

    const raw = await t.app.inject({ method: 'GET', url: '/api/admin/versions/3', headers: adminHeaders });
    expect(raw.statusCode).toBe(200);
    expect(raw.headers['content-type']).toMatch(/^application\/json/);
    expect(raw.body).toBe(V3_TEXT);
  });

  it('rejects an invalid config with 400 and every problem listed, storing nothing', async () => {
    const bad = JSON.parse(V3_TEXT);
    bad.version = 4;
    bad.steps.office_days.visibleWhen = { answer: 'work_mode', operator: 'approximately', value: 'hybrid' };
    bad.defaultResultId = 'nope';
    const before = versionCount();

    const res = await publish(JSON.stringify(bad));
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error).toBe('invalid_config');
    expect(body.details.some((d: string) => d.includes('unsupported operator "approximately"'))).toBe(true);
    expect(body.details.some((d: string) => d.includes('defaultResultId'))).toBe(true);
    expect(versionCount()).toBe(before);

    const malformed = await publish('{ not json');
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json()).toMatchObject({ error: 'invalid_json' });
    expect(versionCount()).toBe(before);
  });

  it('rejects a version that is not strictly greater than the latest with 409', async () => {
    expect((await publish(V3_TEXT)).statusCode).toBe(201);

    const again = await publish(V3_TEXT);
    expect(again.statusCode).toBe(409);
    expect(again.json()).toEqual({
      error: 'version_conflict',
      message: 'version 3 must be greater than the latest stored version 3',
    });

    const v2 = JSON.parse(V3_TEXT);
    v2.version = 2;
    const lower = await publish(JSON.stringify(v2));
    expect(lower.statusCode).toBe(409);
    expect(versionCount()).toBe(2);
  });

  it('requires the admin token on every admin route', async () => {
    const wrong = { authorization: 'Bearer nope' };
    const cases = [
      { method: 'GET' as const, url: '/api/admin/versions', headers: {} },
      { method: 'GET' as const, url: '/api/admin/versions', headers: wrong },
      { method: 'GET' as const, url: '/api/admin/versions/1', headers: wrong },
      { method: 'POST' as const, url: '/api/admin/versions/1/activate', headers: wrong },
      { method: 'POST' as const, url: '/api/admin/versions', headers: { ...wrong, 'content-type': 'application/json' }, payload: V3_TEXT },
    ];
    for (const c of cases) {
      const res = await t.app.inject(c);
      expect(res.statusCode, `${c.method} ${c.url}`).toBe(401);
      expect(res.json()).toEqual({ error: 'unauthorized' });
    }
    expect(versionCount()).toBe(1);
  });

  it('moves the activation pointer with exactly one active version at a time', async () => {
    expect(activeCount()).toBe(1);
    expect((await publish(V3_TEXT)).statusCode).toBe(201);
    expect(activeCount()).toBe(1);

    for (const version of [3, 1, 3]) {
      const res = await activate(version);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ funnelId: 'workstyle-planner', activeVersion: version });
      expect(activeCount()).toBe(1);
      expect((await list()).find((v) => v.isActive)?.version).toBe(version);
    }

    const missing = await activate(7);
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ error: 'version_not_found' });
    expect(activeCount()).toBe(1);
  });

  it('rollback to v1 leaves v3 events queryable and new sessions get v1', async () => {
    expect((await publish(V3_TEXT)).statusCode).toBe(201);
    expect((await activate(3)).statusCode).toBe(200);

    const onV3 = await newSession();
    expect(onV3.funnelVersion).toBe(3);
    const eventsOf = (id: string) =>
      t.db.prepare('SELECT name, funnel_version FROM events WHERE session_id = ?').all(id);
    expect(eventsOf(onV3.sessionId)).toEqual([{ name: 'session_started', funnel_version: 3 }]);

    const rollback = await t.app.inject({ method: 'POST', url: '/api/admin/versions/1/activate', headers: adminHeaders });
    expect(rollback.json()).toEqual({ funnelId: 'workstyle-planner', activeVersion: 1 });

    expect(eventsOf(onV3.sessionId)).toEqual([{ name: 'session_started', funnel_version: 3 }]);
    expect(t.db.prepare('SELECT COUNT(*) AS n FROM events WHERE funnel_version = 3').get()).toEqual({ n: 1 });

    const onV1 = await newSession();
    expect(onV1.funnelVersion).toBe(1);

    const versions = await list();
    expect(versions.find((v) => v.version === 3)).toMatchObject({ isActive: false, liveSessions: 1, totalSessions: 1 });
    expect(versions.find((v) => v.version === 1)).toMatchObject({ isActive: true, liveSessions: 1, totalSessions: 1 });
  });
});
