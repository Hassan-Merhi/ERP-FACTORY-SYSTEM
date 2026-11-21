// Extracted from ./spMigrationPhase4Users.ts
import { sql } from "drizzle-orm";
import { db } from "../../db";
import { pn } from "./spMigrationPhase2Common";
import { resolveTargetLedgerAccount, resolveTargetLocation } from "./spMigrationCutoverReadiness";
import { resultRows, firstRow } from "../../lib/queryResult";
import { toFiniteNumber } from "@shared/typeGuards";

/**
 * A user_company_roles snapshot, as this migration writes it into the session
 * and into the target company's role row.
 *
 * Raw rows arrive from `tx.execute`, so each field is coerced here rather than
 * asserted: the snake_case/camelCase fallbacks exist because the same shape is
 * read back from both a raw query and a Drizzle select.
 */
export interface RoleSnapshot {
  role: string;
  assignedLocationId: number | null;
  cashAccountId: number | null;
  posStation: number | null;
  canSellNegativeStock: boolean;
  posViewOnly: boolean;
  daybookEditDays: number;
  canAccessCustomers: boolean;
  canDeleteRecords: boolean;
}

export async function switchUserSessions(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  params: {
    userId: string;
    fromCompanyId: number;
    toCompanyId: number;
    role: RoleSnapshot;
    companyName: string;
  }
): Promise<number> {
  const result = await tx.execute(sql`
    UPDATE session
    SET sess = (
      sess::jsonb || jsonb_build_object(
        'currentCompanyId', ${params.toCompanyId},
        'currentRole', ${params.role.role},
        'currentLocationId', ${params.role.assignedLocationId ?? null},
        'currentPOSStation', ${params.role.posStation ?? null},
        'cashAccountId', ${params.role.cashAccountId ?? null},
        'canSellNegativeStock', ${Boolean(params.role.canSellNegativeStock)},
        'posViewOnly', ${Boolean(params.role.posViewOnly)},
        'daybookEditDays', ${pn(params.role.daybookEditDays)},
        'canAccessCustomers', ${Boolean(params.role.canAccessCustomers)},
        'canDeleteRecords', ${Boolean(params.role.canDeleteRecords)},
        'currentCompanyName', ${params.companyName}
      )
    )::json
    WHERE sess->>'userId' = ${params.userId}
      AND CASE
            WHEN (sess->>'currentCompanyId') ~ '^[0-9]+$'
            THEN (sess->>'currentCompanyId')::int
            ELSE NULL
          END = ${params.fromCompanyId}
    RETURNING sid
  `);
  return resultRows(result).length;
}

export async function loadCashMappings(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  userId: string,
  companyId: number
) {
  const result = await tx.execute(sql`
    SELECT location_id, cash_account_id, pos_station
    FROM user_location_cash_accounts
    WHERE user_id = ${userId} AND company_id = ${companyId}
    ORDER BY location_id ASC
  `);
  return resultRows(result).map((row) => ({
    locationId: pn(row.location_id),
    cashAccountId: pn(row.cash_account_id),
    posStation: row.pos_station ?? null,
  }));
}

export async function mapRole(
  sourceId: number,
  targetId: number,
  sourceRole: Record<string, unknown>
): Promise<RoleSnapshot> {
  const location = sourceRole.assigned_location_id
    ? await resolveTargetLocation(sourceId, targetId, pn(sourceRole.assigned_location_id))
    : null;
  const cashAccountId = sourceRole.cash_account_id
    ? await resolveTargetLedgerAccount(pn(sourceRole.cash_account_id), targetId)
    : null;
  if (sourceRole.role === "POS" && (!location || !cashAccountId)) {
    throw new Error(`POS user ${sourceRole.user_id} has no safe target location/cash-account mapping.`);
  }
  return {
    role: String(sourceRole.role ?? ""),
    assignedLocationId: location?.targetLocationId ?? null,
    cashAccountId,
    posStation: toFiniteNumber(sourceRole.pos_station) ?? null,
    canSellNegativeStock: Boolean(sourceRole.can_sell_negative_stock),
    posViewOnly: Boolean(sourceRole.pos_view_only),
    daybookEditDays: pn(sourceRole.daybook_edit_days),
    canAccessCustomers: Boolean(sourceRole.can_access_customers),
    canDeleteRecords: Boolean(sourceRole.can_delete_records),
  };
}

