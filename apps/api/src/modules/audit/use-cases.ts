import {
  type AuditEntry,
  type AuditEntryDetail,
  type AuditListQuery,
  type AuditedTable,
} from '@mfi/contracts';
import { type Principal } from '@mfi/identity';

import { type PagedRows } from '../../http/cursor.js';
import { notFound, ruleViolation } from '../../http/errors.js';
import { type AuditRepository } from './audit-repository.js';

/**
 * Reading the change history.
 *
 * Read-only by construction: there is no use case here that writes, because
 * there is no write path to the trail from the application at all. What these
 * functions add over the repository is the one refusal the repository cannot
 * make for itself.
 *
 * No branch filter appears anywhere below, and its absence is deliberate.
 * `audit.read` is held by `institution_admin` and `auditor`, and the policy on
 * `audit_logs` scopes the table to the institution rather than to a branch —
 * so the trail an auditor sees is the whole institution's, which is what
 * auditing an institution means. Filtering it by branch would also be
 * guesswork: an audit row records a table, an identifier and two payloads, and
 * has no branch of its own to filter on.
 */

export async function listAuditEntries(
  principal: Principal,
  query: AuditListQuery,
  audit: AuditRepository,
): Promise<PagedRows<AuditEntry>> {
  if (query.tableName !== undefined) {
    await assertAudited(principal, query.tableName, audit);
  }

  return audit.list(principal.institutionId, principal.userId, {
    limit: query.limit,
    cursor: query.cursor,
    tableName: query.tableName,
    rowId: query.rowId,
    actorUserId: query.actorUserId,
    operation: query.operation,
  });
}

export async function getAuditEntry(
  principal: Principal,
  entryId: string,
  audit: AuditRepository,
): Promise<AuditEntryDetail> {
  const found = await audit.find(principal.institutionId, principal.userId, entryId);

  if (found === null) {
    throw notFound('No such audit entry.');
  }

  return found;
}

export async function listAuditedTables(
  principal: Principal,
  audit: AuditRepository,
): Promise<AuditedTable[]> {
  const names = await audit.auditedTables(principal.institutionId, principal.userId);
  return names.map((name) => ({ name }));
}

/**
 * Refuse a filter naming a table the trail does not cover.
 *
 * Without this, `?tableName=loan` — a plausible mistake, since the table is
 * `loans` — returns an empty page, and an empty page from an audit log reads as
 * "nothing was ever done to loans". A tool whose purpose is to answer questions
 * about what happened must not answer a question it did not understand.
 *
 * The check costs one catalogue query, and only on a request that filters by
 * table. It is not cached: the set changes when a migration runs, and a cache
 * keyed on nothing would keep serving the previous schema's answer.
 */
async function assertAudited(
  principal: Principal,
  tableName: string,
  audit: AuditRepository,
): Promise<void> {
  const audited = await audit.auditedTables(principal.institutionId, principal.userId);

  if (!audited.includes(tableName)) {
    throw ruleViolation(`No audit trail is kept for a table named "${tableName}".`);
  }
}
