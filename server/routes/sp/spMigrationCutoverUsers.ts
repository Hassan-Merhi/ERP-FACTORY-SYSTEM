import { sql } from "drizzle-orm";
import { db } from "../../db";
import { ensureCutoverSchema } from "./spMigrationCutoverState";
import { pn } from "./spMigrationPhase2Common";
import { resolveTargetLedgerAccount, resolveTargetLocation } from "./spMigrationCutoverReadiness";
import { resultRows, firstRow } from "../../lib/queryResult";

/**
 * The role fields captured before a cutover and replayed on rollback. Stored as
 * JSONB in sp_migration_cutover_role_changes.source_role_snapshot, so nothing
 * about its shape is enforced by the database — this type is the contract.
 */
export type CutoverRoleSnapshot = {
  role: string | null;
  assignedLocationId: number | null;
  cashAccountId: number | null;
  posStation: string | null;
  canSellNegativeStock: boolean;
  posViewOnly: boolean;
  daybookEditDays: number;
  canAccessCustomers: boolean;
  canDeleteRecords: boolean;
};

function roleSnapshot(row: Record<string, unknown>): CutoverRoleSnapshot {
  return {
    role: row.role == null ? null : String(row.role),
    assignedLocationId: row.assigned_location_id ? pn(row.assigned_location_id) : null,
    cashAccountId: row.cash_account_id ? pn(row.cash_account_id) : null,
    posStation: row.pos_station == null ? null : String(row.pos_station),
    canSellNegativeStock: Boolean(row.can_sell_negative_stock),
    posViewOnly: Boolean(row.pos_view_only),
    daybookEditDays: pn(row.daybook_edit_days),
    canAccessCustomers: Boolean(row.can_access_customers),
    canDeleteRecords: Boolean(row.can_delete_records),
  };
}

async function switchUserSessions(params: {
  userId: string;
  fromCompanyId: number;
  toCompanyId: number;
  role: CutoverRoleSnapshot;
  companyName: string;
}): Promise<number> {
  const result = await db.execute(sql`
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
      AND NULLIF(sess->>'currentCompanyId', '')::int = ${params.fromCompanyId}
    RETURNING sid
  `);
  return resultRows(result).length;
}

async function mapSourceRole(
  sourceId: number,
  targetId: number,
  sourceRole: Record<string, unknown>
): Promise<CutoverRoleSnapshot> {
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
    // Matches roleSnapshot() above field for field, so a mapped role and a
    // snapshotted one are the same shape. `pos_station` is an integer column
    // that this file has always snapshotted as a string; Postgres coerces it
    // back on insert, and changing that would change the persisted JSON shape
    // the rollback path reads, so it is left as is.
    role: sourceRole.role == null ? null : String(sourceRole.role),
    assignedLocationId: location?.targetLocationId ?? null,
    cashAccountId,
    posStation: sourceRole.pos_station == null ? null : String(sourceRole.pos_station),
    canSellNegativeStock: Boolean(sourceRole.can_sell_negative_stock),
    posViewOnly: Boolean(sourceRole.pos_view_only),
    daybookEditDays: pn(sourceRole.daybook_edit_days),
    canAccessCustomers: Boolean(sourceRole.can_access_customers),
    canDeleteRecords: Boolean(sourceRole.can_delete_records),
  };
}

