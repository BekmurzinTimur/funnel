// SPEC §10 — analytics against a hand-built fixture with hand-computed numbers.
//
// Rows are inserted directly (no ingest/session routes): sessions with
// insertSession, events with eventFromSession + insertEvent.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AnalyticsResponseSchema, type AnalyticsResponse } from '@shared/api';
import {
  eventFromSession,
  insertEvent,
  insertSession,
  insertVersion,
  nowIso,
  type EventRow,
  type SessionRow,
} from '../src/server/queries';
import { normalCdf, twoProportionZTest } from '../src/server/stats';
import { createTestApp, readConfigText, type TestApp } from './helpers';

const FUNNEL = 'workstyle-planner';
const EXP = { 1: 'question-order-and-result-framing-v1', 3: 'question-order-and-result-framing-v3' } as const;

let t: TestApp;
let clock = Date.parse('2026-09-01T10:00:00.000Z');
const tick = () => new Date((clock += 1000)).toISOString();

function session(id: string, version: 1 | 3, variant: string, opts: { campaign?: string; forced?: boolean } = {}): SessionRow {
  const row: SessionRow = {
    id,
    funnel_id: FUNNEL,
    funnel_version: version,
    experiment_id: EXP[version],
    variant,
    variant_forced: opts.forced ? 1 : 0,
    utm_source: null,
    utm_medium: null,
    utm_campaign: opts.campaign ?? null,
    answers_json: '{}',
    current_step_id: null,
    result_id: null,
    is_synthetic: 0,
    created_at: nowIso(),
    last_seen_at: nowIso(),
  };
  insertSession(t.db, row);
  return row;
}

function emit(
  s: SessionRow,
  name: string,
  step_id: string | null = null,
  props: Record<string, unknown> = {},
  overrides: Partial<EventRow> = {},
) {
  const row = { ...eventFromSession(s, { event_id: randomUUID(), name, step_id, client_ts: tick(), props }), ...overrides };
  return { row, status: insertEvent(t.db, row) };
}

const start = (s: SessionRow) => {
  emit(s, 'session_started');
  emit(s, 'step_viewed', 'intro');
};
/** Forward navigation: step_completed(from → to) then step_viewed(to). */
const go = (s: SessionRow, from: string, to: string) => {
  emit(s, 'step_completed', from, { next_step_id: to });
  emit(s, 'step_viewed', to);
};
const walk = (s: SessionRow, path: string[]) => {
  for (let i = 1; i < path.length; i++) go(s, path[i - 1], path[i]);
};
const back = (s: SessionRow, from: string, to: string) => {
  emit(s, 'back_clicked', from, { destination_step_id: to });
  emit(s, 'step_viewed', to);
};

// v1 A: intro team_size work_mode priorities timezone_span office_days* async_maturity tool_count result
// v1 B: intro work_mode timezone_span team_size async_maturity priorities office_days* tool_count result
const V1A_REMOTE = ['intro', 'team_size', 'work_mode', 'priorities', 'timezone_span', 'async_maturity', 'tool_count', 'result'];
const V1A_HYBRID = ['intro', 'team_size', 'work_mode', 'priorities', 'timezone_span', 'office_days', 'async_maturity', 'tool_count', 'result'];

let duplicateStatus: string;

/*
 * Fixture (v1 is the boot-seeded active version; v3 inserted, not active).
 *
 *  S1 v1 A spring   remote path, completes, CTA. Duplicates: step_viewed team_size sent twice
 *                   with different event_ids; step_viewed work_mode re-inserted with the same
 *                   event_id (→ 'duplicate').
 *  S2 v1 A spring   hybrid path via office_days, completes, no CTA. Late arrival: its
 *                   step_completed(tool_count → result) is inserted after result_viewed, with an
 *                   earlier client_ts.
 *  S3 v1 A autumn   back-click: views office_days, backs to work_mode, switches to remote,
 *                   goes timezone_span → async_maturity and abandons there.
 *  S4 v1 A autumn   FORCED (?variant=A). Abandons at priorities. Its session_started event row
 *                   is tampered to say utm_campaign=spring, variant=B — filters must read the
 *                   sessions row, so this must change nothing.
 *  S7 v1 A spring   hybrid whose step_completed(timezone_span → office_days) was lost; views
 *                   office_days and abandons.
 *  S5 v1 B spring   remote path, completes, CTA.
 *  S6 v1 B (none)   session_started + intro only, abandons.
 *  S8 v3 B spring   remote path (no tool_count in v3 B), completes, CTA + recommendation_expanded.
 *  S9 v3 A (none)   remote path to tool_count, abandons.
 */