export async function mapAllLocations(sourceId: number, targetId: number, rows: Record<string, unknown>[]) {
  const mapped = [];
  for (const row of rows) {
    const location = await resolveTargetLocation(sourceId, targetId, pn(row.locationId));
    if (!location) throw new Error(`Location ${row.locationId} has no safe target mapping.`);
    mapped.push({ locationId: location.targetLocationId });
  }
  return mapped;
}

export async function mapAllCashMappings(sourceId: number, targetId: number, rows: Record<string, unknown>[]) {
  const mapped = [];
  for (const row of rows) {
    const location = await resolveTargetLocation(sourceId, targetId, pn(row.locationId));
    const cashAccountId = await resolveTargetLedgerAccount(pn(row.cashAccountId), targetId);
    if (!location || !cashAccountId) {
      throw new Error(
        `Cash mapping location ${row.locationId}, account ${row.cashAccountId} has no safe target mapping.`
      );
    }
    mapped.push({
      locationId: location.targetLocationId,
      cashAccountId,
      posStation: row.posStation ?? null,
    });
  }
  return mapped;
}

export async function replaceCashMappings(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  userId: string,
  companyId: number,
  rows: Record<string, unknown>[]
): Promise<void> {
  await tx.execute(
    sql`DELETE FROM user_location_cash_accounts WHERE user_id = ${userId} AND company_id = ${companyId}`
  );
  for (const row of rows) {
    await tx.execute(sql`
      INSERT INTO user_location_cash_accounts (user_id, company_id, location_id, cash_account_id, pos_station)
      VALUES (${userId}, ${companyId}, ${pn(row.locationId)}, ${pn(row.cashAccountId)}, ${row.posStation ?? null})
    `);
  }
}

export async function upsertRole(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  userId: string,
  companyId: number,
  role: RoleSnapshot
): Promise<{ id: number; created: boolean }> {
  const existing = await tx.execute(sql`
    SELECT id FROM user_company_roles
    WHERE user_id = ${userId} AND company_id = ${companyId}
    LIMIT 1
  `);
  const existingId = pn(firstRow(existing)?.id);
  if (existingId) {
    await tx.execute(sql`
      UPDATE user_company_roles
      SET role = ${role.role},
          assigned_location_id = ${role.assignedLocationId ?? null},
          cash_account_id = ${role.cashAccountId ?? null},
          pos_station = ${role.posStation ?? null},
          can_sell_negative_stock = ${Boolean(role.canSellNegativeStock)},
          pos_view_only = ${Boolean(role.posViewOnly)},
          daybook_edit_days = ${pn(role.daybookEditDays)},
          can_access_customers = ${Boolean(role.canAccessCustomers)},
          can_delete_records = ${Boolean(role.canDeleteRecords)}
      WHERE id = ${existingId} AND company_id = ${companyId}
    `);
    return { id: existingId, created: false };
  }
  const inserted = await tx.execute(sql`
    INSERT INTO user_company_roles
      (user_id, company_id, role, assigned_location_id, cash_account_id, pos_station,
       can_sell_negative_stock, pos_view_only, daybook_edit_days,
       can_access_customers, can_delete_records)
    VALUES
      (${userId}, ${companyId}, ${role.role}, ${role.assignedLocationId ?? null}, ${role.cashAccountId ?? null},
       ${role.posStation ?? null}, ${Boolean(role.canSellNegativeStock)}, ${Boolean(role.posViewOnly)},
       ${pn(role.daybookEditDays)}, ${Boolean(role.canAccessCustomers)}, ${Boolean(role.canDeleteRecords)})
    RETURNING id
  `);
  return { id: pn(resultRows(inserted)[0].id), created: true };
}