export async function moveUsersToTarget(
  cutoverId: number,
  sourceId: number,
  targetId: number,
  targetCompanyName: string
): Promise<{
  usersMoved: number;
  targetRolesCreated: number;
  targetRolesReused: number;
  sessionsSwitched: number;
  locationsCopied: number;
  cashMappingsCopied: number;
  developerRolesSkipped: number;
}> {
  await ensureCutoverSchema();
  const sourceRolesResult = await db.execute(sql`
    SELECT * FROM user_company_roles
    WHERE company_id = ${sourceId}
    ORDER BY id ASC
  `);

  let usersMoved = 0;
  let targetRolesCreated = 0;
  let targetRolesReused = 0;
  let sessionsSwitched = 0;
  let locationsCopied = 0;
  let cashMappingsCopied = 0;
  let developerRolesSkipped = 0;

  for (const sourceRole of resultRows(sourceRolesResult)) {
    if (sourceRole.role === "Developer") {
      developerRolesSkipped++;
      continue;
    }

    const mapped = await mapSourceRole(sourceId, targetId, sourceRole);
    const existingTargetResult = await db.execute(sql`
      SELECT * FROM user_company_roles
      WHERE user_id = ${sourceRole.user_id} AND company_id = ${targetId}
      LIMIT 1
    `);
    const existingTarget = firstRow(existingTargetResult) ?? null;
    let targetRoleId: number;
    let createdTargetRole = false;
    let effectiveTargetRole: CutoverRoleSnapshot;

    if (existingTarget) {
      targetRoleId = pn(existingTarget.id);
      effectiveTargetRole = roleSnapshot(existingTarget);
      targetRolesReused++;
    } else {
      const inserted = await db.execute(sql`
        INSERT INTO user_company_roles
          (user_id, company_id, role, assigned_location_id, cash_account_id, pos_station,
           can_sell_negative_stock, pos_view_only, daybook_edit_days,
           can_access_customers, can_delete_records)
        VALUES
          (${sourceRole.user_id}, ${targetId}, ${mapped.role}, ${mapped.assignedLocationId}, ${mapped.cashAccountId},
           ${mapped.posStation}, ${mapped.canSellNegativeStock}, ${mapped.posViewOnly}, ${mapped.daybookEditDays},
           ${mapped.canAccessCustomers}, ${mapped.canDeleteRecords})
        RETURNING id
      `);
      targetRoleId = pn(resultRows(inserted)[0].id);
      effectiveTargetRole = mapped;
      createdTargetRole = true;
      targetRolesCreated++;

      const sourceLocationsResult = await db.execute(sql`
        SELECT location_id FROM user_locations
        WHERE user_id = ${sourceRole.user_id} AND company_id = ${sourceId}
      `);
      for (const sourceLocation of resultRows(sourceLocationsResult)) {
        const targetLocation = await resolveTargetLocation(sourceId, targetId, pn(sourceLocation.location_id));
        if (!targetLocation) continue;
        await db.execute(sql`
          INSERT INTO user_locations (user_id, company_id, location_id)
          SELECT ${sourceRole.user_id}, ${targetId}, ${targetLocation.targetLocationId}
          WHERE NOT EXISTS (
            SELECT 1 FROM user_locations
            WHERE user_id = ${sourceRole.user_id}
              AND company_id = ${targetId}
              AND location_id = ${targetLocation.targetLocationId}
          )
        `);
        locationsCopied++;
      }

      const sourceCashMappingsResult = await db.execute(sql`
        SELECT location_id, cash_account_id, pos_station
        FROM user_location_cash_accounts
        WHERE user_id = ${sourceRole.user_id} AND company_id = ${sourceId}
      `);
      for (const sourceMapping of resultRows(sourceCashMappingsResult)) {
        const targetLocation = await resolveTargetLocation(sourceId, targetId, pn(sourceMapping.location_id));
        const targetCashAccountId = await resolveTargetLedgerAccount(pn(sourceMapping.cash_account_id), targetId);
        if (!targetLocation || !targetCashAccountId) continue;
        await db.execute(sql`
          INSERT INTO user_location_cash_accounts
            (user_id, company_id, location_id, cash_account_id, pos_station)
          VALUES
            (${sourceRole.user_id}, ${targetId}, ${targetLocation.targetLocationId},
             ${targetCashAccountId}, ${sourceMapping.pos_station ?? null})
          ON CONFLICT (user_id, company_id, location_id)
          DO NOTHING
        `);
        cashMappingsCopied++;
      }
    }

    const switched = await switchUserSessions({
      userId: String(sourceRole.user_id),
      fromCompanyId: sourceId,
      toCompanyId: targetId,
      role: effectiveTargetRole,
      companyName: targetCompanyName,
    });
    sessionsSwitched += switched;

    await db.execute(sql`
      INSERT INTO sp_migration_cutover_role_changes
        (cutover_id, user_id, source_role_id, target_role_id, created_target_role,
         source_role_snapshot, target_role_snapshot_before,
         mapped_location_id, mapped_cash_account_id, sessions_switched)
      VALUES
        (${cutoverId}, ${sourceRole.user_id}, ${pn(sourceRole.id)}, ${targetRoleId}, ${createdTargetRole},
         ${JSON.stringify(roleSnapshot(sourceRole))}::jsonb,
         ${existingTarget ? JSON.stringify(roleSnapshot(existingTarget)) : null}::jsonb,
         ${effectiveTargetRole.assignedLocationId ?? null}, ${effectiveTargetRole.cashAccountId ?? null}, ${switched})
      ON CONFLICT (cutover_id, user_id) DO NOTHING
    `);

    // Remove old-company access only after the target role and current sessions
    // are ready. Developers retain universal access for support and audit.
    await db.execute(sql`
      DELETE FROM user_location_cash_accounts
      WHERE user_id = ${sourceRole.user_id} AND company_id = ${sourceId}
    `);
    await db.execute(sql`
      DELETE FROM user_locations
      WHERE user_id = ${sourceRole.user_id} AND company_id = ${sourceId}
    `);
    await db.execute(sql`
      DELETE FROM user_company_roles
      WHERE id = ${pn(sourceRole.id)} AND company_id = ${sourceId}
    `);

    await db
      .execute(
        sql`
      UPDATE user_presence
      SET company_id = ${targetId}, company_name = ${targetCompanyName}, role = ${effectiveTargetRole.role}
      WHERE user_id = ${sourceRole.user_id} AND company_id = ${sourceId}
    `
      )
      .catch(() => undefined);
    usersMoved++;
  }

  return {
    usersMoved,
    targetRolesCreated,
    targetRolesReused,
    sessionsSwitched,
    locationsCopied,
    cashMappingsCopied,
    developerRolesSkipped,
  };
}

