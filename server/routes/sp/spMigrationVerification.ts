import { sql } from "drizzle-orm";
import { db } from "../../db";
import {
  buildCutoverReadiness,
  resolveTargetLedgerAccount,
  resolveTargetLocation,
} from "./spMigrationCutoverReadiness";
import { pn } from "./spMigrationCommon";
import { buildExactInventoryPlan } from "./spMigrationInventory";
import { classifyFinalVerification, type VerificationIssue } from "./spMigrationPolicy";
import { resultRows } from "../../lib/queryResult";
import {
  addUnique,
  verifyContainers,
  verifyHistoricalSales,
  type VerificationArea,
} from "./spMigrationVerificationVerifyContainers";
export type { VerificationArea } from "./spMigrationVerificationVerifyContainers";

async function verifyUserMappings(
  sourceId: number,
  targetId: number
): Promise<{
  blockers: VerificationIssue[];
  area: VerificationArea;
  counts: Record<string, number>;
}> {
  const blockers: VerificationIssue[] = [];
  const rolesResult = await db.execute(sql`
    SELECT * FROM user_company_roles
    WHERE company_id = ${sourceId} AND role <> 'Developer'
    ORDER BY id ASC
  `);
  let locationsChecked = 0;
  let cashMappingsChecked = 0;
  const mismatches: string[] = [];

  for (const role of resultRows(rolesResult)) {
    if (role.assigned_location_id) {
      locationsChecked++;
      if (!(await resolveTargetLocation(sourceId, targetId, pn(role.assigned_location_id)))) {
        mismatches.push(`User ${role.user_id}: assigned location ${role.assigned_location_id} is unmapped.`);
      }
    }
    if (role.cash_account_id) {
      cashMappingsChecked++;
      if (!(await resolveTargetLedgerAccount(pn(role.cash_account_id), targetId))) {
        mismatches.push(`User ${role.user_id}: cash account ${role.cash_account_id} is unmapped.`);
      }
    }
    const locations = await db.execute(sql`
      SELECT location_id FROM user_locations
      WHERE user_id = ${role.user_id} AND company_id = ${sourceId}
    `);
    for (const row of resultRows(locations)) {
      locationsChecked++;
      if (!(await resolveTargetLocation(sourceId, targetId, pn(row.location_id)))) {
        mismatches.push(`User ${role.user_id}: location ${row.location_id} is unmapped.`);
      }
    }
    const cashMappings = await db.execute(sql`
      SELECT location_id, cash_account_id FROM user_location_cash_accounts
      WHERE user_id = ${role.user_id} AND company_id = ${sourceId}
    `);
    for (const row of resultRows(cashMappings)) {
      cashMappingsChecked++;
      const location = await resolveTargetLocation(sourceId, targetId, pn(row.location_id));
      const account = await resolveTargetLedgerAccount(pn(row.cash_account_id), targetId);
      if (!location || !account) {
        mismatches.push(
          `User ${role.user_id}: location/cash mapping ${row.location_id}/${row.cash_account_id} is unmapped.`
        );
      }
    }
  }

  if (mismatches.length) {
    blockers.push({
      code: "USER_ASSIGNMENT_MAPPING_MISSING",
      message: `${mismatches.length} user role/location/cash assignment(s) cannot be moved safely.`,
      count: mismatches.length,
      detail: mismatches.slice(0, 50),
    });
  }
  return {
    blockers,
    counts: {
      roles: resultRows(rolesResult).length,
      locationsChecked,
      cashMappingsChecked,
      mismatches: mismatches.length,
    },
    area: {
      area: "User and POS assignments",
      status: mismatches.length ? "FAIL" : "PASS",
      detail: `${locationsChecked} location assignment(s) and ${cashMappingsChecked} cash mapping(s) checked.`,
      mismatches: mismatches.slice(0, 50),
    },
  };
}

export async function buildFinalMigrationVerification(sourceId: number, targetId: number) {
  const base = await buildCutoverReadiness(sourceId, targetId);
  const blockers: VerificationIssue[] = (base.blockers ?? []).filter(
    (issue: VerificationIssue) => !["UNMAPPED_INVENTORY", "TARGET_ALREADY_LIVE"].includes(issue.code)
  );
  const deltas: VerificationIssue[] = (base.deltas ?? []).filter(
    (issue: VerificationIssue) => !["STOCK_DELTA", "SALES_DELTA", "CONTAINER_DELTA"].includes(issue.code)
  );
  const areas: VerificationArea[] = [];

  const inventory = await buildExactInventoryPlan(sourceId, targetId);
  for (const blocker of inventory.blockers) addUnique(blockers, blocker);
  if (inventory.changedRows) {
    addUnique(deltas, {
      code: "EXACT_INVENTORY_DELTA",
      message: `${inventory.changedRows} target inventory row(s) require exact final synchronization, including ${inventory.targetOnlyRows} target-only row(s).`,
      count: inventory.changedRows,
    });
  }
  areas.push({
    area: "Inventory by location",
    status: inventory.blockers.length ? "FAIL" : inventory.changedRows ? "WARN" : "PASS",
    detail:
      `${inventory.sourceRows} source row(s); ${inventory.targetRowsInScope} target row(s) in scope; ` +
      `${inventory.changedRows} exact delta(s); ${inventory.targetOnlyRows} target-only row(s).`,
    mismatches: inventory.blockers.map((issue) => issue.message).slice(0, 50),
  });

  const sales = await verifyHistoricalSales(sourceId, targetId);
  sales.blockers.forEach((issue) => addUnique(blockers, issue));
  sales.deltas.forEach((issue) => addUnique(deltas, issue));
  areas.push(sales.area);

  const containers = await verifyContainers(sourceId, targetId);
  containers.blockers.forEach((issue) => addUnique(blockers, issue));
  containers.deltas.forEach((issue) => addUnique(deltas, issue));
  areas.push(containers.area);

  const users = await verifyUserMappings(sourceId, targetId);
  users.blockers.forEach((issue) => addUnique(blockers, issue));
  areas.push(users.area);

  const accountingBlockers = blockers.filter((issue) =>
    [
      "SUSPENSE_REVIEW_REQUIRED",
      "CONTAINER_CHARGE_REVIEW_REQUIRED",
      "UNBALANCED_MIGRATION_VOUCHERS",
      "MISSING_TARGET_ACCOUNTS",
      "PROFIT_OPENING_MISSING",
    ].includes(issue.code)
  );
  areas.push({
    area: "Accounting readiness",
    status: accountingBlockers.length ? "FAIL" : "PASS",
    detail: accountingBlockers.length
      ? `${accountingBlockers.length} accounting blocker category/categories remain.`
      : "Required accounts, profit opening, suspense, charge review, and voucher balance checks passed.",
    mismatches: accountingBlockers.map((issue) => issue.message),
  });

  const overall = classifyFinalVerification(blockers, deltas);
  return {
    overall,
    canPrepare: blockers.length === 0,
    canFinalize: blockers.length === 0 && deltas.length === 0,
    blockers,
    deltas,
    areas,
    counts: {
      ...(base.counts ?? {}),
      exactInventory: inventory,
      historicalSales: sales.counts,
      containers: containers.counts,
      users: users.counts,
    },
  };
}
