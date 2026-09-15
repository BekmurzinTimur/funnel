import type { FastifyInstance } from 'fastify';
import {
  EventBatchSchema,
  EventItemSchema,
  SERVER_ONLY_EVENTS,
  type EventBatchResponse,
  type EventResult,
  type RejectReason,
} from '@shared/api';
import type { DB } from '../db';
import { eventFromSession, getSession, insertEvent, insertRejected, loadConfig, type SessionRow } from '../queries';

// Track C — SPEC §6: POST /api/events.
//
// The body is always a batch. Every item gets exactly one result, in input order,
// and no client input can fail the batch: a malformed item is rejected and
// recorded, the rest are stored. Inserts are ON CONFLICT(event_id) DO NOTHING, so
// re-sending a batch after a timeout is safe: stored items come back `duplicate`.
//
// Client input never makes the insert paths throw, so an exception here is a
// server fault (disk, lock, schema). It propagates out of the transaction, the
// whole batch rolls back (including its events_rejected rows) and the client gets
// a 500; its retry is safe for the same idempotency reason.

/** events_rejected.raw_json is capped so a hostile item cannot bloat the table. */
const RAW_JSON_LIMIT = 10_000;
/** Longer session_id strings are not stored on events_rejected (EventItemSchema caps it at 100 too). */
const REJECTED_SESSION_ID_LIMIT = 100;
/** Longest string prop value stored. Longer values are dropped, not truncated. */
const PROP_STRING_LIMIT = 200;

export default async function eventRoutes(app: FastifyInstance): Promise<void> {
  const { db } = app;
  // One transaction per batch: one fsync instead of one per item, and all-or-nothing on a fault.
  const ingestAll = db.transaction((items: unknown[]): EventResult[] => items.map((item) => ingestItem(db, item)));

  app.post('/events', async (request, reply) => {
    const batch = EventBatchSchema.safeParse(request.body);
    if (!batch.success) {
      const message = batch.error.issues.map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`).join('; ');
      return reply.code(400).send({ error: 'invalid_batch', message });
    }

    let results: EventResult[];
    try {
      results = ingestAll(batch.data.events);
    } catch (err) {
      request.log.error({ err }, 'event batch rolled back');
      return reply.code(500).send({ error: 'ingest_failed', message: 'The batch was not stored; retrying is safe.' });
    }
    const response: EventBatchResponse = { results };
    return reply.code(200).send(response);
  });
}

function ingestItem(db: DB, item: unknown): EventResult {
  // 1. Shape. Server-derived fields a client might send (funnel_id, variant, utm_*, …) are stripped here.
  const parsed = EventItemSchema.safeParse(item);
  if (!parsed.success) return reject(db, item, 'invalid_shape');
  const event = parsed.data;
  // UUIDs are case-insensitive: a retry that changes case must still dedupe.
  const eventId = event.event_id.toLowerCase();

  // 2. Session.
  const session = getSession(db, event.session_id);
  if (!session) return reject(db, item, 'unknown_session');

  // 3. Name, against the session's *pinned* version. session_started is in `allowed`
  //    but only the server may write it, so that check comes first.
  if (SERVER_ONLY_EVENTS.includes(event.name)) return reject(db, item, 'server_only_event');
  const allowed = loadConfig(db, session.funnel_id, session.funnel_version)?.events?.allowed ?? [];
  const definition = allowed.find((candidate) => candidate.name === event.name);
  if (!definition) return reject(db, item, 'event_not_allowed');

  // 4–6. Whitelisted props, attribution re-derived from the session row, server_ts stamped, insert.
  const status = insertEvent(
    db,
    eventFromSession(session, {
      event_id: eventId,
      name: event.name,
      step_id: event.step_id,
      client_ts: event.client_ts,
      props: whitelistProps(definition.properties ?? [], event.props, session),
    }),
  );
  return { event_id: event.event_id, status };
}

/** Only short scalars may enter props_json — no objects, arrays or free text that could smuggle an answer. */
const isStorablePropValue = (value: unknown): boolean =>
  value === null ||
  typeof value === 'boolean' ||
  (typeof value === 'number' && Number.isFinite(value)) ||
  (typeof value === 'string' && value.length <= PROP_STRING_LIMIT);

/**
 * The privacy boundary (§0.6): keeps only the properties the pinned config lists
 * for this event name, and only if their values are short scalars. Anything else is
 * silently dropped. `result_id` is never taken from the client; it is stamped from
 * the session row (omitted while the session has no result).
 */
function whitelistProps(
  properties: readonly string[],
  clientProps: Record<string, unknown> | undefined,
  session: SessionRow,
): Record<string, unknown> {
  const props: Record<string, unknown> = {};
  for (const key of properties) {
    if (key === 'result_id') {
      if (session.result_id !== null) props.result_id = session.result_id;
    } else if (clientProps && Object.hasOwn(clientProps, key) && isStorablePropValue(clientProps[key])) {
      props[key] = clientProps[key];
    }
  }
  return props;
}

function reject(db: DB, item: unknown, reason: RejectReason): EventResult {
  const record = typeof item === 'object' && item !== null ? (item as Record<string, unknown>) : null;
  const sessionId =
    typeof record?.session_id === 'string' && record.session_id.length <= REJECTED_SESSION_ID_LIMIT ? record.session_id : null;
  const eventId = typeof record?.event_id === 'string' ? record.event_id : null;
  insertRejected(db, { session_id: sessionId, raw_json: stringify(item).slice(0, RAW_JSON_LIMIT), reason });
  return { event_id: eventId, status: 'rejected', reason };
}

/** Items come from JSON.parse, so JSON.stringify cannot throw; `undefined` only arises for non-JSON input. */
const stringify = (item: unknown): string => JSON.stringify(item) ?? String(item);
