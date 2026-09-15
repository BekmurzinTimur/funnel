import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_BATCH_SIZE, type EventBatchResponse } from '@shared/api';
import {
  eventFromSession,
  insertEvent,
  insertSession,
  insertVersion,
  loadConfig,
  nowIso,
  type EventRow,
  type SessionRow,
} from '../src/server/queries';
import { createTestApp, readConfigText, type TestApp } from './helpers';

const FUNNEL_ID = 'workstyle-planner';

let t: TestApp;
beforeEach(async () => {
  t = await createTestApp();
});
afterEach(async () => {
  await t.close();
});

// Session routes belong to Track A; sessions are created directly, including the
// server-side session_started the real route emits.
function createSession(overrides: Partial<SessionRow> = {}): SessionRow {
  const version = overrides.funnel_version ?? 1;
  const config = loadConfig(t.db, FUNNEL_ID, version);
  if (!config) throw new Error(`version ${version} is not stored`);
  const now = nowIso();
  const session: SessionRow = {
    id: randomUUID(),
    funnel_id: FUNNEL_ID,
    funnel_version: version,
    experiment_id: config.experiment.id,
    variant: 'A',
    variant_forced: 0,
    utm_source: 'google',
    utm_medium: 'cpc',
    utm_campaign: 'spring_launch',
    answers_json: '{}',
    current_step_id: 'intro',
    result_id: null,
    is_synthetic: 0,
    created_at: now,
    last_seen_at: now,
    ...overrides,
  };
  insertSession(t.db, session);
  insertEvent(t.db, eventFromSession(session, { event_id: randomUUID(), name: 'session_started' }));
  return session;
}

function storeV3(): void {
  const text = readConfigText('iteration-2/funnel-v3.json');
  insertVersion(t.db, {
    funnel_id: FUNNEL_ID,
    version: 3,
    config_json: text,
    schema_version: (JSON.parse(text) as { schemaVersion: string }).schemaVersion,
    created_at: nowIso(),
  });
}

function event(session: SessionRow, name: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { event_id: randomUUID(), session_id: session.id, name, step_id: 'intro', client_ts: nowIso(), props: {}, ...extra };
}

async function postEvents(events: unknown[]): Promise<{ statusCode: number; body: EventBatchResponse }> {
  const response = await t.app.inject({ method: 'POST', url: '/api/events', payload: { events } });
  return { statusCode: response.statusCode, body: response.json<EventBatchResponse>() };
}