beforeAll(async () => {
  t = await createTestApp();
  const v3Text = readConfigText('iteration-2/funnel-v3.json');
  insertVersion(t.db, { funnel_id: FUNNEL, version: 3, config_json: v3Text, schema_version: JSON.parse(v3Text).schemaVersion, created_at: nowIso() });

  // S1
  const s1 = session('s1-remote', 1, 'A', { campaign: 'spring' });
  start(s1);
  go(s1, 'intro', 'team_size');
  emit(s1, 'step_viewed', 'team_size'); // same logical view, new event_id
  emit(s1, 'step_completed', 'team_size', { next_step_id: 'work_mode' });
  const workModeView = emit(s1, 'step_viewed', 'work_mode');
  duplicateStatus = insertEvent(t.db, workModeView.row); // identical event_id retried
  walk(s1, V1A_REMOTE.slice(2));
  emit(s1, 'result_viewed', null, { result_id: 'balanced' });
  emit(s1, 'cta_clicked', null, { result_id: 'balanced', action: 'expand_recommendation' });

  // S2
  const s2 = session('s2-hybrid', 1, 'A', { campaign: 'spring' });
  start(s2);
  walk(s2, V1A_HYBRID.slice(0, -1)); // … → tool_count
  const lateTs = tick(); // client-side time of the completion, before the result events
  emit(s2, 'step_viewed', 'result');
  emit(s2, 'result_viewed', null, { result_id: 'hybrid_structured' });
  emit(s2, 'step_completed', 'tool_count', { next_step_id: 'result' }, { client_ts: lateTs });

  // S3
  const s3 = session('s3-back', 1, 'A', { campaign: 'autumn' });
  start(s3);
  walk(s3, V1A_HYBRID.slice(0, 6)); // … → timezone_span → office_days
  back(s3, 'office_days', 'timezone_span');
  back(s3, 'timezone_span', 'priorities');
  back(s3, 'priorities', 'work_mode');
  walk(s3, ['work_mode', 'priorities', 'timezone_span', 'async_maturity']); // now remote; abandons

  // S4
  const s4 = session('s4-forced', 1, 'A', { campaign: 'autumn', forced: true });
  emit(s4, 'session_started', null, {}, { utm_campaign: 'spring', variant: 'B' });
  emit(s4, 'step_viewed', 'intro');
  walk(s4, ['intro', 'team_size', 'work_mode', 'priorities']);

  // S7
  const s7 = session('s7-lost-edge', 1, 'A', { campaign: 'spring' });
  start(s7);
  walk(s7, V1A_HYBRID.slice(0, 5)); // … → timezone_span
  emit(s7, 'step_viewed', 'office_days'); // the edge into office_days never arrived

  // S5
  const s5 = session('s5-b', 1, 'B', { campaign: 'spring' });
  start(s5);
  walk(s5, ['intro', 'work_mode', 'timezone_span', 'team_size', 'async_maturity', 'priorities', 'tool_count', 'result']);
  emit(s5, 'result_viewed', null, { result_id: 'async_native' });
  emit(s5, 'cta_clicked', null, { result_id: 'async_native', action: 'expand_recommendation' });

  // S6
  start(session('s6-bounce', 1, 'B'));

  // S8 — v3 B: intro work_mode meeting_hours timezone_span team_size async_maturity priorities security_constraints* office_days* result
  const s8 = session('s8-v3b', 3, 'B', { campaign: 'spring' });
  start(s8);
  walk(s8, ['intro', 'work_mode', 'meeting_hours', 'timezone_span', 'team_size', 'async_maturity', 'priorities', 'result']);
  emit(s8, 'result_viewed', null, { result_id: 'async_native' });
  emit(s8, 'cta_clicked', null, { result_id: 'async_native', action: 'expand_recommendation' });
  emit(s8, 'recommendation_expanded', null, { result_id: 'async_native', action: 'expand_recommendation', source: 'cta' });

  // S9 — v3 A: intro team_size work_mode priorities security_constraints* timezone_span office_days* meeting_hours async_maturity tool_count result
  const s9 = session('s9-v3a', 3, 'A');
  start(s9);
  walk(s9, ['intro', 'team_size', 'work_mode', 'priorities', 'timezone_span', 'meeting_hours', 'async_maturity', 'tool_count']);
});

