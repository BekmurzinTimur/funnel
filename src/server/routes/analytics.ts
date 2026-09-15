import type { FastifyInstance } from 'fastify';
import { AnalyticsQuerySchema } from '@shared/api';
import { computeAnalytics } from '../analytics';

// Track D — SPEC §7: GET /api/analytics?version=&variant=&utm_campaign=
export default async function analyticsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/analytics', async (request, reply) => {
    const parsed = AnalyticsQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'invalid_query',
        message: 'Invalid analytics query',
        details: parsed.error.issues.map((issue) => `${issue.path.join('.') || 'query'}: ${issue.message}`),
      });
    }
    const outcome = computeAnalytics(app.db, parsed.data);
    if (!outcome.ok) return reply.code(outcome.status).send({ error: outcome.error, message: outcome.message });
    return outcome.body;
  });
}