const count = (table: 'events' | 'events_rejected'): number =>
  (t.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

const storedEvent = (eventId: string): EventRow | undefined =>
  t.db.prepare('SELECT * FROM events WHERE event_id = ?').get(eventId) as EventRow | undefined;

describe('POST /api/events — idempotency', () => {
  it('a retry after a simulated timeout is safe: the same batch twice leaves the row count unchanged and reports duplicate', async () => {
    const session = createSession();
    const batch = [
      event(session, 'step_viewed', { props: { step_type: 'info', visible_step_index: 1, visible_step_count: 8 } }),
      event(session, 'step_completed', { props: { next_step_id: 'team_size' } }),
      event(session, 'step_viewed', { step_id: 'team_size', props: { step_type: 'number', visible_step_index: 2, visible_step_count: 8 } }),
    ];
    const before = count('events');

    const first = await postEvents(batch);
    expect(first.statusCode).toBe(200);
    expect(first.body.results).toEqual(batch.map((e) => ({ event_id: e.event_id, status: 'accepted' })));
    const afterFirst = count('events');
    expect(afterFirst).toBe(before + batch.length);

    // The client never saw the first response and re-sends the identical batch.
    const retry = await postEvents(batch);
    expect(retry.statusCode).toBe(200);
    expect(retry.body.results).toEqual(batch.map((e) => ({ event_id: e.event_id, status: 'duplicate' })));
    expect(count('events')).toBe(afterFirst);
    expect(count('events_rejected')).toBe(0);
  });

  it('a duplicate event_id within one batch: first accepted, second duplicate', async () => {
    const session = createSession();
    const viewed = event(session, 'step_viewed', { props: { step_type: 'info', visible_step_index: 1, visible_step_count: 8 } });
    const before = count('events');

    const { statusCode, body } = await postEvents([viewed, { ...viewed }]);
    expect(statusCode).toBe(200);
    expect(body.results.map((r) => r.status)).toEqual(['accepted', 'duplicate']);
    expect(count('events')).toBe(before + 1);
  });
});

describe('POST /api/events — validation', () => {
  it('a malformed item never fails the batch: mixed valid/invalid gives partial success and records rejects', async () => {
    const session = createSession();
    const valid1 = event(session, 'step_viewed', { props: { step_type: 'info', visible_step_index: 1, visible_step_count: 8 } });
    const valid2 = event(session, 'step_completed', { props: { next_step_id: 'team_size' } });
    const badUuid = event(session, 'step_viewed', { event_id: 'not-a-uuid' });
    const missingName = event(session, 'step_viewed');
    delete missingName.name;
    const propsString = event(session, 'answer_submitted', { props: 'answer_kind=number' });
    const unknownSession = event(session, 'step_viewed', { session_id: randomUUID() });
    const before = count('events');

    const { statusCode, body } = await postEvents([valid1, badUuid, missingName, 'garbage', propsString, null, unknownSession, valid2]);

    expect(statusCode).toBe(200);
    expect(body.results).toEqual([
      { event_id: valid1.event_id, status: 'accepted' },
      { event_id: 'not-a-uuid', status: 'rejected', reason: 'invalid_shape' },
      { event_id: missingName.event_id, status: 'rejected', reason: 'invalid_shape' },
      { event_id: null, status: 'rejected', reason: 'invalid_shape' },
      { event_id: propsString.event_id, status: 'rejected', reason: 'invalid_shape' },
      { event_id: null, status: 'rejected', reason: 'invalid_shape' },
      { event_id: unknownSession.event_id, status: 'rejected', reason: 'unknown_session' },
      { event_id: valid2.event_id, status: 'accepted' },
    ]);
    expect(count('events')).toBe(before + 2);
    expect(storedEvent(valid1.event_id as string)).toBeDefined();
    expect(storedEvent(valid2.event_id as string)).toBeDefined();

    const rejected = t.db.prepare('SELECT session_id, raw_json, reason FROM events_rejected ORDER BY id').all() as {
      session_id: string | null;
      raw_json: string;
      reason: string;
    }[];
    expect(rejected.map((r) => r.reason)).toEqual([
      'invalid_shape',
      'invalid_shape',
      'invalid_shape',
      'invalid_shape',
      'invalid_shape',
      'unknown_session',
    ]);
    expect(rejected[0]).toMatchObject({ session_id: session.id, raw_json: JSON.stringify(badUuid) });
    expect(rejected[2]).toMatchObject({ session_id: null, raw_json: '"garbage"' });
    expect(rejected[5]).toMatchObject({ session_id: unknownSession.session_id });
  });

  it('recommendation_expanded is checked against the pinned version: rejected on v1, accepted on v3', async () => {
    storeV3();
    const v1Session = createSession({ funnel_version: 1, result_id: 'async_native' });
    const v3Session = createSession({ funnel_version: 3, result_id: 'regulated_scale' });
    const props = { action: 'expand_recommendation', source: 'cta' };
    const fromV1 = event(v1Session, 'recommendation_expanded', { step_id: 'result', props });
    const fromV3 = event(v3Session, 'recommendation_expanded', { step_id: 'result', props });

    const { statusCode, body } = await postEvents([fromV1, fromV3]);

    expect(statusCode).toBe(200);
    expect(body.results).toEqual([
      { event_id: fromV1.event_id, status: 'rejected', reason: 'event_not_allowed' },
      { event_id: fromV3.event_id, status: 'accepted' },
    ]);
    expect(storedEvent(fromV1.event_id as string)).toBeUndefined();
    const stored = storedEvent(fromV3.event_id as string);
    expect(stored).toMatchObject({ funnel_version: 3, experiment_id: 'question-order-and-result-framing-v3' });
    expect(JSON.parse(stored!.props_json)).toEqual({ result_id: 'regulated_scale', ...props });
  });

  it('a client-sent session_started is rejected as server_only_event', async () => {
    const session = createSession();
    const before = count('events');
    const forged = event(session, 'session_started');

    const { statusCode, body } = await postEvents([forged]);

    expect(statusCode).toBe(200);
    expect(body.results).toEqual([{ event_id: forged.event_id, status: 'rejected', reason: 'server_only_event' }]);
    expect(count('events')).toBe(before);
  });

  it('rejects a body that is not a batch with 400 invalid_batch', async () => {
    for (const payload of [{ event: {} }, { events: 'nope' }, { events: Array.from({ length: MAX_BATCH_SIZE + 1 }, () => ({})) }]) {
      const response = await t.app.inject({ method: 'POST', url: '/api/events', payload });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: 'invalid_batch' });
    }
  });

  it('accepts a sendBeacon-style text/plain batch', async () => {
    const session = createSession();
    const viewed = event(session, 'step_viewed', { props: { step_type: 'info', visible_step_index: 1, visible_step_count: 8 } });
    const response = await t.app.inject({
      method: 'POST',
      url: '/api/events',
      headers: { 'content-type': 'text/plain;charset=UTF-8' },
      payload: JSON.stringify({ events: [viewed] }),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<EventBatchResponse>().results).toEqual([{ event_id: viewed.event_id, status: 'accepted' }]);
  });
});

