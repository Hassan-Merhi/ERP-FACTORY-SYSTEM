import { sql } from "drizzle-orm";
import { db } from "../../db";
import { pn } from "./spMigrationPhase2Common";
import { backfillLegacyCutoverStockDeltaKeys } from "./spMigrationPhase4Inventory";
import { resultRows, firstRow } from "../../lib/queryResult";
import { asRecord, toFiniteNumber } from "@shared/typeGuards";
import {
  switchUserSessions,
  loadCashMappings,
  mapRole,
  mapAllLocations,
  mapAllCashMappings,
  replaceCashMappings,
  upsertRole,
  type RoleSnapshot,
} from "./spMigrationPhase4UsersHelpers";
export type { RoleSnapshot } from "./spMigrationPhase4UsersHelpers";

function roleSnapshot(row: Record<string, unknown>): RoleSnapshot {
  return {
    role: String(row.role ?? ""),
    assignedLocationId: row.assigned_location_id
      ? pn(row.assigned_location_id)
      : (toFiniteNumber(row.assignedLocationId) ?? null),
    cashAccountId: row.cash_account_id ? pn(row.cash_account_id) : (toFiniteNumber(row.cashAccountId) ?? null),
    posStation: toFiniteNumber(row.pos_station ?? row.posStation) ?? null,
    canSellNegativeStock: Boolean(row.can_sell_negative_stock ?? row.canSellNegativeStock),
    posViewOnly: Boolean(row.pos_view_only ?? row.posViewOnly),
    daybookEditDays: pn(row.daybook_edit_days ?? row.daybookEditDays),
    canAccessCustomers: Boolean(row.can_access_customers ?? row.canAccessCustomers),
    canDeleteRecords: Boolean(row.can_delete_records ?? row.canDeleteRecords),
  };
}

async function loadUserLocations(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  userId: string,
  companyId: number
) {
  const result = await tx.execute(sql`
    SELECT location_id
    FROM user_locations
    WHERE user_id = ${userId} AND company_id = ${companyId}
    ORDER BY location_id ASC
  `);
  return resultRows(result).map((row) => ({ locationId: pn(row.location_id) }));
}

async function replaceLocations(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  userId: string,
  companyId: number,
  rows: Record<string, unknown>[]
): Promise<void> {
  await tx.execute(sql`DELETE FROM user_locations WHERE user_id = ${userId} AND company_id = ${companyId}`);
  for (const row of rows) {
    await tx.execute(sql`
      INSERT INTO user_locations (user_id, company_id, location_id)
      VALUES (${userId}, ${companyId}, ${pn(row.locationId)})
    `);
  }
}