export async function restoreUsersToSource(
  cutoverId: number,
  sourceId: number,
  targetId: number,
  sourceCompanyName: string
): Promise<{ sourceRolesRestored: number; targetRolesRemoved: number; sessionsSwitched: number }> {
  await ensureCutoverSchema();
  const changesResult = await db.execute(sql`
    SELECT * FROM sp_migration_cutover_role_changes
    WHERE cutover_id = ${cutoverId}
    ORDER BY id DESC
  `);

  let sourceRolesRestored = 0;
  let targetRolesRemoved = 0;
  let sessionsSwitched = 0;

  for (const change of resultRows<{
    user_id: string;
    target_role_id: number | null;
    created_target_role: boolean | null;
    source_role_snapshot: CutoverRoleSnapshot | null;
  }>(changesResult)) {
    const sourceRole: CutoverRoleSnapshot = change.source_role_snapshot ?? {
      role: null,
      assignedLocationId: null,
      cashAccountId: null,
      posStation: null,
      canSellNegativeStock: false,
      posViewOnly: false,
      daybookEditDays: 0,
      canAccessCustomers: false,
      canDeleteRecords: false,
    };
    const existingSourceResult = await db.execute(sql`
      SELECT id FROM user_company_roles
      WHERE user_id = ${change.user_id} AND company_id = ${sourceId}
      LIMIT 1
    `);
    if (!firstRow(existingSourceResult)) {
      await db.execute(sql`
        INSERT INTO user_company_roles
          (user_id, company_id, role, assigned_location_id, cash_account_id, pos_station,
           can_sell_negative_stock, pos_view_only, daybook_edit_days,
           can_access_customers, can_delete_records)
        VALUES
          (${change.user_id}, ${sourceId}, ${sourceRole.role}, ${sourceRole.assignedLocationId ?? null},
           ${sourceRole.cashAccountId ?? null}, ${sourceRole.posStation ?? null},
           ${Boolean(sourceRole.canSellNegativeStock)}, ${Boolean(sourceRole.posViewOnly)},
           ${pn(sourceRole.daybookEditDays)}, ${Boolean(sourceRole.canAccessCustomers)},
           ${Boolean(sourceRole.canDeleteRecords)})
      `);
      sourceRolesRestored++;
    }

    if (sourceRole.assignedLocationId) {
      await db.execute(sql`
        INSERT INTO user_locations (user_id, company_id, location_id)
        SELECT ${change.user_id}, ${sourceId}, ${sourceRole.assignedLocationId}
        WHERE NOT EXISTS (
          SELECT 1 FROM user_locations
          WHERE user_id = ${change.user_id}
            AND company_id = ${sourceId}
            AND location_id = ${sourceRole.assignedLocationId}
        )
      `);
    }
    if (sourceRole.assignedLocationId && sourceRole.cashAccountId) {
      await db.execute(sql`
        INSERT INTO user_location_cash_accounts
          (user_id, company_id, location_id, cash_account_id, pos_station)
        VALUES
          (${change.user_id}, ${sourceId}, ${sourceRole.assignedLocationId},
           ${sourceRole.cashAccountId}, ${sourceRole.posStation ?? null})
        ON CONFLICT (user_id, company_id, location_id)
        DO NOTHING
      `);
    }

    sessionsSwitched += await switchUserSessions({
      userId: String(change.user_id),
      fromCompanyId: targetId,
      toCompanyId: sourceId,
      role: sourceRole,
      companyName: sourceCompanyName,
    });

    if (change.created_target_role) {
      await db.execute(sql`
        DELETE FROM user_location_cash_accounts
        WHERE user_id = ${change.user_id} AND company_id = ${targetId}
      `);
      await db.execute(sql`
        DELETE FROM user_locations
        WHERE user_id = ${change.user_id} AND company_id = ${targetId}
      `);
      await db.execute(sql`
        DELETE FROM user_company_roles
        WHERE id = ${pn(change.target_role_id)} AND company_id = ${targetId}
      `);
      targetRolesRemoved++;
    }

    await db
      .execute(
        sql`
      UPDATE user_presence
      SET company_id = ${sourceId}, company_name = ${sourceCompanyName}, role = ${sourceRole.role}
      WHERE user_id = ${change.user_id} AND company_id = ${targetId}
    `
      )
      .catch(() => undefined);
  }

  return { sourceRolesRestored, targetRolesRemoved, sessionsSwitched };
}