describe('POST /api/events — server-derived fields', () => {
  it('overwrites attribution from the session row and strips non-whitelisted props', async () => {
    const session = createSession({ variant: 'B', is_synthetic: 1 });
    const clientTs = '2026-01-01T10:00:00.000Z';
    const lying = event(session, 'answer_submitted', {
      step_id: 'team_size',
      client_ts: clientTs,
      props: { answer_kind: 'number', raw_value: 42 },
      variant: 'Z',
      funnel_version: 99,
      funnel_id: 'other-funnel',
      experiment_id: 'forged',
      utm_campaign: 'forged',
      is_synthetic: 0,
      server_ts: '1999-01-01T00:00:00.000Z',
    });

    const { body } = await postEvents([lying]);

    expect(body.results).toEqual([{ event_id: lying.event_id, status: 'accepted' }]);
    const stored = storedEvent(lying.event_id as string);
    expect(stored).toMatchObject({
      session_id: session.id,
      name: 'answer_submitted',
      step_id: 'team_size',
      client_ts: clientTs,
      funnel_id: FUNNEL_ID,
      funnel_version: 1,
      experiment_id: 'question-order-and-result-framing-v1',
      variant: 'B',
      utm_source: 'google',
      utm_medium: 'cpc',
      utm_campaign: 'spring_launch',
      is_synthetic: 1,
      props_json: '{"answer_kind":"number"}',
    });
    expect(stored!.server_ts).not.toBe('1999-01-01T00:00:00.000Z');
    expect(Date.parse(stored!.server_ts)).not.toBeNaN();
  });

  it('stamps result_id from the session row, never from the client', async () => {
    const finished = createSession({ current_step_id: 'result', result_id: 'hybrid_structured' });
    const unfinished = createSession();
    const cta = event(finished, 'cta_clicked', { step_id: 'result', props: { result_id: 'fake', action: 'expand_recommendation' } });
    const noResult = event(unfinished, 'result_viewed', { step_id: 'result', props: { result_id: 'fake' } });

    const { body } = await postEvents([cta, noResult]);

    expect(body.results.map((r) => r.status)).toEqual(['accepted', 'accepted']);
    expect(JSON.parse(storedEvent(cta.event_id as string)!.props_json)).toEqual({
      result_id: 'hybrid_structured',
      action: 'expand_recommendation',
    });
    // A session without a computed result gets no result_id at all.
    expect(JSON.parse(storedEvent(noResult.event_id as string)!.props_json)).toEqual({});
  });

  it('drops allowed props whose values are not short scalars', async () => {
    const session = createSession();
    const viewed = event(session, 'step_viewed', {
      props: { step_type: { nested: 'answer' }, visible_step_index: 2, visible_step_count: null },
    });
    const answered = event(session, 'answer_submitted', { step_id: 'team_size', props: { answer_kind: 'x'.repeat(201) } });
    const clicked = event(session, 'back_clicked', { step_id: 'team_size', props: { destination_step_id: ['intro'] } });
    const kept = event(session, 'answer_submitted', { step_id: 'work_mode', props: { answer_kind: 'x'.repeat(200) } });

    const { body } = await postEvents([viewed, answered, clicked, kept]);

    expect(body.results.map((r) => r.status)).toEqual(['accepted', 'accepted', 'accepted', 'accepted']);
    expect(storedEvent(viewed.event_id as string)!.props_json).toBe('{"visible_step_index":2,"visible_step_count":null}');
    expect(storedEvent(answered.event_id as string)!.props_json).toBe('{}');
    expect(storedEvent(clicked.event_id as string)!.props_json).toBe('{}');
    expect(JSON.parse(storedEvent(kept.event_id as string)!.props_json)).toEqual({ answer_kind: 'x'.repeat(200) });
  });
});

