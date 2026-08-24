import { type LoanRecovery, type LoanWriteOff } from '@mfi/contracts';
import { type Database } from '@mfi/db';

/**
 * Writing a loan off, and recovering against one that has been written off.
 *
 * Its own repository rather than more methods on `LoanRepository`, because
 * neither operation is part of the lending lifecycle the loan repository
 * models. A write-off ends that lifecycle by decision rather than by repayment,
 * and a recovery happens entirely outside it — the loan is closed, its balance
 * is zero, and money arrives anyway.
 *
 * Both writes are one transaction each. A write-off that zeroed the balance but
 * failed to record what it wrote off would destroy the only copy of the figure;
 * the schema's `loan_write_offs_one_per_loan` and the status transition make the
 * pair all-or-nothing, and the transaction makes it atomic.
 */

/** What a loan owes at the moment somebody proposes writing it off. */
export interface WriteOffSubject {
  readonly loanId: string;
  readonly branchId: string;
  readonly status: string;
  readonly outstandingBalance: string;
  readonly penaltyBalance: string;
  /** Set once the loan has been written off, so a second attempt can be refused. */
  readonly alreadyWrittenOffAt: Date | null;
}

export interface RecoveryToRecord {
  readonly loanId: string;
  readonly amount: string;
  readonly recoveredOn: string;
  readonly method: string | null;
  readonly reference: string | null;
  readonly notes: string | null;
}

interface WriteOffRow {
  id: string;
  loan_id: string;
  loan_code: string | null;
  client_name: string;
  principal_written_off: string;
  penalty_written_off: string;
  total_written_off: string;
  reason: string;
  approved_by: string;
  approved_by_name: string | null;
  written_off_at: Date;
}

interface RecoveryRow {
  id: string;
  loan_id: string;
  loan_code: string | null;
  client_name: string;
  amount: string;
  recovered_on: Date;
  method: string | null;
  reference: string | null;
  notes: string | null;
  recorded_by: string;
  recorded_by_name: string | null;
  created_at: Date;
}

const WRITE_OFF_PROJECTION = `
  SELECT w.id, w.loan_id, l.loan_code, c.full_name AS client_name,
         w.principal_written_off, w.penalty_written_off, w.total_written_off,
         w.reason, w.approved_by, u.full_name AS approved_by_name, w.written_off_at
    FROM loan_write_offs w
    JOIN loans l   ON l.id = w.loan_id
    JOIN clients c ON c.id = l.client_id
    LEFT JOIN users u ON u.id = w.approved_by`;

const RECOVERY_PROJECTION = `
  SELECT r.id, r.loan_id, l.loan_code, c.full_name AS client_name,
         r.amount, r.recovered_on, r.method, r.reference, r.notes,
         r.recorded_by, u.full_name AS recorded_by_name, r.created_at
    FROM loan_recoveries r
    JOIN loans l   ON l.id = r.loan_id
    JOIN clients c ON c.id = l.client_id
    LEFT JOIN users u ON u.id = r.recorded_by`;