export async function moveUsersToTargetExact(
  cutoverId: number,
  sourceId: number,
  targetId: number,
  targetCompanyName: string
) {
  await backfillLegacyCutoverStockDeltaKeys();
  const sourceRolesResult = await db.execute(sql`
    SELECT * FROM user_company_roles
    WHERE company_id = ${sourceId}
    ORDER BY id ASC
  `);

  const summary = {
    usersMoved: 0,
    targetRolesCreated: 0,
    targetRolesUpdated: 0,
    sessionsSwitched: 0,
    sourceLocationsMoved: 0,
    sourceCashMappingsMoved: 0,
    developerRolesSkipped: 0,
  };

  for (const sourceRole of resultRows(sourceRolesResult)) {
    if (sourceRole.role === "Developer") {
      summary.developerRolesSkipped++;
      continue;
    }

    const userId = String(sourceRole.user_id);
    const mappedRole = await mapRole(sourceId, targetId, sourceRole);

    await db.transaction(async (tx) => {
      const sourceLocations = await loadUserLocations(tx, userId, sourceId);
      const sourceCashMappings = await loadCashMappings(tx, userId, sourceId);
      const targetLocationsBefore = await loadUserLocations(tx, userId, targetId);
      const targetCashMappingsBefore = await loadCashMappings(tx, userId, targetId);
      const targetRoleResult = await tx.execute(sql`
        SELECT * FROM user_company_roles
        WHERE user_id = ${userId} AND company_id = ${targetId}
        LIMIT 1
      `);
      const targetRoleBefore = firstRow(targetRoleResult) ?? null;

      const mappedLocations = await mapAllLocations(sourceId, targetId, sourceLocations);
      const mappedCashMappings = await mapAllCashMappings(sourceId, targetId, sourceCashMappings);
      const targetRole = await upsertRole(tx, userId, targetId, mappedRole);
      if (targetRole.created) summary.targetRolesCreated++;
      else summary.targetRolesUpdated++;

      await tx.execute(sql`
        INSERT INTO sp_migration_cutover_role_changes
          (cutover_id, user_id, source_role_id, target_role_id, created_target_role,
           source_role_snapshot, target_role_snapshot_before,
           source_locations_snapshot, source_cash_mappings_snapshot,
           target_locations_snapshot_before, target_cash_mappings_snapshot_before,
           mapped_location_id, mapped_cash_account_id, sessions_switched)
        VALUES
          (${cutoverId}, ${userId}, ${pn(sourceRole.id)}, ${targetRole.id}, ${targetRole.created},
           ${JSON.stringify(roleSnapshot(sourceRole))}::jsonb,
           ${targetRoleBefore ? JSON.stringify(roleSnapshot(targetRoleBefore)) : null}::jsonb,
           ${JSON.stringify(sourceLocations)}::jsonb, ${JSON.stringify(sourceCashMappings)}::jsonb,
           ${JSON.stringify(targetLocationsBefore)}::jsonb, ${JSON.stringify(targetCashMappingsBefore)}::jsonb,
           ${mappedRole.assignedLocationId ?? null}, ${mappedRole.cashAccountId ?? null}, 0)
        ON CONFLICT (cutover_id, user_id)
        DO UPDATE SET
          source_role_id = EXCLUDED.source_role_id,
          target_role_id = EXCLUDED.target_role_id,
          created_target_role = EXCLUDED.created_target_role,
          source_role_snapshot = EXCLUDED.source_role_snapshot,
          target_role_snapshot_before = EXCLUDED.target_role_snapshot_before,
          source_locations_snapshot = EXCLUDED.source_locations_snapshot,
          source_cash_mappings_snapshot = EXCLUDED.source_cash_mappings_snapshot,
          target_locations_snapshot_before = EXCLUDED.target_locations_snapshot_before,
          target_cash_mappings_snapshot_before = EXCLUDED.target_cash_mappings_snapshot_before,
          mapped_location_id = EXCLUDED.mapped_location_id,
          mapped_cash_account_id = EXCLUDED.mapped_cash_account_id,
          sessions_switched = 0
      `);

      await replaceLocations(tx, userId, targetId, mappedLocations);
      await replaceCashMappings(tx, userId, targetId, mappedCashMappings);
      const switched = await switchUserSessions(tx, {
        userId,
        fromCompanyId: sourceId,
        toCompanyId: targetId,
        role: mappedRole,
        companyName: targetCompanyName,
      });
      await tx.execute(sql`
        UPDATE sp_migration_cutover_role_changes
        SET sessions_switched = ${switched}
        WHERE cutover_id = ${cutoverId} AND user_id = ${userId}
      `);

      await tx.execute(
        sql`DELETE FROM user_location_cash_accounts WHERE user_id = ${userId} AND company_id = ${sourceId}`
      );
      await tx.execute(sql`DELETE FROM user_locations WHERE user_id = ${userId} AND company_id = ${sourceId}`);
      await tx.execute(
        sql`DELETE FROM user_company_roles WHERE id = ${pn(sourceRole.id)} AND company_id = ${sourceId}`
      );
      await tx
        .execute(
          sql`
        UPDATE user_presence
        SET company_id = ${targetId}, company_name = ${targetCompanyName}, role = ${mappedRole.role}
        WHERE user_id = ${userId} AND company_id = ${sourceId}
      `
        )
        .catch(() => undefined);

      summary.sessionsSwitched += switched;
      summary.sourceLocationsMoved += sourceLocations.length;
      summary.sourceCashMappingsMoved += sourceCashMappings.length;
      summary.usersMoved++;
    });
  }

  return summary;
}

