import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
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
// The body is always a batch. The batch envelope is the only thing that can fail
// the request (400); every item is processed independently and gets exactly one
// result, in input order. A malformed item never fails the batch, and because
// inserts are ON CONFLICT(event_id) DO NOTHING, re-sending a batch after a
// timeout is safe: already-stored items come back `duplicate`.

/** events_rejected.raw_json is capped so a hostile item cannot bloat the table. */
const RAW_JSON_LIMIT = 10_000;

export default async function eventRoutes(app: FastifyInstance): Promise<void> {
  app.post('/events', async (request, reply) => {
    const batch = EventBatchSchema.safeParse(request.body);
    if (!batch.success) {
      const message = batch.error.issues.map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`).join('; ');
      return reply.code(400).send({ error: 'invalid_batch', message });
    }

    const { db } = app;
    // One transaction for the whole batch (one fsync instead of one per item). Each
    // item has its own try/catch; a failing statement only aborts that statement.
    const ingestAll = db.transaction((items: unknown[]) => items.map((item) => ingestItem(db, item, request.log)));
    const response: EventBatchResponse = { results: ingestAll(batch.data.events) };
    return reply.code(200).send(response);
  });
}

function ingestItem(db: DB, item: unknown, log: FastifyBaseLogger): EventResult {
  try {
    // 1. Shape. Server-derived fields a client might send (funnel_id, variant, utm_*, …) are stripped here.
    const parsed = EventItemSchema.safeParse(item);
    if (!parsed.success) return reject(db, item, 'invalid_shape', log);
    const event = parsed.data;

    // 2. Session.
    const session = getSession(db, event.session_id);
    if (!session) return reject(db, item, 'unknown_session', log);

    // 3. Name, against the session's *pinned* version. session_started is in `allowed`
    //    but only the server may write it, so that check comes first.
    if (SERVER_ONLY_EVENTS.includes(event.name)) return reject(db, item, 'server_only_event', log);
    const config = loadConfig(db, session.funnel_id, session.funnel_version);
    const definition = config?.events.allowed.find((allowed) => allowed.name === event.name);
    if (!definition) return reject(db, item, 'event_not_allowed', log);

    // 4–6. Whitelisted props, attribution re-derived from the session row, server_ts stamped, insert.
    const status = insertEvent(
      db,
      eventFromSession(session, {
        event_id: event.event_id,
        name: event.name,
        step_id: event.step_id,
        client_ts: event.client_ts,
        props: whitelistProps(definition.properties, event.props, session),
      }),
    );
    return { event_id: event.event_id, status };
  } catch (err) {
    // Not expected for any client input (the checks above guarantee the constraints
    // hold). Keep the batch alive and record the item rather than dropping it silently.
    log.error({ err }, 'event ingest failed for one item');
    return reject(db, item, 'invalid_shape', log);
  }
}

/**
 * Keeps only the properties the pinned config lists for this event name — the
 * privacy boundary: raw answer values can never reach `events`. `result_id` is
 * never taken from the client; it is stamped from the session row (omitted while
 * the session has no result).
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
    } else if (clientProps && Object.hasOwn(clientProps, key) && clientProps[key] !== undefined) {
      props[key] = clientProps[key];
    }
  }
  return props;
}

function reject(db: DB, item: unknown, reason: RejectReason, log: FastifyBaseLogger): EventResult {
  const record = typeof item === 'object' && item !== null ? (item as Record<string, unknown>) : null;
  const sessionId = typeof record?.session_id === 'string' ? record.session_id : null;
  const eventId = typeof record?.event_id === 'string' ? record.event_id : null;
  try {
    insertRejected(db, { session_id: sessionId, raw_json: stringify(item).slice(0, RAW_JSON_LIMIT), reason });
  } catch (err) {
    log.error({ err, reason }, 'failed to record rejected event');
  }
  return { event_id: eventId, status: 'rejected', reason };
}

function stringify(item: unknown): string {
  try {
    return JSON.stringify(item) ?? String(item);
  } catch {
    return String(item);
  }
}
