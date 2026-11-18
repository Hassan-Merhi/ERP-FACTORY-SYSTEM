/**
 * Repair: re-run the post-offload cost cascade for every offloaded
 * container whose landed cost has drifted from the correct value.
 *
 * USAGE
 *   Dry-run (default — no DB writes, shows what would change):
 *     npx tsx scripts/repair-post-offload-cost-cascade.ts
 *     npx tsx scripts/repair-post-offload-cost-cascade.ts --dry-run
 *
 *   Apply (writes to DB, requires explicit confirmation token):
 *     npx tsx scripts/repair-post-offload-cost-cascade.ts --apply --confirm=REPAIR_POST_OFFLOAD_COSTS
 *
 * WHAT THIS SCRIPT DOES
 *   1. Finds all (companyId, containerId) pairs that have post-offload charges.
 *   2. For each eligible container (OFFLOADED / RECEIVED / PARTIALLY_RECEIVED):
 *      a. Calls computeCorrectContainerCost → authoritative landed cost.
 *      b. Compares against stored costPerKg / costPerKgUsd / supplierLockedRate.
 *      c. Dry-run: prints old vs new for every container, marks if a change is needed.
 *      d. Apply:  atomic per-container transaction:
 *         - updates container landed totals
 *         - calls cascadeContainerCostChange → raw-stock → mix-batch sources
 *           → batch weighted-averages → bales
 *   3. NEVER creates, modifies or deletes accounting vouchers.
 *   4. NEVER changes quantities, received kg, payments or supplier balances.
 *   5. Each container is repaired in its own transaction (idempotent on re-run).
 *
 * IMPORTANT: do NOT manually overwrite raw-stock before calling the cascade —
 * the cascade reads the old cost first to compute the supplier-rate value delta.
 */
import { eq, and } from "drizzle-orm";
import Decimal from "decimal.js";
import { db } from "../server/db";
import {
  factoryContainers,
  factoryOffloadAdditionalCharges,
  factoryContainerCommissions,
  factorySuppliers,
} from "@shared/schema";
import { computeCorrectContainerCost } from "../server/services/factory/raw-stock-recalc";
import { cascadeContainerCostChange } from "../server/services/factory/rawStockCostCascade";

// ─── CLI argument parsing ────────────────────────────────────────────────────
const args = process.argv.slice(2);
const isDryRun = !args.includes("--apply");
const confirmToken = args.find((a) => a.startsWith("--confirm="))?.split("=")[1];

