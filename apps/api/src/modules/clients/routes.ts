import {
  branchSchema,
  clientListQuerySchema,
  clientSchema,
  createClientRequestSchema,
  pageSchema,
  updateClientRequestSchema,
  uuidSchema,
} from '@mfi/contracts';
import { type FastifyInstance, type FastifyRequest } from 'fastify';
import { z } from 'zod';

import { type AccessTokenService } from '../../auth/access-token.js';
import { authenticate, principalOf, requirePermission } from '../../http/authentication.js';
import { validationFailed } from '../../http/errors.js';
import { type ClientRepository } from './client-repository.js';
import { createClient, getClient, listClients, updateClient } from './use-cases.js';

const clientPageSchema = pageSchema(clientSchema);
const branchListSchema = z.array(branchSchema);
const clientIdSchema = uuidSchema;

export interface ClientRouteOptions {
  readonly clients: ClientRepository;
  readonly tokens: AccessTokenService;
}

/** Validate the path parameter before it reaches a query. */
function clientIdOf(request: FastifyRequest): string {
  const parsed = clientIdSchema.safeParse((request.params as { id?: unknown }).id);
  if (!parsed.success) {
    throw validationFailed(parsed.error, 'That is not a client identifier.');
  }
  return parsed.data;
}

/**
 * Client routes.
 *
 * Each carries two guards, in order: `authenticate` establishes who the caller
 * is, `requirePermission` decides whether they may. Keeping them separate means
 * a route cannot accidentally check authorisation against an absent principal —
 * `principalOf` throws rather than returning undefined if the first guard was
 * omitted.
 *
 * Handlers do three things and no more: validate, call a use case, shape the
 * response. Every rule — branch authority, phone normalisation, what may be
 * edited — lives in the use case or the domain, because the HTTP layer is not
 * the only way in and a rule enforced only here is not enforced.
 */
export function registerClientRoutes(app: FastifyInstance, options: ClientRouteOptions): void {
  const { clients, tokens } = options;
  const authenticated = authenticate(tokens);

  /**
   * The institution's branches.
   *
   * `branch.read`, and served rather than left to the session: a user with
   * institution-wide authority has `branch` null on their session, so a screen
   * reading only the session would leave exactly those users unable to file a
   * client or a complaint against any branch at all.
   */
  app.get(
    '/branches',
    { preHandler: [authenticated, requirePermission('branch.read')] },
    async (request): Promise<unknown> => {
      const principal = principalOf(request);
      return branchListSchema.parse(
        await clients.listBranches(principal.institutionId, principal.userId),
      );
    },
  );

  app.get(
    '/clients',
    { preHandler: [authenticated, requirePermission('client.read')] },
    async (request): Promise<unknown> => {
      const query = clientListQuerySchema.safeParse(request.query);
      if (!query.success) {
        throw validationFailed(query.error, 'Those list options are not valid.');
      }

      const page = await listClients(principalOf(request), query.data, clients);
      return clientPageSchema.parse(page);
    },
  );

  app.get(
    '/clients/:id',
    { preHandler: [authenticated, requirePermission('client.read')] },
    async (request): Promise<unknown> => {
      const found = await getClient(principalOf(request), clientIdOf(request), clients);
      return clientSchema.parse(found);
    },
  );

  app.post(
    '/clients',
    { preHandler: [authenticated, requirePermission('client.create')] },
    async (request, reply): Promise<unknown> => {
      const body = createClientRequestSchema.safeParse(request.body);
      if (!body.success) {
        throw validationFailed(body.error, 'That client cannot be registered as entered.');
      }

      const created = await createClient(principalOf(request), body.data, clients);

      void reply.status(201).header('location', `/clients/${created.id}`);
      return clientSchema.parse(created);
    },
  );

  app.patch(
    '/clients/:id',
    { preHandler: [authenticated, requirePermission('client.update')] },
    async (request): Promise<unknown> => {
      const body = updateClientRequestSchema.safeParse(request.body);
      if (!body.success) {
        throw validationFailed(body.error, 'That change cannot be applied as entered.');
      }

      const updated = await updateClient(
        principalOf(request),
        clientIdOf(request),
        body.data,
        clients,
      );
      return clientSchema.parse(updated);
    },
  );
}
