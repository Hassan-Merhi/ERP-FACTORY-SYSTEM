/**
 * Supplier Partner cutover user moves: moving ERP users, their locations, POS
 * cash mappings and live sessions to the target company, refusing users whose
 * assignments cannot be mapped safely, and restoring them.
 *
 * Known defect (spMigrationPhase4Users.ts:55-79, switchUserSessions): the
 * session update passes untyped parameters to jsonb_build_object, and Postgres
 * refuses them with 42P18 ("could not determine data type of parameter"). Every
 * move or restore of a non-Developer user therefore fails at that step and its
 * transaction rolls back. These tests pin that the rollback is complete: the
 * user, their assignments and sessions stay exactly where they were.
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
const SESSION_PARAM_DEFECT = { cause: { code: "42P18" } };
let pair: SpMigrationPair;
let cutoverId: number;
let sourceLocation: number;
let orphanLocation: number;
let sourceCash: number;
let orphanCash: number;
let users: Record<string, string>;

async function rolesFor(userId: string) {
  const result = await pool.query(
    `SELECT company_id, role, assigned_location_id, cash_account_id FROM user_company_roles WHERE user_id = $1 ORDER BY company_id`,
    [userId]
  );
  return result.rows;
}

async function roleChanges(): Promise<number> {
  return scalar(`SELECT COUNT(*)::int FROM sp_migration_cutover_role_changes WHERE cutover_id = $1`, [cutoverId]);
}

beforeAll(async () => {
  pair = await createSpMigrationPair(PREFIX);
  sourceLocation = await insertLocation(pair.sourceId, `${pair.code}-SL`, `${PREFIX} Shop`);
  await insertLocation(pair.targetId, `${pair.code}-TL`, `${PREFIX} Shop`);
  orphanLocation = await insertLocation(pair.sourceId, `${pair.code}-OL`, `${PREFIX} Orphan`);
  sourceCash = await insertAccount(pair.sourceId, "CASH-SRC", "Cash", "pos_cash_till");
  await insertAccount(pair.targetId, "CASH-TGT", "Cash", "pos_cash_till");
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

describe("moveUsersToTargetExact", () => {
  it("skips Developer roles and has nothing else to move", async () => {
    await insertRole(users.developer, pair.sourceId, "Developer");
    const moved = await moveUsersToTargetExact(cutoverId, pair.sourceId, pair.targetId, pair.targetName);
    expect(moved).toMatchObject({ usersMoved: 0, developerRolesSkipped: 1, targetRolesCreated: 0 });
    expect(await rolesFor(users.developer)).toHaveLength(1);
  });

  it("maps a POS user's assignments, then rolls the whole move back at the session switch", async () => {
    await insertRole(users.pos, pair.sourceId, "POS", {
      assignedLocationId: sourceLocation,
      cashAccountId: sourceCash,
      posStation: 2,
    });
    await insertRole(users.pos, pair.targetId, "View Only");
    await pool.query(`INSERT INTO user_locations (user_id, company_id, location_id) VALUES ($1, $2, $3)`, [
      users.pos,
      pair.sourceId,
      sourceLocation,
    ]);
    await pool.query(
      `INSERT INTO user_location_cash_accounts (user_id, company_id, location_id, cash_account_id, pos_station)
       VALUES ($1, $2, $3, $4, 2)`,
      [users.pos, pair.sourceId, sourceLocation, sourceCash]
    );
    await insertSession(PREFIX, `${PREFIX}-sid-pos`, users.pos, pair.sourceId);

    await expect(
      moveUsersToTargetExact(cutoverId, pair.sourceId, pair.targetId, pair.targetName)
    ).rejects.toMatchObject(SESSION_PARAM_DEFECT);

    expect(await rolesFor(users.pos)).toEqual([
      { company_id: pair.sourceId, role: "POS", assigned_location_id: sourceLocation, cash_account_id: sourceCash },
      { company_id: pair.targetId, role: "View Only", assigned_location_id: null, cash_account_id: null },
    ]);
    expect(await roleChanges()).toBe(0);
    expect(
      await scalar(`SELECT COUNT(*)::int FROM user_locations WHERE user_id = $1 AND company_id = $2`, [
        users.pos,
        pair.targetId,
      ])
    ).toBe(0);
    expect(
      Number(await scalar(`SELECT sess->>'currentCompanyId' FROM session WHERE sid = $1`, [`${PREFIX}-sid-pos`]))
    ).toBe(pair.sourceId);
  });

  it("creates no target role for a new user when the move rolls back", async () => {
    await insertRole(users.manager, pair.sourceId, "Manager");
    await expect(
      moveUsersToTargetExact(cutoverId, pair.sourceId, pair.targetId, pair.targetName)
    ).rejects.toMatchObject(SESSION_PARAM_DEFECT);
    expect(await rolesFor(users.manager)).toEqual([
      { company_id: pair.sourceId, role: "Manager", assigned_location_id: null, cash_account_id: null },
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
      { company_id: pair.sourceId, role: "Manager", assigned_location_id: null, cash_account_id: null },
    ]);
    expect(await roleChanges()).toBe(0);
  });
});

describe("restoreUsersToSourceExact", () => {
  async function insertChange(userId: string, createdTargetRole: boolean, targetBefore: unknown, sourceRole: unknown) {
    await pool.query(
      `INSERT INTO sp_migration_cutover_role_changes
         (cutover_id, user_id, source_role_id, target_role_id, created_target_role, source_role_snapshot,
          target_role_snapshot_before, source_locations_snapshot, source_cash_mappings_snapshot,
          target_locations_snapshot_before, target_cash_mappings_snapshot_before)
       VALUES ($1, $2, 1, NULL, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7::jsonb, '[]'::jsonb, '[]'::jsonb)`,
      [
        cutoverId,
        userId,
        createdTargetRole,
        JSON.stringify(sourceRole),
        targetBefore === null ? null : JSON.stringify(targetBefore),
        JSON.stringify([{ locationId: sourceLocation }]),
        JSON.stringify([{ locationId: sourceLocation, cashAccountId: sourceCash, posStation: 1 }]),
      ]
    );
  }

  it("clears snapshots when there is nothing to restore", async () => {
    const restored = await restoreUsersToSourceExact(cutoverId, pair.sourceId, pair.targetId, pair.sourceName, true);
    expect(restored.usersRestored).toBe(0);
  });

  it.each([
    ["a target role it created", true, null],
    ["a target role that existed before", false, { role: "View Only", assigned_location_id: null, pos_station: 3 }],
    ["no recorded target state", false, null],
  ])("rebuilds the source role over %s, then rolls back at the session switch", async (_label, created, before) => {
    await insertRole(users.manager, pair.targetId, "Manager");
    await insertChange(users.manager, created as boolean, before, {
      role: "Accountant",
      assignedLocationId: sourceLocation,
      cashAccountId: sourceCash,
      posStation: 1,
      canSellNegativeStock: true,
    });
    await expect(
      restoreUsersToSourceExact(cutoverId, pair.sourceId, pair.targetId, pair.sourceName, true)
    ).rejects.toMatchObject(SESSION_PARAM_DEFECT);
    // The transaction rolled back: the source role was not recreated and the target role is untouched.
    expect(await rolesFor(users.manager)).toEqual([
      { company_id: pair.targetId, role: "Manager", assigned_location_id: null, cash_account_id: null },
    ]);
    expect(await roleChanges()).toBe(1);
  });
});
