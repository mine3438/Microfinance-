import {
  branchSchema,
  clientListQuerySchema,
  createBranchRequestSchema,
  districtSchema,
  sectorSchema,
  updateBranchRequestSchema,
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
import { notFound, validationFailed } from '../../http/errors.js';
import { type ClientRepository } from './client-repository.js';
import { createClient, getClient, listClients, updateClient } from './use-cases.js';

const clientPageSchema = pageSchema(clientSchema);
const branchListSchema = z.array(branchSchema);
const districtListSchema = z.array(districtSchema);
const sectorListSchema = z.array(sectorSchema);
const clientIdSchema = uuidSchema;

function branchIdOf(request: FastifyRequest): string {
  const parsed = uuidSchema.safeParse((request.params as { id?: unknown }).id);
  if (!parsed.success) {
    throw validationFailed(parsed.error, 'That is not a branch identifier.');
  }
  return parsed.data;
}

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
  /**
   * BOT's district and sector taxonomies.
   *
   * `client.read`, matching the finance module's precedent of guarding
   * reference data with the permission of the feature that consumes it. Client
   * registration is the main consumer; an administrator opening a branch holds
   * it too.
   *
   * These existed as tables from migration 0004 and had no endpoint, which is
   * why the client form asked for a district *code* as free text. The server
   * refuses an unknown one, but a near-miss that happens to be another real
   * district is not refused at all — it silently moves a borrower between two
   * MSP2-10 totals.
   */
  app.get(
    '/reference/districts',
    { preHandler: [authenticated, requirePermission('client.read')] },
    async (): Promise<unknown> => districtListSchema.parse(await clients.listDistricts()),
  );

  app.get(
    '/reference/sectors',
    { preHandler: [authenticated, requirePermission('client.read')] },
    async (): Promise<unknown> => sectorListSchema.parse(await clients.listSectors()),
  );

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

  /**
   * Open a branch.
   *
   * `branch.manage`, which until now no route used. Nothing in the application
   * could create or amend a branch at all: they existed only where a seed
   * script had put them, so an institution opening one had no way to record it
   * — and the reporting readiness gate's refusal over branches with no BOT
   * district could only be answered with SQL.
   */
  app.post(
    '/branches',
    { preHandler: [authenticated, requirePermission('branch.manage')] },
    async (request, reply): Promise<unknown> => {
      const body = createBranchRequestSchema.safeParse(request.body);
      if (!body.success) {
        throw validationFailed(body.error, 'That branch cannot be opened as entered.');
      }

      const principal = principalOf(request);
      const branch = await clients.createBranch(
        principal.institutionId,
        principal.userId,
        body.data,
      );

      void reply.status(201).header('location', `/branches/${branch.id}`);
      return branchSchema.parse(branch);
    },
  );

  app.patch(
    '/branches/:id',
    { preHandler: [authenticated, requirePermission('branch.manage')] },
    async (request): Promise<unknown> => {
      const body = updateBranchRequestSchema.safeParse(request.body);
      if (!body.success) {
        throw validationFailed(body.error, 'That branch cannot be changed as entered.');
      }

      const principal = principalOf(request);
      const updated = await clients.updateBranch(
        principal.institutionId,
        principal.userId,
        branchIdOf(request),
        body.data,
      );
      if (updated === null) {
        throw notFound('That branch does not exist.');
      }

      return branchSchema.parse(updated);
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