afterAll(async () => {
  await t.close();
});

async function get(query = ''): Promise<AnalyticsResponse> {
  const res = await t.app.inject({ method: 'GET', url: `/api/analytics${query}` });
  expect(res.statusCode, res.body).toBe(200);
  return AnalyticsResponseSchema.parse(res.json());
}

const stepRow = (body: AnalyticsResponse, variant: string, stepId: string) => {
  const group = body.steps.find((g) => g.variant === variant);
  const row = group?.rows.find((r) => r.stepId === stepId);
  if (!row) throw new Error(`no row ${variant}/${stepId}`);
  return row;
};

describe('GET /api/analytics — fixture integrity', () => {
  it('re-inserting an identical event_id is a duplicate; the logical duplicate is stored twice', () => {
    expect(duplicateStatus).toBe('duplicate');
    const { n } = t.db
      .prepare("SELECT COUNT(*) AS n FROM events WHERE session_id = 's1-remote' AND name = 'step_viewed' AND step_id = 'team_size'")
      .get() as { n: number };
    expect(n).toBe(2);
  });
});

describe('GET /api/analytics — default (active v1, no filters)', () => {
  let body: AnalyticsResponse;
  beforeAll(async () => {
    body = await get();
  });

  it('meta and effective filters', () => {
    expect(body.meta).toEqual({ funnelId: FUNNEL, activeVersion: 1, versions: [1, 3], campaigns: ['autumn', 'spring'], variants: ['A', 'B'] });
    expect(body.filters).toEqual({ version: 1, variant: null, utm_campaign: null });
  });

  it('summary: distinct sessions, forced included', () => {
    // started S1 S2 S3 S4 S7 S5 S6 = 7; completed S1 S2 S5 = 3; CTA S1 S5 = 2
    expect(body.summary).toEqual({
      started: 7,
      completed: 3,
      ctaClicked: 2,
      completionRate: 3 / 7,
      ctaCtr: 2 / 3,
      conversion: 2 / 7,
    });
  });

  it('steps are in each variant’s stored sequence order', () => {
    expect(body.steps.map((g) => g.variant)).toEqual(['A', 'B']);
    expect(body.steps[0].rows.map((r) => r.stepId)).toEqual(V1A_HYBRID);
    expect(body.steps[1].rows.map((r) => r.stepId)).toEqual([
      'intro', 'work_mode', 'timezone_span', 'team_size', 'async_maturity', 'priorities', 'office_days', 'tool_count', 'result',
    ]);
  });

  it('★ a remote-path session is not in office_days’ Eligible set', () => {
    // Four A sessions completed timezone_span (S1 S2 S3 S7), but only S2 and S3 traversed the edge
    // timezone_span → office_days. S1 (remote) went timezone_span → async_maturity, S7's edge was lost.
    // Index-based math would use Reached(timezone_span) = 4 as the denominator.
    const office = stepRow(body, 'A', 'office_days');
    expect(office).toMatchObject({ isEntry: false, reached: 3, eligible: 2, converted: 2, conversionRate: 1 });
    expect(stepRow(body, 'A', 'timezone_span').reached).toBe(4);
    // S1's remote edge lands on async_maturity instead: S1 (from timezone_span), S2 (from office_days), S3 (from timezone_span).
    expect(stepRow(body, 'A', 'async_maturity')).toMatchObject({ reached: 3, eligible: 3, converted: 3 });

    // Campaign spring isolates S1 (remote) + S2 (hybrid) + S7 (lost edge): only S2 is eligible.
    return get('?utm_campaign=spring').then((spring) => {
      expect(stepRow(spring, 'A', 'office_days')).toMatchObject({ reached: 2, eligible: 1, converted: 1, conversionRate: 1, dropOff: 1, dropOffRate: 0.5 });
    });
  });

  it('entry step uses the session_started set; duplicates and back-clicks count once', () => {
    // A: S1 S2 S3 S4(forced) S7 — the forced session is included in the per-step table.
    expect(stepRow(body, 'A', 'intro')).toEqual({
      stepId: 'intro', type: 'info', isEntry: true, reached: 5, eligible: 5, converted: 5, conversionRate: 1, dropOff: 0, dropOffRate: 0,
    });
    // S1's two team_size views count once.
    expect(stepRow(body, 'A', 'team_size')).toMatchObject({ reached: 5, eligible: 5, converted: 5, dropOff: 0 });
    // S3 viewed work_mode twice and completed it twice.
    expect(stepRow(body, 'A', 'work_mode')).toMatchObject({ reached: 5, eligible: 5, converted: 5, dropOff: 0 });
    // S4 (forced) abandons at priorities.
    expect(stepRow(body, 'A', 'priorities')).toMatchObject({ reached: 5, eligible: 5, converted: 5, dropOff: 1, dropOffRate: 1 / 5 });
    // B: S5 S6; S6 abandons on intro.
    expect(stepRow(body, 'B', 'intro')).toMatchObject({ isEntry: true, reached: 2, eligible: 2, converted: 2, dropOff: 1, dropOffRate: 0.5 });
  });

  it('drop-off is per step: the back-click session counts at office_days and async_maturity', () => {
    // office_days: S3 (went back, never completed it) + S7 (abandoned) = 2 of 3 reached.
    expect(stepRow(body, 'A', 'office_days')).toMatchObject({ dropOff: 2, dropOffRate: 2 / 3 });
    // async_maturity: S3 again.
    expect(stepRow(body, 'A', 'async_maturity')).toMatchObject({ dropOff: 1, dropOffRate: 1 / 3 });
    // timezone_span: S7 (no outgoing edge). S3 has one.
    expect(stepRow(body, 'A', 'timezone_span')).toMatchObject({ eligible: 4, converted: 4, dropOff: 1 });
    // Sum over A steps = 0+0+0+1+1+2+1+0 = 5 > 3 abandoned A sessions (S3 S4 S7).
    const sum = body.steps[0].rows.reduce((acc, r) => acc + (r.dropOff ?? 0), 0);
    expect(sum).toBe(5);
  });

  it('late-arriving step_completed still forms the edge into result; result has no drop-off', () => {
    // Eligible(result) = S1 + S2 (whose edge arrived after result_viewed).
    expect(stepRow(body, 'A', 'result')).toEqual({
      stepId: 'result', type: 'result', isEntry: false, reached: 2, eligible: 2, converted: 2, conversionRate: 1, dropOff: null, dropOffRate: null,
    });
    expect(stepRow(body, 'A', 'tool_count')).toMatchObject({ reached: 2, eligible: 2, converted: 2, dropOff: 0 });
  });

  it('a step nobody reached has zero counts and null rates (not n/a)', () => {
    expect(stepRow(body, 'B', 'office_days')).toMatchObject({ reached: 0, eligible: 0, converted: 0, conversionRate: null, dropOff: 0, dropOffRate: null });
  });

  it('A vs B excludes forced sessions and runs the pooled z-test', () => {
    // A without S4: S1 S2 S3 S7 → started 4, completed 2, CTA 1. B: S5 S6 → 2, 1, 1.
    expect(body.abComparison.experimentId).toBe(EXP[1]);
    expect(body.abComparison.variants).toEqual([
      { variant: 'A', started: 4, completed: 2, ctaClicked: 1, completionRate: 0.5, ctaCtr: 0.5, conversion: 0.25 },
      { variant: 'B', started: 2, completed: 1, ctaClicked: 1, completionRate: 0.5, ctaCtr: 1, conversion: 0.5 },
    ]);
    // p = 2/6; z = (0.25 − 0.5) / sqrt(1/3 · 2/3 · (1/4 + 1/2)) = −0.6124; two-sided p ≈ 0.540
    const { zTest } = body.abComparison;
    expect(zTest.metric).toBe('cta_clicked / session_started');
    expect(zTest.z).toBeCloseTo(-0.6124, 3);
    expect(zTest.pValue).toBeCloseTo(0.5403, 2);
    expect(zTest.significantAt95).toBe(false);
  });

  it('event counts are distinct sessions per name', () => {
    expect(body.eventCounts).toEqual([
      { name: 'session_started', sessions: 7 },
      { name: 'step_viewed', sessions: 7 },
      { name: 'step_completed', sessions: 6 },
      { name: 'result_viewed', sessions: 3 },
      { name: 'cta_clicked', sessions: 2 },
      { name: 'back_clicked', sessions: 1 },
    ]);
  });

  it('version comparison: funnel-level metrics per version', () => {
    expect(body.versionComparison.versions).toEqual([
      { version: 1, experimentId: EXP[1], started: 7, completed: 3, ctaClicked: 2, completionRate: 3 / 7, ctaCtr: 2 / 3, conversion: 2 / 7 },
      { version: 3, experimentId: EXP[3], started: 2, completed: 1, ctaClicked: 1, completionRate: 0.5, ctaCtr: 1, conversion: 0.5 },
    ]);
  });

  it('version comparison: step × version matrix with null (n/a) for absent steps', () => {
    const { stepConversion } = body.versionComparison;
    expect(stepConversion.map((m) => m.variant)).toEqual(['A', 'B']);

    const b = stepConversion[1];
    // Union in first-appearance order, versions ascending.
    expect(b.stepIds).toEqual([
      'intro', 'work_mode', 'timezone_span', 'team_size', 'async_maturity', 'priorities', 'office_days', 'tool_count', 'result', 'meeting_hours', 'security_constraints',
    ]);
    const [b1, b3] = b.rows;
    expect(b1.version).toBe(1);
    expect(b3.version).toBe(3);
    expect(b3.cells.tool_count).toBeNull(); // removed from v3 B → n/a
    expect(b1.cells.tool_count).toEqual({ eligible: 1, converted: 1, rate: 1 }); // S5
    expect(b1.cells.meeting_hours).toBeNull(); // did not exist in v1
    expect(b3.cells.meeting_hours).toEqual({ eligible: 1, converted: 1, rate: 1 }); // S8
    expect(b3.cells.office_days).toEqual({ eligible: 0, converted: 0, rate: null }); // present but unreached ≠ n/a
    expect(b3.cells.intro).toEqual({ eligible: 1, converted: 1, rate: 1 });

    const [a1, a3] = stepConversion[0].rows;
    expect(stepConversion[0].stepIds.slice(-2)).toEqual(['security_constraints', 'meeting_hours']);
    expect(a1.cells.tool_count).toEqual({ eligible: 2, converted: 2, rate: 1 }); // S1 S2
    expect(a3.cells.tool_count).toEqual({ eligible: 1, converted: 1, rate: 1 }); // S9
    expect(a1.cells.office_days).toEqual({ eligible: 2, converted: 2, rate: 1 });
    expect(a1.cells.security_constraints).toBeNull();
  });
});

