// Request/response contracts for every HTTP route. Server handlers parse inputs
// with these schemas; the web app and the traffic generator build against the
// inferred types.
import { z } from 'zod';
import type { Answers, MaterialisedConfig } from './types';

// ---------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------

export const ApiErrorSchema = z.object({
  error: z.string(),
  message: z.string().optional(),
  details: z.array(z.string()).optional(),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;

const ScalarSchema = z.union([z.string(), z.number(), z.boolean()]);
export const AnswerValueSchema = z.union([ScalarSchema, z.array(ScalarSchema)]);

export const ProgressSchema = z.object({
  current: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
});

// ---------------------------------------------------------------------------
// Session — §4
// ---------------------------------------------------------------------------

/** Cookie holding the session UUID (httpOnly, maxAge = pinned ttlHours). */
export const SESSION_COOKIE = 'fsid';
/** Header the traffic generator sets so sessions (and their events) are marked synthetic. */
export const SYNTHETIC_HEADER = 'x-synthetic';

/** Query string of `POST /api/session`. Unknown params are ignored. */
export const SessionQuerySchema = z.object({
  variant: z.string().optional(),
  reset: z.string().optional(),
  utm_source: z.string().max(200).optional(),
  utm_medium: z.string().max(200).optional(),
  utm_campaign: z.string().max(200).optional(),
});
export type SessionQuery = z.infer<typeof SessionQuerySchema>;

/** Returned by `/api/session/answer` and `/api/session/back`. */
export const NavigationResponseSchema = z.object({
  currentStepId: z.string().nullable(),
  visibleSteps: z.array(z.string()),
  progress: ProgressSchema,
  resultId: z.string().nullable(),
});
export type NavigationResponse = z.infer<typeof NavigationResponseSchema>;

/** Returned by `POST /api/session` (create or resume). */
export const SessionResponseSchema = NavigationResponseSchema.extend({
  sessionId: z.string(),
  funnelVersion: z.number().int().positive(),
  variant: z.string(),
  variantForced: z.boolean(),
  /** Materialised for this session's variant. */
  config: z.custom<MaterialisedConfig>((v) => typeof v === 'object' && v !== null),
  answers: z.record(z.string(), AnswerValueSchema) as unknown as z.ZodType<Answers>,
});
export type SessionResponse = z.infer<typeof SessionResponseSchema>;

/** `POST /api/session/answer`. `value` is omitted for info steps. */
export const AnswerBodySchema = z.object({
  stepId: z.string().min(1),
  value: AnswerValueSchema.optional(),
});
export type AnswerBody = z.infer<typeof AnswerBodySchema>;

/** `POST /api/session/back`. */
export const BackBodySchema = z.object({
  stepId: z.string().min(1),
});
export type BackBody = z.infer<typeof BackBodySchema>;

// ---------------------------------------------------------------------------
// Events — §6
// ---------------------------------------------------------------------------

/** Events only the server may write. */
export const SERVER_ONLY_EVENTS: readonly string[] = ['session_started'];

export const MAX_BATCH_SIZE = 500;

/**
 * One client-submitted event. Server-derived fields (funnel_id, funnel_version,
 * experiment_id, variant, utm_*, is_synthetic, server_ts) are not part of the
 * contract; if a client sends them they are stripped and re-derived from the
 * session row.
 */
export const EventItemSchema = z.object({
  event_id: z.uuid(),
  session_id: z.string().min(1).max(100),
  name: z.string().min(1).max(100),
  step_id: z.string().max(200).nullable().optional(),
  client_ts: z.string().max(64).nullable().optional(),
  props: z.record(z.string(), z.unknown()).optional(),
});
export type EventItem = z.infer<typeof EventItemSchema>;

/** `POST /api/events` body — always a batch. Items are validated one by one. */
export const EventBatchSchema = z.object({
  events: z.array(z.unknown()).max(MAX_BATCH_SIZE),
});
export type EventBatch = { events: EventItem[] };

export const EVENT_STATUSES = ['accepted', 'duplicate', 'rejected'] as const;
export type EventStatus = (typeof EVENT_STATUSES)[number];

export const REJECT_REASONS = ['invalid_shape', 'unknown_session', 'event_not_allowed', 'server_only_event'] as const;
export type RejectReason = (typeof REJECT_REASONS)[number];

export const EventResultSchema = z.object({
  /** null when the item was too malformed to carry an event_id. */
  event_id: z.string().nullable(),
  status: z.enum(EVENT_STATUSES),
  reason: z.enum(REJECT_REASONS).optional(),
});
export type EventResult = z.infer<typeof EventResultSchema>;

/** Always HTTP 200, one result per submitted item, in order. */
export const EventBatchResponseSchema = z.object({
  results: z.array(EventResultSchema),
});
export type EventBatchResponse = z.infer<typeof EventBatchResponseSchema>;

// ---------------------------------------------------------------------------
// Admin — §5. All routes require `Authorization: Bearer ${ADMIN_TOKEN}`.
// ---------------------------------------------------------------------------

export const VersionSummarySchema = z.object({
  funnelId: z.string(),
  version: z.number().int().positive(),
  schemaVersion: z.string(),
  title: z.string().nullable(),
  isActive: z.boolean(),
  createdAt: z.string(),
  /** Sessions pinned to this version still within their TTL. */
  liveSessions: z.number().int().nonnegative(),
  totalSessions: z.number().int().nonnegative(),
});
export type VersionSummary = z.infer<typeof VersionSummarySchema>;

/** `GET /api/admin/versions` */
export const VersionListResponseSchema = z.object({
  versions: z.array(VersionSummarySchema),
});
export type VersionListResponse = z.infer<typeof VersionListResponseSchema>;

/** `POST /api/admin/versions` — 201 on success; 400 (validation, `details` lists every problem) or 409 (version not increasing). */
export const PublishResponseSchema = z.object({
  funnelId: z.string(),
  version: z.number().int().positive(),
  isActive: z.literal(false),
});
export type PublishResponse = z.infer<typeof PublishResponseSchema>;

/** `POST /api/admin/versions/:version/activate` */
export const ActivateParamsSchema = z.object({
  version: z.coerce.number().int().positive(),
});
export const ActivateResponseSchema = z.object({
  funnelId: z.string(),
  activeVersion: z.number().int().positive(),
});
export type ActivateResponse = z.infer<typeof ActivateResponseSchema>;

// `GET /api/admin/versions/:version` returns the stored config JSON verbatim.

// ---------------------------------------------------------------------------
// Analytics — §7
// ---------------------------------------------------------------------------

/** `GET /api/analytics` — these three params and nothing else. `version` defaults to the active version. */
export const AnalyticsQuerySchema = z.object({
  version: z.coerce.number().int().positive().optional(),
  variant: z.string().min(1).optional(),
  utm_campaign: z.string().min(1).optional(),
});
export type AnalyticsQuery = z.infer<typeof AnalyticsQuerySchema>;

/** A ratio in [0, 1], or null when the denominator is zero. */
const RateSchema = z.number().nullable();

export const FunnelMetricsSchema = z.object({
  started: z.number().int(),
  completed: z.number().int(),
  ctaClicked: z.number().int(),
  /** completed / started */
  completionRate: RateSchema,
  /** ctaClicked / completed */
  ctaCtr: RateSchema,
  /** ctaClicked / started — the A/B primary metric */
  conversion: RateSchema,
});
export type FunnelMetrics = z.infer<typeof FunnelMetricsSchema>;

export const StepRowSchema = z.object({
  stepId: z.string(),
  type: z.string(),
  /** First step of the sequence: Eligible is the session_started set. */
  isEntry: z.boolean(),
  /** Distinct sessions with step_viewed for this step. */
  reached: z.number().int(),
  /** Distinct sessions with an incoming edge (step_completed.next_step_id = step). */
  eligible: z.number().int(),
  /** Reached ∩ Eligible. */
  converted: z.number().int(),
  /** converted / eligible */
  conversionRate: RateSchema,
  /** Reached with no outgoing step_completed and no result_viewed. null for the result step. */
  dropOff: z.number().int().nullable(),
  /** dropOff / reached */
  dropOffRate: RateSchema,
});
export type StepRow = z.infer<typeof StepRowSchema>;

export const ZTestSchema = z.object({
  metric: z.literal('cta_clicked / session_started'),
  /** null when either variant has no sessions or the pooled rate is 0 or 1. */
  z: z.number().nullable(),
  pValue: z.number().nullable(),
  significantAt95: z.boolean(),
});

/** A step × version cell: null means the step is absent from that version (render "n/a"). */
export const StepCellSchema = z
  .object({ eligible: z.number().int(), converted: z.number().int(), rate: RateSchema })
  .nullable();

export const AnalyticsResponseSchema = z.object({
  meta: z.object({
    funnelId: z.string().nullable(),
    activeVersion: z.number().int().nullable(),
    versions: z.array(z.number().int()),
    campaigns: z.array(z.string()),
    /** Variant keys of the selected version. */
    variants: z.array(z.string()),
  }),
  filters: z.object({
    version: z.number().int().nullable(),
    variant: z.string().nullable(),
    utm_campaign: z.string().nullable(),
  }),
  summary: FunnelMetricsSchema,
  /** Per-step breakdown within each variant (only the filtered variant when one is set). */
  steps: z.array(z.object({ variant: z.string(), rows: z.array(StepRowSchema) })),
  /** Funnel-level only. variant_forced sessions are always excluded here. */
  abComparison: z.object({
    experimentId: z.string().nullable(),
    variants: z.array(FunnelMetricsSchema.extend({ variant: z.string() })),
    zTest: ZTestSchema,
  }),
  versionComparison: z.object({
    versions: z.array(FunnelMetricsSchema.extend({ version: z.number().int(), experimentId: z.string() })),
    stepConversion: z.array(
      z.object({
        variant: z.string(),
        stepIds: z.array(z.string()),
        rows: z.array(z.object({ version: z.number().int(), cells: z.record(z.string(), StepCellSchema) })),
      }),
    ),
  }),
  /** COUNT(DISTINCT session_id) per event name — surfaces new event types with no code change. */
  eventCounts: z.array(z.object({ name: z.string(), sessions: z.number().int() })),
});
export type AnalyticsResponse = z.infer<typeof AnalyticsResponseSchema>;
