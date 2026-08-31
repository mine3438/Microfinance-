import { type ApprovalThreshold, type RoleCode } from '@mfi/contracts';
import { type Database } from '@mfi/db';

/**
 * Institution settings.
 *
 * `approval_thresholds` was seeded empty and read by the approval check, and
 * until now written by nothing at all — so an institution could be asked for
 * its lending limits and have nowhere to record them. This is that somewhere.
 *
 * Every role is listed, whether or not it has a limit, because the screen that
 * reads this has to show "no authority" as a state rather than as a missing
 * row. The absence of a limit means a role may sanction nothing.
 */

interface ThresholdRow {
  role_code: RoleCode;
  role_name: string;
  max_principal: string | null;
  updated_at: Date | null;
}

const THRESHOLDS_SELECT = `SELECT r.code AS role_code, r.name AS role_name,
              t.max_principal, t.updated_at
         FROM reference.roles r
         LEFT JOIN approval_thresholds t
                ON t.role_code = r.code AND t.institution_id = current_institution_id()
        ORDER BY r.sort_order`;

export interface SettingsRepository {
  approvalThresholds(institutionId: string, userId: string): Promise<ApprovalThreshold[]>;
  setApprovalThreshold(
    institutionId: string,
    userId: string,
    roleCode: RoleCode,
    maxPrincipal: string | null,
  ): Promise<ApprovalThreshold[]>;
}

export class PostgresSettingsRepository implements SettingsRepository {
  public constructor(private readonly database: Database) {}

  public async approvalThresholds(
    institutionId: string,
    userId: string,
  ): Promise<ApprovalThreshold[]> {
    return this.database.withTenantTransaction({ institutionId, userId }, async (client) => {
      const rows = await client.query<ThresholdRow>(THRESHOLDS_SELECT);
      return rows.rows.map(toThreshold);
    });
  }

  public async setApprovalThreshold(
    institutionId: string,
    userId: string,
    roleCode: RoleCode,
    maxPrincipal: string | null,
  ): Promise<ApprovalThreshold[]> {
    return this.database.withTenantTransaction({ institutionId, userId }, async (client) => {
      if (maxPrincipal === null) {
        // Removing the row removes the authority. That is the same statement,
        // not two: the approval check reads a missing row as "may sanction
        // nothing", which is why it was seeded empty in the first place.
        await client.query(
          'DELETE FROM approval_thresholds WHERE institution_id = $1 AND role_code = $2',
          [institutionId, roleCode],
        );
      } else {
        await client.query(
          `INSERT INTO approval_thresholds (institution_id, role_code, max_principal)
           VALUES ($1, $2, $3)
           ON CONFLICT (institution_id, role_code)
           DO UPDATE SET max_principal = EXCLUDED.max_principal`,
          [institutionId, roleCode, maxPrincipal],
        );
      }

      const rows = await client.query<ThresholdRow>(THRESHOLDS_SELECT);
      return rows.rows.map(toThreshold);
    });
  }
}

function toThreshold(row: ThresholdRow): ApprovalThreshold {
  return {
    roleCode: row.role_code,
    roleName: row.role_name,
    maxPrincipal: row.max_principal,
    updatedAt: row.updated_at === null ? null : row.updated_at.toISOString(),
  };
}
