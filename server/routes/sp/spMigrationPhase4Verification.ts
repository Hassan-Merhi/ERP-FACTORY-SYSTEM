import { sql } from "drizzle-orm";
import { sqlArray } from "../../lib/sqlArray";
import { db } from "../../db";
import {
  buildCutoverReadiness,
  resolveTargetLedgerAccount,
  resolveTargetLocation,
} from "./spMigrationCutoverReadiness";
import { getSourceContainerLines } from "./spMigrationPhase2Charges";
import { getSpSupplierVoucherLinkGapCount } from "./spSupplierVoucherSync";
import { pn } from "./spMigrationPhase2Common";
import { buildExactInventoryPlan } from "./spMigrationPhase4Inventory";
import { classifyFinalVerification, numbersDiffer, type VerificationIssue } from "./spMigrationPhase4Policy";
import { resultRows, firstRow } from "../../lib/queryResult";

export type VerificationArea = {
  area: string;
  status: "PASS" | "WARN" | "FAIL";
  detail: string;
  mismatches?: string[];
};

function addUnique(target: VerificationIssue[], issue: VerificationIssue): void {
  if (!target.some((existing) => existing.code === issue.code)) target.push(issue);
}

async function completedPairLinks(sourceId: number, targetId: number, sourceTable: string, targetTable: string) {
  const result = await db.execute(sql`
    SELECT DISTINCT ON (l.source_id) l.source_id, l.target_id
    FROM sp_migration_source_links l
    JOIN sp_migration_rehearsal_runs r ON r.id = l.run_id
    WHERE r.source_company_id = ${sourceId}
      AND r.target_company_id = ${targetId}
      AND r.status <> 'rolled_back'
      AND l.source_table = ${sourceTable}
      AND l.target_table = ${targetTable}
    ORDER BY l.source_id, r.created_at DESC
  `);
  return resultRows(result);
}

async function verifyHistoricalSales(
  sourceId: number,
  targetId: number
): Promise<{
  blockers: VerificationIssue[];
  deltas: VerificationIssue[];
  area: VerificationArea;
  counts: Record<string, number>;
}> {
  const blockers: VerificationIssue[] = [];
  const deltas: VerificationIssue[] = [];
  const voucherLinks = await completedPairLinks(sourceId, targetId, "vouchers", "vouchers");
  const itemLinks = await completedPairLinks(sourceId, targetId, "sales_items", "sales_items");
  const entryLinks = await completedPairLinks(sourceId, targetId, "voucher_entries", "voucher_entries");
  const linkedVoucherIds = new Set(voucherLinks.map((row) => pn(row.source_id)));
  const linkedItemIds = new Set(itemLinks.map((row) => pn(row.source_id)));
  const linkedEntryIds = new Set(entryLinks.map((row) => pn(row.source_id)));

  const sourceVouchersResult = await db.execute(sql`
    SELECT id, voucher_number FROM vouchers
    WHERE company_id = ${sourceId} AND voucher_type IN ('Sales', 'Sale') AND deleted_at IS NULL
    ORDER BY id ASC
  `);
  const sourceItemsResult = await db.execute(sql`
    SELECT si.id
    FROM sales_items si
    JOIN vouchers v ON v.id = si.voucher_id
    WHERE v.company_id = ${sourceId} AND v.voucher_type IN ('Sales', 'Sale') AND v.deleted_at IS NULL
  `);
  const sourceEntriesResult = await db.execute(sql`
    SELECT e.id
    FROM voucher_entries e
    JOIN vouchers v ON v.id = e.voucher_id
    WHERE v.company_id = ${sourceId} AND v.voucher_type IN ('Sales', 'Sale') AND v.deleted_at IS NULL
  `);
  const sourceVouchers = resultRows(sourceVouchersResult);
  const sourceItems = resultRows(sourceItemsResult);
  const sourceEntries = resultRows(sourceEntriesResult);
  const missingVouchers = sourceVouchers.filter((row) => !linkedVoucherIds.has(pn(row.id)));
  const missingItems = sourceItems.filter((row) => !linkedItemIds.has(pn(row.id)));
  const missingEntries = sourceEntries.filter((row) => !linkedEntryIds.has(pn(row.id)));

  if (missingVouchers.length) {
    deltas.push({
      code: "READONLY_SALES_VOUCHER_DELTA",
      message: `${missingVouchers.length} historical sale voucher(s) require migration or provenance repair.`,
      count: missingVouchers.length,
    });
  }
  if (missingItems.length) {
    deltas.push({
      code: "READONLY_SALES_ITEM_DELTA",
      message: `${missingItems.length} historical sale item row(s) require safe backfill or provenance repair.`,
      count: missingItems.length,
    });
  }
  if (missingEntries.length) {
    deltas.push({
      code: "READONLY_SALES_ENTRY_DELTA",
      message: `${missingEntries.length} historical accounting entry row(s) require safe backfill or provenance repair.`,
      count: missingEntries.length,
    });
  }

  const unlinkedTargetsResult = await db.execute(sql`
    SELECT COUNT(*)::int AS count
    FROM vouchers tv
    WHERE tv.company_id = ${targetId}
      AND tv.source_module = 'SP_MIGRATION_READONLY'
      AND tv.deleted_at IS NULL
      AND NOT EXISTS (
        SELECT 1
        FROM sp_migration_source_links l
        JOIN sp_migration_rehearsal_runs r ON r.id = l.run_id
        WHERE r.source_company_id = ${sourceId}
          AND r.target_company_id = ${targetId}
          AND r.status <> 'rolled_back'
          AND l.target_table = 'vouchers'
          AND l.target_id = tv.id
      )
  `);
  const unlinkedTargets = pn(firstRow(unlinkedTargetsResult)?.count);
  if (unlinkedTargets) {
    blockers.push({
      code: "UNPROVENANCED_TARGET_SALES",
      message: `${unlinkedTargets} target read-only sale voucher(s) have no source provenance and cannot be trusted for cutover.`,
      count: unlinkedTargets,
    });
  }

  const counts = {
    sourceVouchers: sourceVouchers.length,
    linkedVouchers: voucherLinks.length,
    sourceItems: sourceItems.length,
    linkedItems: itemLinks.length,
    sourceEntries: sourceEntries.length,
    linkedEntries: entryLinks.length,
    unlinkedTargetVouchers: unlinkedTargets,
  };
  const status = blockers.length ? "FAIL" : deltas.length ? "WARN" : "PASS";
  return {
    blockers,
    deltas,
    counts,
    area: {
      area: "Historical sales copy",
      status,
      detail:
        `Vouchers ${voucherLinks.length}/${sourceVouchers.length}; items ${itemLinks.length}/${sourceItems.length}; ` +
        `entries ${entryLinks.length}/${sourceEntries.length} linked to their source rows.`,
      mismatches: missingVouchers.slice(0, 50).map((row) => `Missing voucher: ${row.voucher_number}`),
    },
  };
}

