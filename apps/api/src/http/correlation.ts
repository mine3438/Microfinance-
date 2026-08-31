import { randomUUID } from 'node:crypto';
import { type FastifyInstance } from 'fastify';

/** Header a caller may use to supply its own correlation identifier. */
export const CORRELATION_HEADER = 'x-correlation-id';

/** Longest caller-supplied correlation identifier accepted. */
const MAXIMUM_CORRELATION_LENGTH = 128;

/** A correlation ID is echoed into logs and responses, so it must be inert. */
const SAFE_CORRELATION = /^[A-Za-z0-9_-]+$/;

/**
 * Give every request an identifier that appears in its logs and its response.
 *
 * This is the only internal detail an error response is allowed to carry, and
 * it is what makes "something went wrong" supportable: the user quotes a
 * reference, and the operator finds the exact request, with its real error, in
 * the logs.
 *
 * A caller-supplied value is honoured so a trace can span the browser and the
 * API — but validated first, because it is written into structured logs and
 * returned in a response body. An unvalidated one is a log-injection and
 * response-splitting vector handed to us by the caller. Anything that is not a
 * short, plain identifier is replaced rather than rejected: a malformed trace
 * header should not fail an otherwise valid request.
 */
export function registerCorrelationId(app: FastifyInstance): void {
  app.addHook('onRequest', (request, reply, done) => {
    const supplied = request.headers[CORRELATION_HEADER];
    const candidate = Array.isArray(supplied) ? supplied[0] : supplied;

    const correlationId =
      typeof candidate === 'string' &&
      candidate.length > 0 &&
      candidate.length <= MAXIMUM_CORRELATION_LENGTH &&
      SAFE_CORRELATION.test(candidate)
        ? candidate
        : randomUUID();

    request.correlationId = correlationId;
    void reply.header(CORRELATION_HEADER, correlationId);
    done();
  });
}
