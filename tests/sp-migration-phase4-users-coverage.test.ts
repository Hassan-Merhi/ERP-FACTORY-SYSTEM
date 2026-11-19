/**
 * Supplier Partner cutover user moves: moving ERP users, their locations, POS
 * cash mappings and live sessions to the target company, refusing users whose
 * assignments cannot be mapped safely, and restoring everything exactly.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { pool } from "../server/db";
import { moveUsersToTargetExact, restoreUsersToSourceExact } from "../server/routes/sp/spMigrationPhase4Users";
import {
  cleanupSpMigrationPair,
  createSpMigrationPair,
  insertAccount,
  insertCutover,
  insertLocation,
  insertRole,
  insertSession,
  insertUser,
  scalar,
  type SpMigrationPair,
} from "./helpers/spMigrationCoverageFixture";

const PREFIX = "spmigcov_p4users";
let pair: SpMigrationPair;
let cutoverId: number;
let sourceLocation: number;
let targetLocation: number;
let orphanLocation: number;
let sourceCash: number;
let targetCash: number;
let orphanCash: number;
let users: Record<string, string>;

async function rolesFor(userId: string) {
  const result = await pool.query(
    `SELECT company_id, role, assigned_location_id, cash_account_id, pos_station
       FROM user_company_roles WHERE user_id = $1 ORDER BY company_id`,
    [userId]
  );
  return result.rows;
}

async function roleChanges(): Promise<number> {
  return scalar(`SELECT COUNT(*)::int FROM sp_migration_cutover_role_changes WHERE cutover_id = $1`, [cutoverId]);
}

async function session(sid: string) {
  return (await pool.query(`SELECT sess FROM session WHERE sid = $1`, [sid])).rows[0].sess;
}

beforeAll(async () => {
  pair = await createSpMigrationPair(PREFIX);
  sourceLocation = await insertLocation(pair.sourceId, `${pair.code}-SL`, `${PREFIX} Shop`);
  targetLocation = await insertLocation(pair.targetId, `${pair.code}-TL`, `${PREFIX} Shop`);
  orphanLocation = await insertLocation(pair.sourceId, `${pair.code}-OL`, `${PREFIX} Orphan`);
  sourceCash = await insertAccount(pair.sourceId, "CASH-SRC", "Cash", "pos_cash_till");
  targetCash = await insertAccount(pair.targetId, "CASH-TGT", "Cash", "pos_cash_till");
  orphanCash = await insertAccount(pair.sourceId, "CASH-ORPHAN", "Cash", null, `${PREFIX} orphan cash`);
  users = {
    developer: await insertUser(`${PREFIX}_dev`),
    manager: await insertUser(`${PREFIX}_manager`),
    pos: await insertUser(`${PREFIX}_pos`),
  };
}, 120000);

beforeEach(async () => {
  await pool.query(`DELETE FROM sp_migration_cutovers WHERE source_company_id = $1`, [pair.sourceId]);
  for (const table of ["user_location_cash_accounts", "user_locations", "user_company_roles"]) {
    await pool.query(`DELETE FROM ${table} WHERE company_id = ANY($1)`, [[pair.sourceId, pair.targetId]]);
  }
  await pool.query(`DELETE FROM session WHERE sess->>'spMigrationFixture' = $1`, [PREFIX]);
  cutoverId = await insertCutover(pair, "prepared");
});

afterAll(async () => {
  await cleanupSpMigrationPair(PREFIX);
}, 120000);

describe("moveUsersToTargetExact / restoreUsersToSourceExact", () => {
  it("moves mapped users with their assignments and sessions, then restores them exactly", async () => {
    await insertRole(users.developer, pair.sourceId, "Developer");
    await insertRole(users.manager, pair.sourceId, "Manager", { assignedLocationId: sourceLocation });
    await insertRole(users.pos, pair.sourceId, "POS", {
      assignedLocationId: sourceLocation,
      cashAccountId: sourceCash,
      posStation: 2,
    });
    // The POS user already has a target role: the move updates it and the restore puts it back.
    await insertRole(users.pos, pair.targetId, "View Only", { posStation: 7 });
    await pool.query(`INSERT INTO user_locations (user_id, company_id, location_id) VALUES ($1, $2, $3)`, [
      users.manager,
      pair.sourceId,
      sourceLocation,
    ]);
    await pool.query(
      `INSERT INTO user_location_cash_accounts (user_id, company_id, location_id, cash_account_id, pos_station)
       VALUES ($1, $2, $3, $4, 2)`,
      [users.pos, pair.sourceId, sourceLocation, sourceCash]
    );
    await insertSession(PREFIX, `${PREFIX}-sid-manager`, users.manager, pair.sourceId);
    await insertSession(PREFIX, `${PREFIX}-sid-pos`, users.pos, pair.sourceId);
    await insertSession(PREFIX, `${PREFIX}-sid-elsewhere`, users.manager, pair.targetId + 1000000);

    const moved = await moveUsersToTargetExact(cutoverId, pair.sourceId, pair.targetId, pair.targetName);
    expect(moved).toEqual({
      usersMoved: 2,
      targetRolesCreated: 1,
      targetRolesUpdated: 1,
      sessionsSwitched: 2,
      sourceLocationsMoved: 1,
      sourceCashMappingsMoved: 1,
      developerRolesSkipped: 1,
    });
    expect(await rolesFor(users.pos)).toEqual([
      {
        company_id: pair.targetId,
        role: "POS",
        assigned_location_id: targetLocation,
        cash_account_id: targetCash,
        pos_station: 2,
      },
    ]);
    expect(await rolesFor(users.developer)).toHaveLength(1);
    expect(await session(`${PREFIX}-sid-pos`)).toMatchObject({
      currentCompanyId: pair.targetId,
      currentRole: "POS",
      currentLocationId: targetLocation,
      cashAccountId: targetCash,
      currentPOSStation: 2,
      currentCompanyName: pair.targetName,
    });
    expect((await session(`${PREFIX}-sid-elsewhere`)).currentCompanyId).toBe(pair.targetId + 1000000);
    expect(
      await scalar(`SELECT location_id FROM user_locations WHERE user_id = $1 AND company_id = $2`, [
        users.manager,
        pair.targetId,
      ])
    ).toBe(targetLocation);
    expect(
      await scalar(`SELECT cash_account_id FROM user_location_cash_accounts WHERE user_id = $1 AND company_id = $2`, [
        users.pos,
        pair.targetId,
      ])
    ).toBe(targetCash);
    expect(await roleChanges()).toBe(2);

    const restored = await restoreUsersToSourceExact(cutoverId, pair.sourceId, pair.targetId, pair.sourceName, true);
    expect(restored).toEqual({
      usersRestored: 2,
      sourceRolesRestored: 2,
      targetRolesRemoved: 1,
      targetRolesRestored: 1,
      sessionsSwitched: 2,
      sourceLocationsRestored: 1,
      sourceCashMappingsRestored: 1,
    });
    expect(await rolesFor(users.pos)).toEqual([
      {
        company_id: pair.sourceId,
        role: "POS",
        assigned_location_id: sourceLocation,
        cash_account_id: sourceCash,
        pos_station: 2,
      },
      {
        company_id: pair.targetId,
        role: "View Only",
        assigned_location_id: null,
        cash_account_id: null,
        pos_station: 7,
      },
    ]);
    expect(await rolesFor(users.manager)).toEqual([
      {
        company_id: pair.sourceId,
        role: "Manager",
        assigned_location_id: sourceLocation,
        cash_account_id: null,
        pos_station: null,
      },
    ]);
    expect(await session(`${PREFIX}-sid-manager`)).toMatchObject({
      currentCompanyId: pair.sourceId,
      currentCompanyName: pair.sourceName,
    });
    expect(
      await scalar(`SELECT COUNT(*)::int FROM user_locations WHERE user_id = $1 AND company_id = $2`, [
        users.manager,
        pair.sourceId,
      ])
    ).toBe(1);
    expect(await roleChanges()).toBe(0);
  });

  it("keeps role-change snapshots when restoring without clearing them", async () => {
    await insertRole(users.manager, pair.sourceId, "Manager");
    await moveUsersToTargetExact(cutoverId, pair.sourceId, pair.targetId, pair.targetName);
    const restored = await restoreUsersToSourceExact(cutoverId, pair.sourceId, pair.targetId, pair.sourceName);
    expect(restored).toMatchObject({ usersRestored: 1, sourceRolesRestored: 1, targetRolesRemoved: 1 });
    expect(await roleChanges()).toBe(1);
  });

  it("restores a change row with no target snapshot without inventing target state", async () => {
    await insertRole(users.manager, pair.targetId, "Manager");
    await pool.query(
      `INSERT INTO sp_migration_cutover_role_changes (cutover_id, user_id, source_role_id, created_target_role, source_role_snapshot)
       VALUES ($1, $2, 1, false, $3::jsonb)`,
      [cutoverId, users.manager, JSON.stringify({ role: "Accountant", assignedLocationId: sourceLocation })]
    );
    const restored = await restoreUsersToSourceExact(cutoverId, pair.sourceId, pair.targetId, pair.sourceName, true);
    expect(restored).toMatchObject({
      usersRestored: 1,
      sourceRolesRestored: 1,
      targetRolesRemoved: 0,
      targetRolesRestored: 0,
    });
    expect(await rolesFor(users.manager)).toEqual([
      {
        company_id: pair.sourceId,
        role: "Accountant",
        assigned_location_id: sourceLocation,
        cash_account_id: null,
        pos_station: null,
      },
      {
        company_id: pair.targetId,
        role: "Manager",
        assigned_location_id: null,
        cash_account_id: null,
        pos_station: null,
      },
    ]);
  });

  it("refuses a POS user with no safe target location or cash account", async () => {
    await insertRole(users.pos, pair.sourceId, "POS", {
      assignedLocationId: orphanLocation,
      cashAccountId: sourceCash,
    });
    await expect(moveUsersToTargetExact(cutoverId, pair.sourceId, pair.targetId, pair.targetName)).rejects.toThrow(
      `POS user ${users.pos} has no safe target location/cash-account mapping.`
    );
    expect(await rolesFor(users.pos)).toHaveLength(1);
    expect(await roleChanges()).toBe(0);
  });

  it("refuses unmapped user locations and cash mappings without moving the user", async () => {
    await insertRole(users.manager, pair.sourceId, "Manager");
    await pool.query(`INSERT INTO user_locations (user_id, company_id, location_id) VALUES ($1, $2, $3)`, [
      users.manager,
      pair.sourceId,
      orphanLocation,
    ]);
    await expect(moveUsersToTargetExact(cutoverId, pair.sourceId, pair.targetId, pair.targetName)).rejects.toThrow(
      `Location ${orphanLocation} has no safe target mapping.`
    );

    await pool.query(`DELETE FROM user_locations WHERE user_id = $1`, [users.manager]);
    await pool.query(
      `INSERT INTO user_location_cash_accounts (user_id, company_id, location_id, cash_account_id) VALUES ($1, $2, $3, $4)`,
      [users.manager, pair.sourceId, sourceLocation, orphanCash]
    );
    await expect(moveUsersToTargetExact(cutoverId, pair.sourceId, pair.targetId, pair.targetName)).rejects.toThrow(
      `Cash mapping location ${sourceLocation}, account ${orphanCash} has no safe target mapping.`
    );
    expect(await rolesFor(users.manager)).toEqual([
      {
        company_id: pair.sourceId,
        role: "Manager",
        assigned_location_id: null,
        cash_account_id: null,
        pos_station: null,
      },
    ]);
    expect(await roleChanges()).toBe(0);
  });
});
