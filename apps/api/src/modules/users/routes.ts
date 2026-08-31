import {
  acceptInvitationRequestSchema,
  createInvitationRequestSchema,
  createdInvitationSchema,
  invitationPreviewSchema,
  invitationSchema,
  previewInvitationRequestSchema,
  staffMemberSchema,
  updateStaffRequestSchema,
  uuidSchema,
} from '@mfi/contracts';
import { type FastifyInstance, type FastifyRequest } from 'fastify';
import { z } from 'zod';

import { type AccessTokenService } from '../../auth/access-token.js';
import { authenticate, principalOf, requirePermission } from '../../http/authentication.js';
import { validationFailed } from '../../http/errors.js';
import { type InvitationDelivery } from '../../notifications/invitation-delivery.js';
import { type UserRepository } from './user-repository.js';
import {
  acceptInvitation,
  inviteStaff,
  listInvitations,
  listStaff,
  previewInvitation,
  revokeInvitation,
  updateStaff,
} from './use-cases.js';

const staffListSchema = z.array(staffMemberSchema);
const invitationListSchema = z.array(invitationSchema);

export interface UserRouteOptions {
  readonly users: UserRepository;
  readonly delivery: InvitationDelivery;
  readonly webBaseUrl: string;
  readonly tokens: AccessTokenService;
  readonly now?: () => Date;
}

function idOf(request: FastifyRequest, key: string, subject: string): string {
  const parsed = uuidSchema.safeParse((request.params as Record<string, unknown>)[key]);
  if (!parsed.success) {
    throw validationFailed(parsed.error, `That is not a ${subject} identifier.`);
  }
  return parsed.data;
}

/**
 * Staff and invitation routes.
 *
 * Two groups with different authentication, which is the whole shape of the
 * feature:
 *
 * - `/users/**` require a session and a permission. Inviting is `user.invite`,
 *   reading is `user.read`, amending is `user.manage` — three permissions
 *   seeded by migration 0005 that until now enforced nothing at all.
 * - `/auth/invitations/**` require no session, because the person accepting
 *   does not have one and cannot get one until they do. They are authenticated
 *   by the token itself, which is checked against a stored hash.
 *
 * Both acceptance routes are `POST` with the token in the body, including the
 * one that only reads. A token in a path or a query string is written to the
 * access log, kept in browser history, and leaked in the `Referer` header of
 * every subsequent request the page makes — three durable copies of a
 * single-use credential, in places nobody thinks to audit. `GET` would be the
 * conventional verb for a read; it is the wrong one here.
 */
export function registerUserRoutes(app: FastifyInstance, options: UserRouteOptions): void {
  const { users, delivery, webBaseUrl, tokens } = options;
  const now = options.now ?? ((): Date => new Date());
  const authenticated = authenticate(tokens);

  app.get(
    '/users',
    { preHandler: [authenticated, requirePermission('user.read')] },
    async (request): Promise<unknown> =>
      staffListSchema.parse(await listStaff(principalOf(request), users)),
  );

  app.get(
    '/users/invitations',
    { preHandler: [authenticated, requirePermission('user.read')] },
    async (request): Promise<unknown> =>
      invitationListSchema.parse(await listInvitations(principalOf(request), users, now())),
  );

  app.post(
    '/users/invitations',
    { preHandler: [authenticated, requirePermission('user.invite')] },
    async (request, reply): Promise<unknown> => {
      const body = createInvitationRequestSchema.safeParse(request.body);
      if (!body.success) {
        throw validationFailed(body.error, 'That invitation cannot be created as entered.');
      }

      const created = await inviteStaff(principalOf(request), body.data, {
        users,
        delivery,
        webBaseUrl,
        now,
      });

      void reply.status(201);
      return createdInvitationSchema.parse(created);
    },
  );

  /**
   * Withdraw an invitation.
   *
   * A POST creating a revocation rather than a DELETE removing the invitation.
   * The row stays: who was invited, by whom, and that the offer was withdrawn
   * is exactly the sort of thing an inspection asks about, and a deleted row
   * answers nothing.
   */
  app.post(
    '/users/invitations/:id/revocation',
    { preHandler: [authenticated, requirePermission('user.invite')] },
    async (request): Promise<unknown> =>
      invitationSchema.parse(
        await revokeInvitation(
          principalOf(request),
          idOf(request, 'id', 'invitation'),
          users,
          now(),
        ),
      ),
  );

  app.patch(
    '/users/:id',
    { preHandler: [authenticated, requirePermission('user.manage')] },
    async (request): Promise<unknown> => {
      const body = updateStaffRequestSchema.safeParse(request.body);
      if (!body.success) {
        throw validationFailed(body.error, 'That change cannot be applied as entered.');
      }

      return staffMemberSchema.parse(
        await updateStaff(principalOf(request), idOf(request, 'id', 'staff'), body.data, users),
      );
    },
  );

  /** What an invitee is joining, before they commit to a password. */
  app.post(
    '/auth/invitations/preview',
    {
      config: {
        // Unauthenticated and reachable by anyone, so it is bounded — but more
        // loosely than acceptance, because it costs one indexed lookup and a
        // legitimate invitee may reload the page a few times.
        rateLimit: { max: 20, timeWindow: '1 minute' },
      },
    },
    async (request): Promise<unknown> => {
      const body = previewInvitationRequestSchema.safeParse(request.body);
      if (!body.success) {
        throw validationFailed(body.error, 'That invitation link is not valid.');
      }

      return invitationPreviewSchema.parse(await previewInvitation(body.data.token, users, now()));
    },
  );

  app.post(
    '/auth/invitations/acceptance',
    {
      config: {
        // Login's tier, and for login's reason. This endpoint is
        // unauthenticated and hashes a password with argon2, so each call costs
        // real CPU; without a bound, an unauthenticated caller can exhaust the
        // server by repeating it. `skipOnError: false` for the same reason
        // login uses it — here the limit is the control, so an unreachable
        // limiter must close the endpoint rather than open it.
        rateLimit: { max: 5, timeWindow: '1 minute', skipOnError: false },
      },
    },
    async (request, reply): Promise<unknown> => {
      const body = acceptInvitationRequestSchema.safeParse(request.body);
      if (!body.success) {
        throw validationFailed(body.error, 'That invitation cannot be accepted as entered.');
      }

      await acceptInvitation(body.data, users, now());

      // No session is issued here. Accepting sets a password; signing in is the
      // login endpoint's job, and routing the new user through it means the
      // account they just created is proved to work before they rely on it —
      // and that one code path issues every session in the system.
      void reply.status(204);
      return null;
    },
  );
}
