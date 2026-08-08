import { type Permission } from '@mfi/contracts';
import { can, type Principal } from '@mfi/identity';
import {
  type FastifyReply,
  type FastifyRequest,
  type preHandlerAsyncHookHandler,
  type preHandlerHookHandler,
} from 'fastify';

import { type AccessTokenService } from '../auth/access-token.js';
import { forbidden, unauthenticated } from './errors.js';

const BEARER = /^Bearer (.+)$/;

/**
 * Build the guard that turns a bearer token into a principal.
 *
 * A factory taking its dependency rather than a module-level function reaching
 * for a singleton: this is the composition root's job to wire, and a test
 * builds one with its own token service.
 */
export function authenticate(tokens: AccessTokenService): preHandlerAsyncHookHandler {
  return async (request: FastifyRequest): Promise<void> => {
    const header = request.headers.authorization;

    if (typeof header !== 'string') {
      throw unauthenticated();
    }

    const match = BEARER.exec(header);
    if (match?.[1] === undefined) {
      throw unauthenticated();
    }

    // Any failure inside verify() is an InvalidTokenError, which the error
    // handler maps to the same 401 as a missing header. The reason reaches the
    // log; the caller learns only that it is not authenticated.
    request.principal = await tokens.verify(match[1]);
  };
}

/**
 * The principal, or a refusal if the route was not behind the guard.
 *
 * Throwing rather than returning `undefined` is what makes forgetting the guard
 * a 500 in this server's logs instead of a handler that proceeds with no
 * caller. An authorisation check that silently sees nobody is the failure mode
 * worth making loud.
 */
export function principalOf(request: FastifyRequest): Principal {
  if (request.principal === undefined) {
    throw unauthenticated();
  }
  return request.principal;
}

/**
 * Require a permission.
 *
 * Registered as a second `preHandler` after {@link authenticate}, so the two
 * concerns stay separate: who you are, then whether you may.
 *
 * This is the real boundary. The web client also hides what a user cannot do,
 * but that is presentation — the interface is not the only way in, and a route
 * whose only protection is a hidden button has no protection.
 */
export function requirePermission(permission: Permission): preHandlerHookHandler {
  return (request: FastifyRequest, _reply: FastifyReply, done: (error?: Error) => void): void => {
    const principal = principalOf(request);

    if (!can(principal, permission)) {
      done(
        forbidden(
          `This action requires the ${permission} permission, which your role does not hold.`,
        ),
      );
      return;
    }

    done();
  };
}