if (!isDryRun && confirmToken !== "REPAIR_POST_OFFLOAD_COSTS") {
  console.error("ERROR: --apply requires --confirm=REPAIR_POST_OFFLOAD_COSTS");
  console.error("Run without --apply first to review the dry-run report.");
  process.exit(1);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
const fmt = (n: number | null | undefined, dp = 7) =>
  n == null ? "N/A" : new Decimal(n).toFixed(dp);

const ELIGIBLE_STATUSES = new Set(["OFFLOADED", "RECEIVED", "PARTIALLY_RECEIVED"]);

interface ContainerReport {
  containerId: number;
  companyId: number;
  containerNumber: string;
  status: string;
  oldCostPerKg: number;
  newCostPerKg: number;
  oldCostPerKgUsd: number;
  newCostPerKgUsd: number;
  oldLockedRate: number | null;
  changeNeeded: boolean;
  skippedReason?: string;
  appliedOk?: boolean;
  rawStockRows?: number;
  openBatches?: number;
  completedBatches?: number;
  bales?: number;
}

// ─── Main ────────────────────────────────────────────────────────────────────
async function main() {
  console.log("═══════════════════════════════════════════════════════════════");
  console.log(`  Post-offload cost cascade repair  [${isDryRun ? "DRY-RUN" : "APPLY"}]`);
  console.log("═══════════════════════════════════════════════════════════════\n");

  // 1. Find every (companyId, containerId) pair that has post-offload charges.
  const chargeRows = await db
    .selectDistinct({
      containerId: factoryOffloadAdditionalCharges.containerId,
      companyId: factoryOffloadAdditionalCharges.companyId,
    })
    .from(factoryOffloadAdditionalCharges);

  if (chargeRows.length === 0) {
    console.log("No containers with post-offload charges found. Nothing to repair.");
    process.exit(0);
  }

  console.log(`Found ${chargeRows.length} container(s) with post-offload charges.\n`);

  const reports: ContainerReport[] = [];

  // 2. Collect dry-run data (and optionally apply) for each container.
  for (const { companyId, containerId } of chargeRows) {
    // Load container
    const [container] = await db
      .select()
      .from(factoryContainers)
      .where(and(eq(factoryContainers.id, containerId), eq(factoryContainers.companyId, companyId)));

    if (!container) {
      reports.push({
        containerId,
        companyId,
        containerNumber: `#${containerId}`,
        status: "UNKNOWN",
        oldCostPerKg: 0,
        newCostPerKg: 0,
        oldCostPerKgUsd: 0,
        newCostPerKgUsd: 0,
        oldLockedRate: null,
        changeNeeded: false,
        skippedReason: "not found",
      });
      continue;
    }

    if (!ELIGIBLE_STATUSES.has(container.status || "")) {
      reports.push({
        containerId,
        companyId,
        containerNumber: container.containerNumber || `#${containerId}`,
        status: container.status || "UNKNOWN",
        oldCostPerKg: parseFloat(container.ratePerKgUsd || "0"),
        newCostPerKg: 0,
        oldCostPerKgUsd: parseFloat(container.ratePerKgUsd || "0"),
        newCostPerKgUsd: 0,
        oldLockedRate: null,
        changeNeeded: false,
        skippedReason: `status=${container.status} (not eligible)`,
      });
      continue;
    }

    // Load post-offload charges + commission
    const [additionalCharges, commissionRows] = await Promise.all([
      db
        .select()
        .from(factoryOffloadAdditionalCharges)
        .where(
          and(
            eq(factoryOffloadAdditionalCharges.containerId, containerId),
            eq(factoryOffloadAdditionalCharges.companyId, companyId)
          )
        ),
      db
        .select()
        .from(factoryContainerCommissions)
        .where(
          and(
            eq(factoryContainerCommissions.containerId, containerId),
            eq(factoryContainerCommissions.companyId, companyId)
          )
        ),
    ]);
    const commissionRecord = commissionRows[0] || null;

    // Load supplier locked rate
    let oldLockedRate: number | null = null;
    if (container.supplierId) {
      const [sup] = await db
        .select({ rate: factorySuppliers.currentRawMaterialCostPerKgUsd })
        .from(factorySuppliers)
        .where(
          and(
            eq(factorySuppliers.id, container.supplierId),
            eq(factorySuppliers.companyId, companyId)
          )
        );
      oldLockedRate = sup?.rate != null ? parseFloat(sup.rate as string) : null;
    }

    const oldCostPerKgUsd = parseFloat(container.ratePerKgUsd || "0");

    // Compute correct cost
    const result = computeCorrectContainerCost(container, additionalCharges, commissionRecord);

    if (result.fxUnresolved) {
      reports.push({
        containerId,
        companyId,
        containerNumber: container.containerNumber || `#${containerId}`,
        status: container.status || "UNKNOWN",
        oldCostPerKg: parseFloat(container.ratePerKg || "0"),
        newCostPerKg: 0,
        oldCostPerKgUsd,
        newCostPerKgUsd: 0,
        oldLockedRate,
        changeNeeded: false,
        skippedReason: "FX rate unresolved — set the container exchange rate first",
      });
      continue;
    }

    const changeNeeded = Math.abs(result.costPerKgUsd - oldCostPerKgUsd) > 0.000001;

    const report: ContainerReport = {
      containerId,
      companyId,
      containerNumber: container.containerNumber || `#${containerId}`,
      status: container.status || "UNKNOWN",
      oldCostPerKg: parseFloat(container.ratePerKg || "0"),
      newCostPerKg: result.costPerKg,
      oldCostPerKgUsd,
      newCostPerKgUsd: result.costPerKgUsd,
      oldLockedRate,
      changeNeeded,
    };

    if (!isDryRun && changeNeeded) {
      // Apply atomically
      try {
        const cascadeResult = await db.transaction(async (tx) => {
          await tx
            .update(factoryContainers)
            .set({
              ratePerKg: String(result.costPerKg),
              ratePerKgUsd: String(result.costPerKgUsd),
              finalPayableAmount: String(result.totalCost),
              finalPayableAmountUsd: String(result.totalUsd),
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(factoryContainers.id, containerId),
                eq(factoryContainers.companyId, companyId)
              )
            );
          return cascadeContainerCostChange(
            tx,
            {
              companyId,
              containerId,
              newCostPerKg: result.costPerKg,
              newCostPerKgUsd: result.costPerKgUsd,
            },
            { includeCompletedBatches: true }
          );
        });

        const openBatches = cascadeResult.affectedBatches.filter((b) => !b.wasCompleted).length;
        const completedBatches = cascadeResult.affectedBatches.filter((b) => b.wasCompleted).length;

        report.appliedOk = true;
        report.rawStockRows = cascadeResult.rawStockRowsUpdated;
        report.openBatches = openBatches;
        report.completedBatches = completedBatches;
        report.bales = cascadeResult.affectedBales.length;
      } catch (err: unknown) {
        report.appliedOk = false;
        report.skippedReason = `APPLY ERROR: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    reports.push(report);
  }

  // 3. Print per-container report table.
  const colW = 18;
  const hdr = (s: string) => s.padEnd(colW).slice(0, colW);
  console.log(
    [
      hdr("Container"),
      hdr("Status"),
      hdr("Old USD/kg"),
      hdr("New USD/kg"),
      hdr("Locked rate"),
      hdr("Change?"),
      "Skipped / Applied",
    ].join("  ")
  );
  console.log("─".repeat(140));

  let needsChange = 0;
  let skippedCount = 0;
  let appliedOk = 0;
  let appliedFail = 0;

  for (const r of reports) {
    const change = r.changeNeeded ? "YES" : "no";
    const suffix = r.skippedReason
      ? `SKIPPED: ${r.skippedReason}`
      : r.appliedOk === true
      ? `APPLIED (rawStock=${r.rawStockRows}, openBatches=${r.openBatches}, completedBatches=${r.completedBatches}, bales=${r.bales})`
      : r.appliedOk === false
      ? `FAILED: ${r.skippedReason}`
      : "";
    console.log(
      [
        hdr(r.containerNumber),
        hdr(r.status),
        hdr(fmt(r.oldCostPerKgUsd, 4)),
        hdr(fmt(r.newCostPerKgUsd, 4)),
        hdr(fmt(r.oldLockedRate, 4)),
        hdr(change),
        suffix,
      ].join("  ")
    );
    if (r.changeNeeded) needsChange++;
    if (r.skippedReason && !r.appliedOk) skippedCount++;
    if (r.appliedOk === true) appliedOk++;
    if (r.appliedOk === false) appliedFail++;
  }

  // 4. Reconciliation summary.
  console.log("\n" + "═".repeat(80));
  console.log("  RECONCILIATION SUMMARY");
  console.log("─".repeat(80));
  console.log(`  Total containers with post-offload charges : ${chargeRows.length}`);
  console.log(`  Containers needing a cost correction       : ${needsChange}`);
  console.log(`  Containers skipped / not eligible          : ${skippedCount}`);
  if (!isDryRun) {
    console.log(`  Containers applied successfully            : ${appliedOk}`);
    console.log(`  Containers failed                          : ${appliedFail}`);
    if (needsChange - appliedOk - appliedFail > 0) {
      console.log(`  Containers still needing repair            : ${needsChange - appliedOk - appliedFail}`);
    }
    if (appliedFail > 0) {
      console.log("\n  *** SOME CONTAINERS FAILED — re-run to retry ***");
      process.exit(2);
    }
    if (needsChange > 0 && appliedOk === needsChange) {
      console.log("\n  ✓ All corrections applied. Run dry-run again to verify zero remaining differences.");
    }
  } else {
    console.log("\n  This was a DRY-RUN — no changes were written to the database.");
    if (needsChange > 0) {
      console.log(`  Run with --apply --confirm=REPAIR_POST_OFFLOAD_COSTS to fix ${needsChange} container(s).`);
    } else {
      console.log("  No corrections needed — database is already consistent.");
    }
  }
  console.log("═".repeat(80) + "\n");

  process.exit(0);
}

main().catch((err) => {
  console.error("Unhandled error:", err);
  process.exit(1);
});