function formatDateOnly(value: Date): string {
  const year = String(value.getFullYear()).padStart(4, '0');
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function toWriteOff(row: WriteOffRow): LoanWriteOff {
  return {
    id: row.id,
    loanId: row.loan_id,
    loanCode: row.loan_code,
    clientName: row.client_name,
    principalWrittenOff: row.principal_written_off,
    penaltyWrittenOff: row.penalty_written_off,
    totalWrittenOff: row.total_written_off,
    reason: row.reason,
    approvedBy: row.approved_by,
    approvedByName: row.approved_by_name,
    writtenOffAt: row.written_off_at.toISOString(),
  };
}

function toRecovery(row: RecoveryRow): LoanRecovery {
  return {
    id: row.id,
    loanId: row.loan_id,
    loanCode: row.loan_code,
    clientName: row.client_name,
    amount: row.amount,
    recoveredOn: formatDateOnly(row.recovered_on),
    method: row.method,
    reference: row.reference,
    notes: row.notes,
    recordedBy: row.recorded_by,
    recordedByName: row.recorded_by_name,
    createdAt: row.created_at.toISOString(),
  };
}

export interface WriteOffRepository {
  /** What the loan owes, and whether it has already been written off. */
  subject(institutionId: string, userId: string, loanId: string): Promise<WriteOffSubject | null>;
  /** Zero the balance, close the loan, and record what was written off. One transaction. */
  writeOff(
    institutionId: string,
    userId: string,
    loanId: string,
    reason: string,
  ): Promise<LoanWriteOff | null>;
  findWriteOff(institutionId: string, userId: string, loanId: string): Promise<LoanWriteOff | null>;
  recordRecovery(
    institutionId: string,
    userId: string,
    recovery: RecoveryToRecord,
  ): Promise<LoanRecovery>;
  listRecoveries(institutionId: string, userId: string, loanId: string): Promise<LoanRecovery[]>;
}

export class PostgresWriteOffRepository implements WriteOffRepository {
  public constructor(private readonly database: Database) {}

  public async subject(
    institutionId: string,
    userId: string,
    loanId: string,
  ): Promise<WriteOffSubject | null> {
    return this.database.withTenantTransaction({ institutionId, userId }, async (client) => {
      const rows = await client.query<{
        id: string;
        branch_id: string;
        status: string;
        outstanding_balance: string | null;
        penalty_balance: string;
        written_off_at: Date | null;
      }>(
        `SELECT l.id, l.branch_id, l.status, l.outstanding_balance, l.penalty_balance,
                w.written_off_at
           FROM loans l
           LEFT JOIN loan_write_offs w ON w.loan_id = l.id
          WHERE l.id = $1`,
        [loanId],
      );

      const row = rows.rows[0];
      return row === undefined
        ? null
        : {
            loanId: row.id,
            branchId: row.branch_id,
            status: row.status,
            // NULL before disbursement. Reported as zero rather than null so the
            // caller reasons about one shape; a loan that has not been disbursed
            // is refused before the figure is used for anything.
            outstandingBalance: row.outstanding_balance ?? '0.00',
            penaltyBalance: row.penalty_balance,
            alreadyWrittenOffAt: row.written_off_at,
          };
    });
  }

  /**
   * Write the loan off.
   *
   * The record is inserted from the loan's own columns in the same statement
   * sequence that zeroes them, so the figure written off is the figure that was
   * owed — not one recomputed afterwards from a balance that is now zero.
   *
   * Order matters: capture first, then zero. The reverse would record zero.
   */
  public async writeOff(
    institutionId: string,
    userId: string,
    loanId: string,
    reason: string,
  ): Promise<LoanWriteOff | null> {
    return this.database.withTenantTransaction({ institutionId, userId }, async (client) => {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO loan_write_offs
           (institution_id, loan_id, principal_written_off, penalty_written_off,
            total_written_off, reason, approved_by)
         SELECT $1, l.id, COALESCE(l.outstanding_balance, 0), l.penalty_balance,
                COALESCE(l.outstanding_balance, 0) + l.penalty_balance, $3, $4
           FROM loans l
          WHERE l.id = $2 AND l.status = 'active'
         RETURNING id`,
        [institutionId, loanId, reason, userId],
      );

      if (inserted.rows[0] === undefined) {
        return null;
      }

      // Zeroing the penalty balance stops accrual: `accrue_penalties` charges an
      // increment against a live balance, and there is no longer one. The status
      // transition to `written_off` is what stops repayment — the payment use
      // case refuses any status that is not active or completed.
      await client.query(
        `UPDATE loans
            SET outstanding_balance = 0, penalty_balance = 0, status = 'written_off'
          WHERE id = $1`,
        [loanId],
      );

      const rows = await client.query<WriteOffRow>(`${WRITE_OFF_PROJECTION} WHERE w.loan_id = $1`, [
        loanId,
      ]);
      const row = rows.rows[0];
      if (row === undefined) {
        throw new Error('The write-off was recorded but could not be read back.');
      }
      return toWriteOff(row);
    });
  }

  public async findWriteOff(
    institutionId: string,
    userId: string,
    loanId: string,
  ): Promise<LoanWriteOff | null> {
    return this.database.withTenantTransaction({ institutionId, userId }, async (client) => {
      const rows = await client.query<WriteOffRow>(`${WRITE_OFF_PROJECTION} WHERE w.loan_id = $1`, [
        loanId,
      ]);
      const row = rows.rows[0];
      return row === undefined ? null : toWriteOff(row);
    });
  }

  /**
   * Record money received against a written-off loan.
   *
   * Nothing about the loan changes. No balance moves, no schedule row is
   * touched, no status transition happens — which is the approved rule, and
   * which is why this is an INSERT and nothing else.
   *
   * The branch is taken from the loan rather than from the caller, so a
   * recovery is reported against the branch that made the advance.
   */
  public async recordRecovery(
    institutionId: string,
    userId: string,
    recovery: RecoveryToRecord,
  ): Promise<LoanRecovery> {
    return this.database.withTenantTransaction({ institutionId, userId }, async (client) => {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO loan_recoveries
           (institution_id, loan_id, branch_id, amount, recovered_on,
            method, reference, notes, recorded_by)
         SELECT $1, l.id, l.branch_id, $3, $4, $5, $6, $7, $8
           FROM loans l
          WHERE l.id = $2
         RETURNING id`,
        [
          institutionId,
          recovery.loanId,
          recovery.amount,
          recovery.recoveredOn,
          recovery.method,
          recovery.reference,
          recovery.notes,
          userId,
        ],
      );

      const id = inserted.rows[0]?.id;
      if (id === undefined) {
        throw new Error('The recovery could not be recorded against that loan.');
      }

      const rows = await client.query<RecoveryRow>(`${RECOVERY_PROJECTION} WHERE r.id = $1`, [id]);
      const row = rows.rows[0];
      if (row === undefined) {
        throw new Error('The recovery was recorded but could not be read back.');
      }
      return toRecovery(row);
    });
  }

  public async listRecoveries(
    institutionId: string,
    userId: string,
    loanId: string,
  ): Promise<LoanRecovery[]> {
    return this.database.withTenantTransaction({ institutionId, userId }, async (client) => {
      const rows = await client.query<RecoveryRow>(
        `${RECOVERY_PROJECTION} WHERE r.loan_id = $1 ORDER BY r.recovered_on, r.id`,
        [loanId],
      );
      return rows.rows.map(toRecovery);
    });
  }
}