async function verifyContainers(
  sourceId: number,
  targetId: number
): Promise<{
  blockers: VerificationIssue[];
  deltas: VerificationIssue[];
  area: VerificationArea;
  counts: Record<string, number>;
}> {
  const blockers: VerificationIssue[] = [];
  const deltas: VerificationIssue[] = [];
  const links = await completedPairLinks(sourceId, targetId, "containers", "sp_containers");
  const linkMap = new Map(links.map((row) => [pn(row.source_id), pn(row.target_id)]));
  const sourceResult = await db.execute(sql`
    SELECT c.*, s.legal_name AS source_supplier_name
    FROM containers c
    LEFT JOIN suppliers s ON s.id = c.supplier_id
    WHERE c.company_id = ${sourceId}
    ORDER BY c.id ASC
  `);
  const sourceContainers = resultRows(sourceResult);
  const missing = sourceContainers.filter((row) => !linkMap.has(pn(row.id)));
  if (missing.length) {
    deltas.push({
      code: "CONTAINER_COPY_DELTA",
      message: `${missing.length} source container(s) require migration.`,
      count: missing.length,
    });
  }

  let headerDrift = 0;
  let lineDrift = 0;
  let unresolvedSupplier = 0;
  let untrackedTargetLines = 0;
  let otwStateDrift = 0;
  const mismatchMessages: string[] = [];

  for (const sourceContainer of sourceContainers) {
    const sourceContainerId = pn(sourceContainer.id);
    const targetContainerId = linkMap.get(sourceContainerId);
    if (!targetContainerId) continue;
    const targetResult = await db.execute(sql`
      SELECT * FROM sp_containers WHERE id = ${targetContainerId} AND company_id = ${targetId} LIMIT 1
    `);
    const target = firstRow(targetResult);
    if (!target) {
      headerDrift++;
      mismatchMessages.push(
        `Container ${sourceContainer.container_number}: provenance points to a missing target row.`
      );
      continue;
    }
    if (!target.supplier_id) unresolvedSupplier++;

    const poResult = await db.execute(sql`
      SELECT id, po_number, items_total, freight
      FROM purchase_orders WHERE container_id = ${sourceContainerId}
      ORDER BY id DESC LIMIT 1
    `);
    const po = firstRow(poResult) ?? null;
    const expectedStatus = ["otw", "open"].includes(String(sourceContainer.status ?? "").toLowerCase())
      ? "open"
      : "offloaded";
    const expectedInvoice = String(po?.po_number ?? sourceContainer.container_number ?? `GC-${sourceContainerId}`);
    const expectedTotal = pn(po?.items_total ?? sourceContainer.items_total);
    const expectedFreight = pn(po?.freight);
    const drift =
      String(target.status) !== expectedStatus ||
      String(target.invoice_number) !== expectedInvoice ||
      String(target.invoice_date) !== String(sourceContainer.import_date) ||
      numbersDiffer(target.invoice_total_usd, expectedTotal, 0.01) ||
      numbersDiffer(target.freight_estimate_usd, expectedFreight, 0.01);
    if (drift) {
      headerDrift++;
      mismatchMessages.push(
        `Container ${sourceContainer.container_number}: target header/status differs from the source.`
      );
    }

    const sourceLines = await getSourceContainerLines(sourceContainer, po);
    const targetLinesResult = await db.execute(sql`
      SELECT id FROM sp_container_lines
      WHERE company_id = ${targetId} AND container_id = ${targetContainerId}
      ORDER BY id ASC
    `);
    const targetLineIds = resultRows(targetLinesResult).map((row) => pn(row.id));
    const trackedResult = await db.execute(sql`
      SELECT DISTINCT rr.row_id
      FROM sp_migration_run_rows rr
      JOIN sp_migration_rehearsal_runs r ON r.id = rr.run_id
      WHERE rr.table_name = 'sp_container_lines'
        AND r.source_company_id = ${sourceId}
        AND r.target_company_id = ${targetId}
        AND r.status <> 'rolled_back'
        AND rr.row_id = ANY(${sqlArray(targetLineIds.length ? targetLineIds : [-1])})
    `);
    const trackedIds = new Set(resultRows(trackedResult).map((row) => pn(row.row_id)));
    const untracked = targetLineIds.filter((id: number) => !trackedIds.has(id));
    if (untracked.length) untrackedTargetLines += untracked.length;
    if (sourceLines.rows.length !== targetLineIds.length) {
      lineDrift++;
      mismatchMessages.push(
        `Container ${sourceContainer.container_number}: source has ${sourceLines.rows.length} line(s), target has ${targetLineIds.length}.`
      );
    }

    const voucherId = pn(target.goods_otw_voucher_id);
    if (expectedStatus === "open") {
      if (!voucherId) otwStateDrift++;
      else {
        const voucherResult = await db.execute(sql`
          SELECT id FROM vouchers
          WHERE id = ${voucherId} AND company_id = ${targetId} AND deleted_at IS NULL
          LIMIT 1
        `);
        if (!firstRow(voucherResult)) otwStateDrift++;
      }
    } else if (voucherId) {
      const activeVoucher = await db.execute(sql`
        SELECT id FROM vouchers
        WHERE id = ${voucherId} AND company_id = ${targetId} AND deleted_at IS NULL
        LIMIT 1
      `);
      if (firstRow(activeVoucher)) otwStateDrift++;
    }
  }

  if (unresolvedSupplier) {
    blockers.push({
      code: "UNRESOLVED_CONTAINER_SUPPLIER",
      message: `${unresolvedSupplier} migrated container(s) have no resolved supplier link.`,
      count: unresolvedSupplier,
    });
  }
  if (untrackedTargetLines) {
    blockers.push({
      code: "UNTRACKED_CONTAINER_LINES",
      message: `${untrackedTargetLines} target container line(s) are not migration-owned and cannot be rebuilt automatically.`,
      count: untrackedTargetLines,
    });
  }
  if (headerDrift) {
    deltas.push({
      code: "CONTAINER_HEADER_DELTA",
      message: `${headerDrift} container header(s) require final synchronization.`,
      count: headerDrift,
    });
  }
  if (lineDrift) {
    deltas.push({
      code: "CONTAINER_LINE_DELTA",
      message: `${lineDrift} container line set(s) require final rebuilding.`,
      count: lineDrift,
    });
  }
  if (otwStateDrift) {
    deltas.push({
      code: "CONTAINER_OTW_STATE_DELTA",
      message: `${otwStateDrift} container OTW accounting state(s) require final reconciliation.`,
      count: otwStateDrift,
    });
  }

  const supplierVoucherGaps = await getSpSupplierVoucherLinkGapCount(targetId);
  if (supplierVoucherGaps) {
    blockers.push({
      code: "SUPPLIER_VOUCHER_LINK_GAP",
      message: `${supplierVoucherGaps} migrated Goods-OTW voucher supplier link(s) remain inconsistent.`,
      count: supplierVoucherGaps,
    });
  }

  const counts = {
    sourceContainers: sourceContainers.length,
    linkedContainers: links.length,
    headerDrift,
    lineDrift,
    unresolvedSupplier,
    untrackedTargetLines,
    otwStateDrift,
    supplierVoucherGaps,
  };
  const status = blockers.length ? "FAIL" : deltas.length ? "WARN" : "PASS";
  return {
    blockers,
    deltas,
    counts,
    area: {
      area: "Containers and Goods-OTW",
      status,
      detail:
        `${links.length}/${sourceContainers.length} containers linked; ${headerDrift} header drift; ` +
        `${lineDrift} line drift; ${otwStateDrift} OTW-state drift.`,
      mismatches: mismatchMessages.slice(0, 50),
    },
  };
}

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
