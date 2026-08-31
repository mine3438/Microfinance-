import { type Principal } from '@mfi/identity';

/**
 * What this API adds to a Fastify request.
 *
 * Declared once, module-augmented into Fastify's own types, so a handler
 * reading `request.principal` is type-checked rather than casting. The
 * alternative — decorating the request and casting at each use — puts an `any`
 * at exactly the point where authorisation decisions are made.
 */
declare module 'fastify' {
  interface FastifyRequest {
    /** Identifier tying this request to its log entries. Always present. */
    correlationId: string;
    /**
     * The authenticated caller, or `undefined` on an unauthenticated route.
     *
     * Optional in the type on purpose. A handler behind the authentication
     * guard must still narrow it, so a route that is accidentally registered
     * without the guard cannot silently read `undefined` as a principal.
     */
    principal?: Principal;
  }
}

export {};