export async function restoreUsersToSourceExact(
  cutoverId: number,
  sourceId: number,
  targetId: number,
  sourceCompanyName: string,
  clearSnapshots = false
) {
  await backfillLegacyCutoverStockDeltaKeys();
  const changesResult = await db.execute(sql`
    SELECT * FROM sp_migration_cutover_role_changes
    WHERE cutover_id = ${cutoverId}
    ORDER BY id DESC
  `);

  const summary = {
    usersRestored: 0,
    sourceRolesRestored: 0,
    targetRolesRemoved: 0,
    targetRolesRestored: 0,
    sessionsSwitched: 0,
    sourceLocationsRestored: 0,
    sourceCashMappingsRestored: 0,
  };

  for (const change of resultRows(changesResult)) {
    const userId = String(change.user_id);
    // The stored snapshots were written by roleSnapshot(), which also reads its
    // own output back (it accepts both the snake_case row and the camelCase
    // snapshot). Parsing them through it restores every field, where the old
    // cast declared only four of the nine and dropped the five permission flags
    // from the type - upsertRole received them at runtime regardless, so this is
    // the same restore with the shape stated honestly.
    const sourceRole = roleSnapshot(asRecord(change.source_role_snapshot) ?? {});
    const targetRoleBeforeRecord = asRecord(change.target_role_snapshot_before);
    const targetRoleBefore = targetRoleBeforeRecord ? roleSnapshot(targetRoleBeforeRecord) : null;
    const sourceLocations = Array.isArray(change.source_locations_snapshot) ? change.source_locations_snapshot : [];
    const sourceCashMappings = Array.isArray(change.source_cash_mappings_snapshot)
      ? change.source_cash_mappings_snapshot
      : [];
    const targetLocationsBefore = Array.isArray(change.target_locations_snapshot_before)
      ? change.target_locations_snapshot_before
      : [];
    const targetCashMappingsBefore = Array.isArray(change.target_cash_mappings_snapshot_before)
      ? change.target_cash_mappings_snapshot_before
      : [];

    await db.transaction(async (tx) => {
      const restoredSourceRole = await upsertRole(tx, userId, sourceId, sourceRole);
      if (restoredSourceRole.created) summary.sourceRolesRestored++;
      await replaceLocations(tx, userId, sourceId, sourceLocations);
      await replaceCashMappings(tx, userId, sourceId, sourceCashMappings);

      if (change.created_target_role) {
        await tx.execute(
          sql`DELETE FROM user_location_cash_accounts WHERE user_id = ${userId} AND company_id = ${targetId}`
        );
        await tx.execute(sql`DELETE FROM user_locations WHERE user_id = ${userId} AND company_id = ${targetId}`);
        await tx.execute(
          sql`DELETE FROM user_company_roles WHERE id = ${pn(change.target_role_id)} AND company_id = ${targetId}`
        );
        summary.targetRolesRemoved++;
      } else if (targetRoleBefore) {
        await upsertRole(tx, userId, targetId, targetRoleBefore);
        await replaceLocations(tx, userId, targetId, targetLocationsBefore);
        await replaceCashMappings(tx, userId, targetId, targetCashMappingsBefore);
        summary.targetRolesRestored++;
      }

      const switched = await switchUserSessions(tx, {
        userId,
        fromCompanyId: targetId,
        toCompanyId: sourceId,
        role: sourceRole,
        companyName: sourceCompanyName,
      });
      await tx
        .execute(
          sql`
        UPDATE user_presence
        SET company_id = ${sourceId}, company_name = ${sourceCompanyName}, role = ${sourceRole.role}
        WHERE user_id = ${userId} AND company_id = ${targetId}
      `
        )
        .catch(() => undefined);

      summary.sessionsSwitched += switched;
      summary.sourceLocationsRestored += sourceLocations.length;
      summary.sourceCashMappingsRestored += sourceCashMappings.length;
      summary.usersRestored++;
    });
  }

  if (clearSnapshots) {
    await db.execute(sql`DELETE FROM sp_migration_cutover_role_changes WHERE cutover_id = ${cutoverId}`);
  }
  return summary;
}
