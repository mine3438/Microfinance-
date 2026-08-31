import {
  type Client,
  type ClientListQuery,
  type CreateClientRequest,
  type UpdateClientRequest,
} from '@mfi/contracts';
import { PhoneNumber } from '@mfi/domain';
import { canActOnBranch, type Principal } from '@mfi/identity';

import { type PagedRows } from '../../http/cursor.js';
import { ApiError, forbidden, notFound } from '../../http/errors.js';
import { type ClientRepository } from './client-repository.js';

/**
 * Branch authority, applied to every read and write in this module.
 *
 * Row-level security scopes to the institution and stops there. Branch is a
 * narrower boundary that the database does not enforce, so it is enforced here
 * — once, in the use cases, rather than in each route.
 *
 * A principal with no branch has institution-wide authority: an administrator,
 * an accountant, an auditor. A principal assigned to one is confined to it.
 */

/**
 * Which branch a list should be restricted to.
 *
 * A branch-scoped user's own branch always wins. If they ask for a different
 * one the request is refused rather than quietly narrowed — silently returning
 * their own branch's clients under a filter naming another branch would be a
 * wrong answer presented as a right one.
 */
function resolveBranchFilter(
  principal: Principal,
  requested: string | undefined,
): string | undefined {
  if (principal.branchId === null) {
    return requested;
  }

  if (requested !== undefined && requested !== principal.branchId) {
    throw forbidden('You can only see clients belonging to your own branch.');
  }

  return principal.branchId;
}

export async function listClients(
  principal: Principal,
  query: ClientListQuery,
  clients: ClientRepository,
): Promise<PagedRows<Client>> {
  return clients.list(principal.institutionId, principal.userId, {
    limit: query.limit,
    cursor: query.cursor,
    status: query.status,
    branchId: resolveBranchFilter(principal, query.branchId),
    search: query.search,
  });
}

export async function getClient(
  principal: Principal,
  clientId: string,
  clients: ClientRepository,
): Promise<Client> {
  const found = await clients.find(principal.institutionId, principal.userId, clientId);

  // The same answer for "does not exist" and "belongs to another branch". A
  // distinct 403 would confirm that a client with this identifier exists in the
  // institution, which is exactly what a branch boundary is meant to withhold.
  if (found === null || !canActOnBranch(principal, found.branchId)) {
    throw notFound('No such client.');
  }

  return found;
}

export async function createClient(
  principal: Principal,
  request: CreateClientRequest,
  clients: ClientRepository,
): Promise<Client> {
  const branchId = request.branchId ?? principal.branchId;

  if (branchId === null) {
    throw new ApiError('validation_failed', 'Name the branch this client belongs to.', [
      {
        path: ['branchId'],
        message:
          'Your account has authority across the whole institution, so the branch cannot be ' +
          'inferred and must be stated.',
      },
    ]);
  }

  if (!canActOnBranch(principal, branchId)) {
    throw forbidden('You can only register clients in your own branch.');
  }

  if (!(await clients.branchExists(principal.institutionId, principal.userId, branchId))) {
    // Reported as a validation failure rather than a 404: the request named a
    // branch that is not one of this institution's, which is a bad field value
    // rather than a missing resource.
    throw new ApiError('validation_failed', 'That branch does not exist.', [
      { path: ['branchId'], message: 'No branch in your institution has this identifier.' },
    ]);
  }

  const unknownCodes = await clients.unknownReferenceCodes({
    districtCode: request.districtCode,
    sectorCode: request.sectorCode,
  });
  if (unknownCodes.length > 0) {
    // Checked before the insert so the refusal can name the field. The foreign
    // key would catch it regardless, but its error names a constraint rather
    // than an input — and MSP2-10 aggregates across this exact hierarchy, so a
    // code that does not exist is a borrower missing from a BOT return.
    throw new ApiError(
      'validation_failed',
      'That district or sector is not one the Bank of Tanzania recognises.',
      unknownCodes.map((field) => ({
        path: [field],
        message: 'Choose a value from the published list.',
      })),
    );
  }

  // Normalised here, before storage, by the single implementation in the
  // domain. `0712345678` and `+255712345678` become one value, so the same
  // borrower cannot be registered twice under two spellings of one number.
  const phone = PhoneNumber.parse(request.phone);

  return clients.create(principal.institutionId, principal.userId, {
    branchId,
    fullName: request.fullName,
    gender: request.gender,
    dateOfBirth: request.dateOfBirth,
    phone: phone.toDatabaseValue(),
    districtCode: request.districtCode,
    sectorCode: request.sectorCode,
  });
}

export async function updateClient(
  principal: Principal,
  clientId: string,
  request: UpdateClientRequest,
  clients: ClientRepository,
): Promise<Client> {
  // Read first, so the branch check runs against the client's actual branch
  // rather than against anything the request asserts.
  const existing = await getClient(principal, clientId, clients);

  if (request.districtCode !== undefined || request.sectorCode !== undefined) {
    const unknownCodes = await clients.unknownReferenceCodes({
      districtCode: request.districtCode ?? existing.districtCode,
      sectorCode: request.sectorCode ?? existing.sectorCode,
    });
    if (unknownCodes.length > 0) {
      throw new ApiError(
        'validation_failed',
        'That district or sector is not one the Bank of Tanzania recognises.',
        unknownCodes.map((field) => ({
          path: [field],
          message: 'Choose a value from the published list.',
        })),
      );
    }
  }

  const updated = await clients.update(principal.institutionId, principal.userId, existing.id, {
    fullName: request.fullName,
    phone:
      request.phone === undefined ? undefined : PhoneNumber.parse(request.phone).toDatabaseValue(),
    districtCode: request.districtCode,
    sectorCode: request.sectorCode,
    status: request.status,
  });

  if (updated === null) {
    throw notFound('No such client.');
  }

  return updated;
}