describe('GET /api/analytics — filters', () => {
  it('utm_campaign is read from the sessions row', async () => {
    // spring sessions on v1: S1 S2 S7 (A), S5 (B). S4's event row claims spring but its session is autumn.
    const body = await get('?utm_campaign=spring');
    expect(body.filters).toEqual({ version: 1, variant: null, utm_campaign: 'spring' });
    expect(body.summary).toMatchObject({ started: 4, completed: 3, ctaClicked: 2 });
    expect(body.abComparison.variants.map((v) => [v.variant, v.started])).toEqual([['A', 3], ['B', 1]]);
    expect(body.eventCounts.find((e) => e.name === 'back_clicked')).toBeUndefined(); // S3 is autumn

    const autumn = await get('?utm_campaign=autumn');
    // S3 + S4 (forced) — both A; forced S4 is in steps but not in the A/B card.
    expect(autumn.summary).toMatchObject({ started: 2, completed: 0, ctaClicked: 0, ctaCtr: null });
    expect(stepRow(autumn, 'A', 'intro')).toMatchObject({ reached: 2, eligible: 2 });
    expect(autumn.abComparison.variants.map((v) => [v.variant, v.started])).toEqual([['A', 1], ['B', 0]]);
    expect(autumn.abComparison.zTest).toEqual({ metric: 'cta_clicked / session_started', z: null, pValue: null, significantAt95: false });
  });

  it('variant filter narrows steps and summary (from the sessions row) but not the A/B card', async () => {
    const body = await get('?variant=B');
    expect(body.steps.map((g) => g.variant)).toEqual(['B']);
    // S5 S6 only — S4's event row claiming variant B is ignored.
    expect(body.summary).toMatchObject({ started: 2, completed: 1, ctaClicked: 1 });
    expect(body.abComparison.variants.map((v) => v.variant)).toEqual(['A', 'B']);
    expect(body.versionComparison.stepConversion.map((m) => m.variant)).toEqual(['B']);
    expect(body.versionComparison.versions.map((v) => v.started)).toEqual([2, 1]);
  });

  it('version=3 selects v3 and surfaces recommendation_expanded with no code change', async () => {
    const body = await get('?version=3');
    expect(body.filters.version).toBe(3);
    expect(body.meta.activeVersion).toBe(1);
    expect(body.abComparison.experimentId).toBe(EXP[3]);
    expect(body.summary).toMatchObject({ started: 2, completed: 1, ctaClicked: 1 });
    expect(body.steps[1].rows.map((r) => r.stepId)).not.toContain('tool_count');
    expect(stepRow(body, 'B', 'meeting_hours')).toMatchObject({ reached: 1, eligible: 1, converted: 1 });
    expect(body.eventCounts).toEqual([
      { name: 'session_started', sessions: 2 },
      { name: 'step_completed', sessions: 2 },
      { name: 'step_viewed', sessions: 2 },
      { name: 'cta_clicked', sessions: 1 },
      { name: 'recommendation_expanded', sessions: 1 },
      { name: 'result_viewed', sessions: 1 },
    ]);
  });

  it('rejects bad input', async () => {
    const bad = await t.app.inject({ method: 'GET', url: '/api/analytics?version=abc' });
    expect(bad.statusCode).toBe(400);
    const missing = await t.app.inject({ method: 'GET', url: '/api/analytics?version=2' });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ error: 'version_not_found' });
    const variant = await t.app.inject({ method: 'GET', url: '/api/analytics?variant=C' });
    expect(variant.statusCode).toBe(400);
  });
});

describe('stats', () => {
  it('normal CDF and z-test edge cases', () => {
    expect(normalCdf(1.959964)).toBeCloseTo(0.975, 5);
    expect(normalCdf(0)).toBeCloseTo(0.5, 7);
    expect(twoProportionZTest(1, 0, 1, 2)).toEqual({ z: null, pValue: null, significantAt95: false });
    expect(twoProportionZTest(0, 10, 0, 10)).toEqual({ z: null, pValue: null, significantAt95: false });
    expect(twoProportionZTest(10, 10, 10, 10)).toEqual({ z: null, pValue: null, significantAt95: false });
    const strong = twoProportionZTest(60, 100, 30, 100);
    expect(strong.significantAt95).toBe(true);
    expect(strong.z).toBeCloseTo(4.264, 2);
  });
});
