import {
  complaintListQuerySchema,
  complaintNatureSchema,
  complaintSchema,
  logComplaintRequestSchema,
  pageSchema,
  referComplaintRequestSchema,
  resolveComplaintRequestSchema,
  uuidSchema,
} from '@mfi/contracts';
import { type FastifyInstance, type FastifyRequest } from 'fastify';
import { z } from 'zod';

import { type AccessTokenService } from '../../auth/access-token.js';
import { authenticate, principalOf, requirePermission } from '../../http/authentication.js';
import { validationFailed } from '../../http/errors.js';
import { type ComplaintRepository } from './complaint-repository.js';
import {
  getComplaint,
  listComplaintNatures,
  listComplaints,
  logComplaint,
  referComplaint,
  resolveComplaint,
} from './use-cases.js';

const complaintPageSchema = pageSchema(complaintSchema);
const natureListSchema = z.array(complaintNatureSchema);

function idOf(request: FastifyRequest): string {
  const parsed = uuidSchema.safeParse((request.params as Record<string, unknown>)['id']);
  if (!parsed.success) {
    throw validationFailed(parsed.error, 'That is not a complaint identifier.');
  }
  return parsed.data;
}

export interface ComplaintRouteOptions {
  readonly complaints: ComplaintRepository;
  readonly tokens: AccessTokenService;
  readonly now?: () => Date;
}

/**
 * Complaint routes.
 *
 * `complaint.read` and `complaint.manage`, which the seeded catalogue gives the
 * loan officer and the branch manager as well as the accountant: a complaint is
 * usually made to the person the borrower already deals with, and a system that
 * only lets head office log one gets complaints logged late or not at all.
 *
 * There is no `DELETE`. A complaint counted on a filed return cannot be made
 * not to have happened, and one logged in error is resolved with a note saying
 * so — which is also what the database allows and nothing more.
 */
export function registerComplaintRoutes(
  app: FastifyInstance,
  options: ComplaintRouteOptions,
): void {
  const { complaints, tokens } = options;
  const now = options.now ?? ((): Date => new Date());
  const authenticated = authenticate(tokens);

  /** BOT's six nature categories, so a client never embeds its own copy. */
  app.get(
    '/reference/complaint-natures',
    { preHandler: [authenticated, requirePermission('complaint.read')] },
    async (request): Promise<unknown> =>
      natureListSchema.parse(await listComplaintNatures(principalOf(request), complaints)),
  );

  app.get(
    '/complaints',
    { preHandler: [authenticated, requirePermission('complaint.read')] },
    async (request): Promise<unknown> => {
      const filters = complaintListQuerySchema.safeParse(request.query);
      if (!filters.success) {
        throw validationFailed(filters.error, 'Those complaint filters are not valid.');
      }

      return complaintPageSchema.parse(
        await listComplaints(principalOf(request), filters.data, complaints),
      );
    },
  );

  app.get(
    '/complaints/:id',
    { preHandler: [authenticated, requirePermission('complaint.read')] },
    async (request): Promise<unknown> =>
      complaintSchema.parse(await getComplaint(principalOf(request), idOf(request), complaints)),
  );

  app.post(
    '/complaints',
    { preHandler: [authenticated, requirePermission('complaint.manage')] },
    async (request, reply): Promise<unknown> => {
      const body = logComplaintRequestSchema.safeParse(request.body);
      if (!body.success) {
        throw validationFailed(body.error, 'That complaint cannot be logged as entered.');
      }

      const complaint = await logComplaint(principalOf(request), body.data, complaints, now);

      void reply.status(201).header('location', `/complaints/${complaint.id}`);
      return complaintSchema.parse(complaint);
    },
  );

  /** Closing a complaint, by one of the two routes MSP2-06 accounts for. */
  app.post(
    '/complaints/:id/resolution',
    { preHandler: [authenticated, requirePermission('complaint.manage')] },
    async (request): Promise<unknown> => {
      const body = resolveComplaintRequestSchema.safeParse(request.body);
      if (!body.success) {
        throw validationFailed(body.error, 'That resolution cannot be recorded as entered.');
      }

      return complaintSchema.parse(
        await resolveComplaint(principalOf(request), idOf(request), body.data, complaints, now),
      );
    },
  );

  /** Taking an unresolved complaint elsewhere, and when. */
  app.post(
    '/complaints/:id/referral',
    { preHandler: [authenticated, requirePermission('complaint.manage')] },
    async (request): Promise<unknown> => {
      const body = referComplaintRequestSchema.safeParse(request.body);
      if (!body.success) {
        throw validationFailed(body.error, 'That referral cannot be recorded as entered.');
      }

      return complaintSchema.parse(
        await referComplaint(principalOf(request), idOf(request), body.data, complaints, now),
      );
    },
  );
}
