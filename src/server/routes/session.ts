import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  AnswerBodySchema,
  BackBodySchema,
  SESSION_COOKIE,
  SessionQuerySchema,
  SYNTHETIC_HEADER,
  type SessionQuery,
} from '@shared/api';
import {
  applyAnswer,
  applyBack,
  createSession,
  isValidVariant,
  loadLiveSession,
  resumeSession,
  sessionResponse,
  type LoadedSession,
} from '../session';

/** Lenient query parsing: an invalid param (too long, repeated) is dropped, never fatal. */
function parseQuery(query: unknown): SessionQuery {
  const whole = SessionQuerySchema.safeParse(query);
  if (whole.success) return whole.data;
  const source = (typeof query === 'object' && query !== null ? query : {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, schema] of Object.entries(SessionQuerySchema.shape)) {
    const field = schema.safeParse(source[key]);
    if (field.success && field.data !== undefined) out[key] = field.data;
  }
  return out as SessionQuery;
}

// Track A — SPEC §4: POST /api/session, /api/session/answer, /api/session/back.
export default async function sessionRoutes(app: FastifyInstance): Promise<void> {
  const { db } = app;

  const liveSessionOr404 = (request: FastifyRequest, reply: FastifyReply): LoadedSession | undefined => {
    const session = loadLiveSession(db, request.cookies[SESSION_COOKIE]);
    if (!session) void reply.code(404).send({ error: 'session_not_found' });
    return session;
  };

  app.post('/session', async (request, reply) => {
    const query = parseQuery(request.query);
    const existing = query.reset === '1' ? undefined : loadLiveSession(db, request.cookies[SESSION_COOKIE]);

    // A different, valid ?variant never mutates the pinned session: it starts a new one.
    const overrideDiffers =
      existing !== undefined && isValidVariant(existing.config, query.variant) && query.variant !== existing.row.variant;

    if (existing && !overrideDiffers) {
      return sessionResponse(resumeSession(db, existing));
    }

    const created = createSession(db, {
      variantOverride: query.variant,
      utm: { utm_source: query.utm_source, utm_medium: query.utm_medium, utm_campaign: query.utm_campaign },
      synthetic: request.headers[SYNTHETIC_HEADER] === '1',
    });
    if (!created) return reply.code(503).send({ error: 'no_active_version', message: 'No funnel version is active' });

    reply.setCookie(SESSION_COOKIE, created.row.id, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: Math.round(created.config.session.ttlHours * 3600),
    });
    return sessionResponse(created);
  });

  app.post('/session/answer', async (request, reply) => {
    const session = liveSessionOr404(request, reply);
    if (!session) return reply;
    const body = AnswerBodySchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_body', message: body.error.message });

    const outcome = applyAnswer(db, session, body.data.stepId, body.data.value);
    if (!outcome.ok) return reply.code(400).send({ error: 'invalid_answer', message: outcome.message });
    return outcome.state;
  });

  app.post('/session/back', async (request, reply) => {
    const session = liveSessionOr404(request, reply);
    if (!session) return reply;
    const body = BackBodySchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_body', message: body.error.message });
    return applyBack(db, session, body.data.stepId);
  });
}
