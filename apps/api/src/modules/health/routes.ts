import { type Database } from '@mfi/db';
import { type FastifyInstance, type FastifyReply } from 'fastify';

export interface HealthRouteOptions {
  readonly database: Database;
}

/**
 * Liveness and readiness, which are not the same question.
 *
 * `/health` asks whether the process is running and should be restarted if not.
 * `/ready` asks whether it can serve traffic and should receive requests if so.
 * Conflating them produces a container that is killed and restarted because its
 * database is briefly unreachable — which fixes nothing and removes capacity
 * during the exact incident it was reacting to.
 *
 * Neither requires authentication, and neither says anything an unauthenticated
 * caller should not know: no version, no dependency hostname, no error detail.
 * A readiness probe that reports *why* it is unready is a reconnaissance
 * endpoint; the reason belongs in the log.
 */
export function registerHealthRoutes(app: FastifyInstance, options: HealthRouteOptions): void {
  app.get('/health', { config: { rateLimit: false } }, () => ({ status: 'ok' }));

  app.get(
    '/ready',
    { config: { rateLimit: false } },
    async (request, reply: FastifyReply): Promise<unknown> => {
      try {
        // The same check the process runs at boot: connectivity, tenancy
        // resolution, and that migrations have been applied. Tenancy is in
        // there because when `current_institution_id()` stops resolving, every
        // policy evaluates false and the application serves empty screens with
        // no error — R4, which went undiagnosed repeatedly in the system this
        // replaces. A readiness probe that only opened a connection would call
        // that healthy.
        await options.database.verifyReadiness();
        return { status: 'ready' };
      } catch (error: unknown) {
        request.log.error({ err: error }, 'Readiness check failed.');
        return reply.status(503).send({ status: 'unready' });
      }
    },
  );
}
