import {
  addGroupMemberRequestSchema,
  createGroupRequestSchema,
  endGroupMembershipRequestSchema,
  groupMemberQuerySchema,
  groupMemberSchema,
  groupSchema,
  updateGroupRequestSchema,
  uuidSchema,
} from '@mfi/contracts';
import { type FastifyInstance, type FastifyRequest } from 'fastify';
import { z } from 'zod';

import { type AccessTokenService } from '../../auth/access-token.js';
import { authenticate, principalOf, requirePermission } from '../../http/authentication.js';
import { validationFailed } from '../../http/errors.js';
import { type GroupRepository } from './group-repository.js';
import {
  addMember,
  createGroup,
  endMembership,
  getGroup,
  listGroups,
  listGroupsForClient,
  listMembers,
  updateGroup,
} from './use-cases.js';

const groupListSchema = z.array(groupSchema);
const memberListSchema = z.array(groupMemberSchema);

export interface GroupRouteOptions {
  readonly groups: GroupRepository;
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
 * Group routes.
 *
 * Guarded by the borrower permissions. A group is a borrower-side record, and a
 * new `group.*` permission set would mean deciding which roles hold it — policy
 * nobody has stated. `client.read`, `client.create` and `client.update` give
 * exactly the people who may register and amend borrowers the same reach over
 * groups.
 *
 * Note what is absent: there is no route that lends to a group. The approved
 * model is built and recorded, and the reporting question that blocks it is
 * GROUP-05.
 */
export function registerGroupRoutes(app: FastifyInstance, options: GroupRouteOptions): void {
  const { groups, tokens } = options;
  const now = options.now ?? ((): Date => new Date());
  const authenticated = authenticate(tokens);

  app.get(
    '/groups',
    { preHandler: [authenticated, requirePermission('client.read')] },
    async (request): Promise<unknown> =>
      groupListSchema.parse(await listGroups(principalOf(request), groups)),
  );

  app.post(
    '/groups',
    { preHandler: [authenticated, requirePermission('client.create')] },
    async (request, reply): Promise<unknown> => {
      const body = createGroupRequestSchema.safeParse(request.body);
      if (!body.success) {
        throw validationFailed(body.error, 'That group cannot be created as entered.');
      }

      const created = await createGroup(principalOf(request), body.data, groups, now);

      void reply.status(201).header('location', `/groups/${created.id}`);
      return groupSchema.parse(created);
    },
  );

  app.get(
    '/groups/:id',
    { preHandler: [authenticated, requirePermission('client.read')] },
    async (request): Promise<unknown> =>
      groupSchema.parse(await getGroup(principalOf(request), idOf(request, 'id', 'group'), groups)),
  );

  app.patch(
    '/groups/:id',
    { preHandler: [authenticated, requirePermission('client.update')] },
    async (request): Promise<unknown> => {
      const body = updateGroupRequestSchema.safeParse(request.body);
      if (!body.success) {
        throw validationFailed(body.error, 'That group cannot be changed as entered.');
      }

      return groupSchema.parse(
        await updateGroup(principalOf(request), idOf(request, 'id', 'group'), body.data, groups),
      );
    },
  );

  /**
   * Who is in the group.
   *
   * `?asAt=YYYY-MM-DD` returns membership as it stood that day rather than
   * today's roster — which is what makes an old group loan legible once people
   * have come and gone.
   */
  app.get(
    '/groups/:id/members',
    { preHandler: [authenticated, requirePermission('client.read')] },
    async (request): Promise<unknown> => {
      const query = groupMemberQuerySchema.safeParse(request.query);
      if (!query.success) {
        throw validationFailed(query.error, 'Those membership options are not valid.');
      }

      return memberListSchema.parse(
        await listMembers(
          principalOf(request),
          idOf(request, 'id', 'group'),
          query.data.asAt,
          groups,
        ),
      );
    },
  );

  app.post(
    '/groups/:id/members',
    { preHandler: [authenticated, requirePermission('client.update')] },
    async (request, reply): Promise<unknown> => {
      const body = addGroupMemberRequestSchema.safeParse(request.body);
      if (!body.success) {
        throw validationFailed(body.error, 'That member cannot be added as entered.');
      }

      const added = await addMember(
        principalOf(request),
        idOf(request, 'id', 'group'),
        body.data,
        groups,
        now,
      );

      void reply.status(201);
      return groupMemberSchema.parse(added);
    },
  );

  /**
   * Record that a member has left.
   *
   * A POST creating a departure rather than a DELETE removing the membership.
   * The period they were in the group is part of what makes an earlier loan
   * legible, so it is closed, never deleted.
   */
  app.post(
    '/groups/:id/members/:clientId/departure',
    { preHandler: [authenticated, requirePermission('client.update')] },
    async (request): Promise<unknown> => {
      const body = endGroupMembershipRequestSchema.safeParse(request.body ?? {});
      if (!body.success) {
        throw validationFailed(body.error, 'That departure cannot be recorded as entered.');
      }

      return groupMemberSchema.parse(
        await endMembership(
          principalOf(request),
          idOf(request, 'id', 'group'),
          idOf(request, 'clientId', 'borrower'),
          body.data,
          groups,
          now,
        ),
      );
    },
  );

  /**
   * Which groups a borrower belongs to.
   *
   * Lives under `/clients` because that is what a caller has in hand when they
   * ask. `?asAt=` reads it as at a date, like the roster does.
   */
  app.get(
    '/clients/:id/groups',
    { preHandler: [authenticated, requirePermission('client.read')] },
    async (request): Promise<unknown> => {
      const query = groupMemberQuerySchema.safeParse(request.query);
      if (!query.success) {
        throw validationFailed(query.error, 'Those membership options are not valid.');
      }

      return memberListSchema.parse(
        await listGroupsForClient(
          principalOf(request),
          idOf(request, 'id', 'borrower'),
          query.data.asAt,
          groups,
        ),
      );
    },
  );
}
