import type { FastifyInstance, FastifyReply } from 'fastify';
import type { ActivateResponse, PublishResponse, VersionListResponse } from '@shared/api';
import { ActivateParamsSchema } from '@shared/api';
import { validateConfig } from '@shared/config.schema';
import {
  activateVersion,
  countVersionSessions,
  funnelsWithVersion,
  getVersion,
  insertVersion,
  listVersions,
  loadConfig,
  maxVersion,
  nowIso,
  type VersionRow,
} from '../queries';

const HOUR_MS = 3_600_000;

// SPEC §5: /api/admin/versions (list, publish, get, activate).
// Registered as an encapsulated plugin so the raw-body JSON parser applies to
// these routes only.
//
// These routes are UNAUTHENTICATED: anyone who can reach the deployment can
// publish, activate and roll back versions. That is a deliberate choice for this
// review deployment (see README "Known limitations"); a real deployment needs
// authentication in front of /api/admin/*.
export default async function adminRoutes(app: FastifyInstance): Promise<void> {
  const { db } = app;

  // Keep the submitted text as the body so the config is stored verbatim (§3.1).
  // The handler parses it. text/plain is accepted too (app-level parser would pre-parse it).
  app.removeContentTypeParser(['application/json', 'text/plain']);
  app.addContentTypeParser(['application/json', 'text/plain'], { parseAs: 'string' }, (_request, body, done) => {
    done(null, body);
  });

  /** Resolves `:version` (+ optional ?funnelId) to a stored row, or sends the error. */
  function resolveVersion(params: unknown, query: unknown, reply: FastifyReply): VersionRow | undefined {
    const parsed = ActivateParamsSchema.safeParse(params);
    if (!parsed.success) {
      void reply.code(404).send({ error: 'version_not_found', message: 'Version must be a positive integer' });
      return undefined;
    }
    const { version } = parsed.data;
    const requested = (query as { funnelId?: unknown } | undefined)?.funnelId;
    let funnelId: string | undefined;
    if (typeof requested === 'string' && requested !== '') {
      funnelId = requested;
    } else {
      const candidates = funnelsWithVersion(db, version);
      if (candidates.length > 1) {
        void reply.code(400).send({
          error: 'ambiguous_version',
          message: `version ${version} exists for several funnels (${candidates.join(', ')}); pass ?funnelId=`,
        });
        return undefined;
      }
      funnelId = candidates[0];
    }
    const row = funnelId === undefined ? undefined : getVersion(db, funnelId, version);
    if (!row) void reply.code(404).send({ error: 'version_not_found', message: `version ${version} does not exist` });
    return row;
  }

  app.get('/admin/versions', async (): Promise<VersionListResponse> => {
    const now = Date.now();
    return {
      versions: listVersions(db).map((row) => {
        const config = loadConfig(db, row.funnel_id, row.version);
        const ttlHours = config?.session?.ttlHours ?? 0;
        const liveSince = new Date(now - ttlHours * HOUR_MS).toISOString();
        const counts = countVersionSessions(db, row.funnel_id, row.version, liveSince);
        return {
          funnelId: row.funnel_id,
          version: row.version,
          schemaVersion: row.schema_version,
          title: typeof config?.title === 'string' ? config.title : null,
          isActive: row.is_active === 1,
          createdAt: row.created_at,
          liveSessions: counts.live,
          totalSessions: counts.total,
        };
      }),
    };
  });

  app.post('/admin/versions', async (request, reply) => {
    const text = typeof request.body === 'string' ? request.body : undefined;
    if (text === undefined) {
      return reply
        .code(415)
        .send({ error: 'unsupported_media_type', message: 'Send the funnel config as application/json' });
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (err) {
      return reply.code(400).send({ error: 'invalid_json', message: (err as Error).message });
    }

    const result = validateConfig(raw);
    if (!result.ok) {
      return reply.code(400).send({ error: 'invalid_config', message: 'Config failed validation', details: result.errors });
    }
    const { funnelId, version, schemaVersion } = result.config;

    const rejection = db.transaction((): { error: string; message: string } | null => {
      // One funnel per deployment: a config for another funnelId (e.g. a typo) would otherwise be
      // boot-activated on the next restart alongside the real funnel.
      const funnels = [...new Set(listVersions(db).map((row) => row.funnel_id))];
      if (funnels.length > 0 && !funnels.includes(funnelId)) {
        return {
          error: 'funnel_mismatch',
          message: `funnelId "${funnelId}" does not match the funnel this deployment runs (${funnels.join(', ')})`,
        };
      }
      const latest = maxVersion(db, funnelId);
      if (latest !== null && version <= latest) {
        return {
          error: 'version_conflict',
          message: `version ${version} must be greater than the latest stored version ${latest}`,
        };
      }
      insertVersion(db, {
        funnel_id: funnelId,
        version,
        config_json: text,
        schema_version: schemaVersion,
        created_at: nowIso(),
      });
      return null;
    })();

    if (rejection) return reply.code(409).send(rejection);
    const response: PublishResponse = { funnelId, version, isActive: false };
    return reply.code(201).send(response);
  });

  app.get('/admin/versions/:version', async (request, reply) => {
    const row = resolveVersion(request.params, request.query, reply);
    if (!row) return reply;
    return reply.type('application/json; charset=utf-8').send(row.config_json);
  });

  app.post('/admin/versions/:version/activate', async (request, reply) => {
    const row = resolveVersion(request.params, request.query, reply);
    if (!row) return reply;
    if (!activateVersion(db, row.funnel_id, row.version)) {
      return reply.code(404).send({ error: 'version_not_found' });
    }
    const response: ActivateResponse = { funnelId: row.funnel_id, activeVersion: row.version };
    return response;
  });
}