describe('POST /api/events — edge cases', () => {
  it('rejects a completely unknown event name as event_not_allowed', async () => {
    const session = createSession();
    const made_up = event(session, 'totally_made_up_event');

    const { body } = await postEvents([made_up]);

    expect(body.results).toEqual([{ event_id: made_up.event_id, status: 'rejected', reason: 'event_not_allowed' }]);
  });

  it('treats a pinned config without an events section as allowing nothing', async () => {
    const config = JSON.parse(readConfigText('funnel-v1.json')) as Record<string, unknown>;
    delete config.events;
    insertVersion(t.db, { funnel_id: FUNNEL_ID, version: 2, config_json: JSON.stringify({ ...config, version: 2 }), schema_version: '1', created_at: nowIso() });
    const session = createSession({ funnel_version: 2 });
    const viewed = event(session, 'step_viewed');

    const { statusCode, body } = await postEvents([viewed]);

    expect(statusCode).toBe(200);
    expect(body.results).toEqual([{ event_id: viewed.event_id, status: 'rejected', reason: 'event_not_allowed' }]);
  });

  it('dedupes event_ids case-insensitively: an uppercase re-send is a duplicate', async () => {
    const session = createSession();
    const viewed = event(session, 'step_viewed', { props: { step_type: 'info', visible_step_index: 1, visible_step_count: 8 } });
    await postEvents([viewed]);
    const before = count('events');

    const { body } = await postEvents([{ ...viewed, event_id: (viewed.event_id as string).toUpperCase() }]);

    expect(body.results.map((r) => r.status)).toEqual(['duplicate']);
    expect(count('events')).toBe(before);
  });

  it('stores events_rejected.session_id only when it is a string of at most 100 characters', async () => {
    const tooLong = { event_id: randomUUID(), session_id: 's'.repeat(101), name: 'step_viewed' };
    const notString = { event_id: randomUUID(), session_id: 42, name: 'step_viewed' };

    const { body } = await postEvents([tooLong, notString]);

    expect(body.results.map((r) => r.reason)).toEqual(['invalid_shape', 'invalid_shape']);
    const rows = t.db.prepare('SELECT session_id FROM events_rejected ORDER BY id').all() as { session_id: string | null }[];
    expect(rows).toEqual([{ session_id: null }, { session_id: null }]);
  });

  it('a database fault fails the whole batch with 500 and rolls back; the retry then succeeds', async () => {
    const session = createSession({ current_step_id: 'result', result_id: 'balanced' });
    const batch = [
      event(session, 'step_viewed', { props: { step_type: 'info', visible_step_index: 1, visible_step_count: 8 } }),
      event(session, 'step_viewed', { event_id: 'not-a-uuid' }),
      event(session, 'cta_clicked', { step_id: 'result', props: { action: 'expand_recommendation' } }),
      event(session, 'step_completed', { props: { next_step_id: 'team_size' } }),
    ];
    const eventsBefore = count('events');
    const rejectedBefore = count('events_rejected');

    t.db.exec(`CREATE TRIGGER boom BEFORE INSERT ON events WHEN NEW.name = 'cta_clicked' BEGIN SELECT RAISE(ABORT, 'boom'); END`);
    const failed = await t.app.inject({ method: 'POST', url: '/api/events', payload: { events: batch } });
    expect(failed.statusCode).toBe(500);
    expect(count('events')).toBe(eventsBefore);
    expect(count('events_rejected')).toBe(rejectedBefore);

    t.db.exec('DROP TRIGGER boom');
    const retry = await postEvents(batch);
    expect(retry.statusCode).toBe(200);
    expect(retry.body.results.map((r) => r.status)).toEqual(['accepted', 'rejected', 'accepted', 'accepted']);
    expect(count('events')).toBe(eventsBefore + 3);
    expect(count('events_rejected')).toBe(rejectedBefore + 1);
  });
});
