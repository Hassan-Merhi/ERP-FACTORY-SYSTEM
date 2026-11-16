/**
 * Repair: fix incorrect commission FX rates on factory containers.
 *
 * A commission can be denominated in a currency different from both USD and
 * the container currency. Before this fix, the offload route used the container's
 * own fxRateToUsd for such commissions, producing a wrong commissionTotalUsd.
 *
 * USAGE
 *   Dry-run (default — no DB writes, shows what would change):
 *     npx tsx scripts/repair-factory-commission-fx.ts
 *     npx tsx scripts/repair-factory-commission-fx.ts --dry-run
 *
 *   Apply (writes to DB, requires explicit confirmation):
 *     npx tsx scripts/repair-factory-commission-fx.ts --apply --confirm=REPAIR_COMMISSION_FX
 *
 * WHAT THIS SCRIPT DOES
 *   For each offloaded container with a non-USD commission in factoryContainerCommissions:
 *   1. Check whether the stored commissionTotalUsd = commissionTotal × fxRateToUsd is correct.
 *   2. Check whether commissionFxRateToUsd on the container matches the commission record.
 *   3. If the commission currency differs from the container currency and the stored
 *      fxRateToUsd equals the container's fxRateToUsd (the canonical bug), flag as wrong.
 *   4. Resolve the correct rate from exchange_rates for the offload date.
 *   5. Apply mode (each container in its own transaction, idempotent):
 *      a. Update factoryContainerCommissions: fxRateToUsd, fxRateConfirmed, commissionTotalUsd.
 *      b. Update factoryContainers: commissionFxRateToUsd, commissionFxRateConfirmed, commissionFxRateDate.
 *      c. Recompute container landed cost via computeCorrectContainerCost.
 *      d. Cascade corrected cost through raw stock → mix-batch sources → batches → bales.
 *
 * NEVER touches quantities, received kg, payments, or voucher native amounts.
 */
import { eq, and, inArray, isNotNull, ne } from "drizzle-orm";
import Decimal from "decimal.js";
import { pool, db } from "../server/db";
import {
  factoryContainers,
  factoryContainerCommissions,
  factoryOffloadAdditionalCharges,
  factoryRawStock,
} from "@shared/schema";
import { computeCorrectContainerCost } from "../server/services/factory/raw-stock-recalc";
import { cascadeContainerCostChange } from "../server/services/factory/rawStockCostCascade";

// ─── CLI argument parsing ─────────────────────────────────────────────────────
const args = process.argv.slice(2);
const isDryRun = !args.includes("--apply");
const confirmToken = args.find((a) => a.startsWith("--confirm="))?.split("=")[1];

if (!isDryRun && confirmToken !== "REPAIR_COMMISSION_FX") {
  console.error("ERROR: --apply requires --confirm=REPAIR_COMMISSION_FX");
  console.error("Run without --apply first to review the dry-run report.");
  process.exit(1);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
const fmt6 = (n: number | string | null | undefined) =>
  n == null ? "N/A" : new Decimal(String(n)).toFixed(6);

const fmt2 = (n: number | string | null | undefined) =>
  n == null ? "N/A" : new Decimal(String(n)).toFixed(2);

/** Look up the exchange_rates table for a given currency and date. */
async function resolveStoredRate(
  currencyCode: string,
  date: string
): Promise<{ rate: number; source: string } | null> {
  const rows = await pool.query(
    `SELECT rate, effective_date FROM exchange_rates
      WHERE currency_code = $1 AND effective_date <= $2
      ORDER BY effective_date DESC LIMIT 1`,
    [currencyCode.toUpperCase(), date]
  );
  if (!rows.rows.length) return null;
  const rate = parseFloat(rows.rows[0].rate);
  return Number.isFinite(rate) && rate > 0
    ? { rate, source: String(rows.rows[0].effective_date) }
    : null;
}

/** Determine whether the stored commission FX is "the container FX applied by mistake". */
function isWrongFx(
  commCcy: string,
  containerCcy: string,
  storedCommFx: string | null,
  containerFx: string | null,
  commConfirmed: boolean
): boolean {
  if (commCcy === "USD" || commCcy === containerCcy.toUpperCase()) return false; // expected
  if (!commConfirmed) return true; // never confirmed → wrong
  if (!storedCommFx || !containerFx) return true;
  const cfx = parseFloat(containerFx);
  const sfx = parseFloat(storedCommFx);
  if (!Number.isFinite(cfx) || !Number.isFinite(sfx)) return true;
  // If the stored commission FX equals the container FX within 0.01%, flag it —
  // the canonical bug was using the container rate for a different-currency commission.
  return Math.abs(sfx - cfx) / (cfx || 1) < 0.0001;
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log("═══════════════════════════════════════════════════════════════");
  console.log(`  Commission FX repair  [${isDryRun ? "DRY-RUN" : "APPLY"}]`);
  console.log("═══════════════════════════════════════════════════════════════\n");

  // Load all commission records for offloaded containers
  const commRows = await db
    .select()
    .from(factoryContainerCommissions)
    .orderBy(factoryContainerCommissions.containerId);

  console.log(`Found ${commRows.length} commission record(s) total.\n`);

  interface Report {
    containerNumber: string;
    companyId: number;
    containerId: number;
    containerCcy: string;
    containerFx: string;
    commCcy: string;
    oldCommFx: string;
    correctCommFx: string | null;
    nativeAmt: string;
    oldCommUsd: string;
    newCommUsd: string | null;
    oldCostPerKgUsd: string;
    newCostPerKgUsd: string | null;
    affectedBatches: number;
    affectedBales: number;
    skippedReason?: string;
    appliedOk?: boolean;
  }
  const reports: Report[] = [];

  for (const comm of commRows) {
    const containerId: number = comm.containerId;
    const companyId: number = comm.companyId;
    const commCcy: string = (comm.currencyCode || "USD").toUpperCase();

    // Load container
    const [container] = await db
      .select()
      .from(factoryContainers)
      .where(and(eq(factoryContainers.id, containerId), eq(factoryContainers.companyId, companyId)));

    if (!container) {
      reports.push({
        containerNumber: `ID#${containerId}`,
        companyId,
        containerId,
        containerCcy: "?",
        containerFx: "?",
        commCcy,
        oldCommFx: String(comm.fxRateToUsd ?? "?"),
        correctCommFx: null,
        nativeAmt: String(comm.commissionTotal),
        oldCommUsd: String(comm.commissionTotalUsd ?? "?"),
        newCommUsd: null,
        oldCostPerKgUsd: "?",
        newCostPerKgUsd: null,
        affectedBatches: 0,
        affectedBales: 0,
        skippedReason: "Container not found",
      });
      continue;
    }

    const containerCcy = (container.currencyCode || "USD").toUpperCase();
    const containerFx = container.fxRateToUsd ?? "1";

    // Skip containers that are not yet offloaded
    const offloadedStatuses = ["OFFLOADED", "RECEIVED", "PARTIALLY_RECEIVED"];
    if (!offloadedStatuses.includes(container.status || "")) {
      reports.push({
        containerNumber: container.containerNumber,
        companyId,
        containerId,
        containerCcy,
        containerFx,
        commCcy,
        oldCommFx: String(comm.fxRateToUsd ?? "?"),
        correctCommFx: null,
        nativeAmt: String(comm.commissionTotal),
        oldCommUsd: String(comm.commissionTotalUsd ?? "?"),
        newCommUsd: null,
        oldCostPerKgUsd: "?",
        newCostPerKgUsd: null,
        affectedBatches: 0,
        affectedBales: 0,
        skippedReason: `Not offloaded (status: ${container.status})`,
      });
      continue;
    }

    // Skip USD commissions — fxRate=1 is always correct
    if (commCcy === "USD") continue;

    // Check if the commission FX looks wrong
    const commConfirmed: boolean = comm.fxRateConfirmed === true;
    const storedCommFx: string = String(comm.fxRateToUsd ?? "");
    const looksWrong = isWrongFx(commCcy, containerCcy, storedCommFx, containerFx, commConfirmed);

    // Also flag if commissionTotalUsd ≠ commissionTotal × fxRateToUsd (rounding tolerance 0.01)
    const nativeAmt = parseFloat(comm.commissionTotal || "0");
    const storedFxNum = parseFloat(storedCommFx);
    const storedUsd = parseFloat(comm.commissionTotalUsd || "0");
    const expectedUsd = nativeAmt * storedFxNum;
    const usdMismatch = Math.abs(storedUsd - expectedUsd) > 0.01;

    if (!looksWrong && !usdMismatch) continue; // already correct

    // Determine the offload date for FX lookup
    const rawStockRows = await pool.query(
      `SELECT received_at FROM factory_raw_stock WHERE container_id = $1 AND company_id = $2 LIMIT 1`,
      [containerId, companyId]
    );
    const offloadDate: string =
      rawStockRows.rows[0]?.received_at
        ? new Date(rawStockRows.rows[0].received_at).toISOString().split("T")[0]
        : new Date().toISOString().split("T")[0];

    // Resolve the correct commission FX
    let correctRate: { rate: number; source: string } | null = null;
    if (commCcy === containerCcy) {
      // Same currency: use the container's confirmed FX
      const cfx = parseFloat(containerFx);
      if (Number.isFinite(cfx) && cfx > 0) correctRate = { rate: cfx, source: "container-fx" };
    } else {
      correctRate = await resolveStoredRate(commCcy, offloadDate);
    }

    // Load current raw stock for cost comparison
    const rawStockRow = await pool.query(
      `SELECT cost_per_kg, cost_per_kg_usd FROM factory_raw_stock WHERE container_id = $1 AND company_id = $2 LIMIT 1`,
      [containerId, companyId]
    );
    const currentCostPerKgUsd = rawStockRow.rows[0]?.cost_per_kg_usd ?? "?";

    // Load additional charges for computeCorrectContainerCost
    const addlCharges = await db
      .select()
      .from(factoryOffloadAdditionalCharges)
      .where(
        and(
          eq(factoryOffloadAdditionalCharges.containerId, containerId),
          eq(factoryOffloadAdditionalCharges.companyId, companyId)
        )
      );

    // Compute what the corrected cost WOULD be
    let newCommUsd: string | null = null;
    let newCostPerKgUsd: string | null = null;
    if (correctRate) {
      const simCommRecord = {
        ...comm,
        fxRateToUsd: String(correctRate.rate),
        fxRateConfirmed: true,
      };
      const corrected = computeCorrectContainerCost(container, addlCharges, simCommRecord);
      newCommUsd = fmt2(nativeAmt * correctRate.rate);
      newCostPerKgUsd = fmt6(corrected.costPerKgUsd);
    }

    // Count affected batches and bales
    const batchCountRes = await pool.query(
      `SELECT COUNT(DISTINCT mb.id) AS batches, COUNT(DISTINCT b.id) AS bales
         FROM factory_mix_batch_sources mbs
         JOIN factory_mix_batches mb ON mb.id = mbs.mix_batch_id
         LEFT JOIN factory_bales b ON b.mix_batch_id = mb.id AND b.deleted_at IS NULL
        WHERE mbs.container_id = $1 AND mb.company_id = $2`,
      [containerId, companyId]
    );
    const affectedBatches = parseInt(batchCountRes.rows[0]?.batches ?? "0");
    const affectedBales = parseInt(batchCountRes.rows[0]?.bales ?? "0");

    const report: Report = {
      containerNumber: container.containerNumber,
      companyId,
      containerId,
      containerCcy,
      containerFx,
      commCcy,
      oldCommFx: storedCommFx,
      correctCommFx: correctRate ? String(correctRate.rate) : null,
      nativeAmt: fmt2(nativeAmt),
      oldCommUsd: fmt2(storedUsd),
      newCommUsd,
      oldCostPerKgUsd: fmt6(currentCostPerKgUsd),
      newCostPerKgUsd,
      affectedBatches,
      affectedBales,
      skippedReason: correctRate ? undefined : `No ${commCcy}/USD rate found for ${offloadDate}`,
    };
    reports.push(report);

    if (!isDryRun && correctRate && !report.skippedReason) {
      try {
        await db.transaction(async (tx) => {
          const correctFxStr = String(correctRate!.rate);
          const newCommTotalUsd = new Decimal(nativeAmt).times(correctRate!.rate).toFixed(4);

          // 1. Update factoryContainerCommissions
          await tx
            .update(factoryContainerCommissions)
            .set({
              fxRateToUsd: correctFxStr,
              fxRateConfirmed: true,
              commissionTotalUsd: newCommTotalUsd,
            })
            .where(eq(factoryContainerCommissions.id, comm.id));

          // 2. Update container commission FX snapshot
          await tx
            .update(factoryContainers)
            .set({
              commissionFxRateToUsd: correctFxStr,
              commissionFxRateConfirmed: true,
              commissionFxRateDate: offloadDate,
            } as any)
            .where(eq(factoryContainers.id, containerId));

          // 3. Recompute and cascade
          const refreshedContainer = await tx
            .select()
            .from(factoryContainers)
            .where(eq(factoryContainers.id, containerId))
            .limit(1);

          const correctedComm = { ...comm, fxRateToUsd: correctFxStr, fxRateConfirmed: true };
          if (!refreshedContainer[0]) throw new Error(`Container #${containerId} not found after FX update`);
          const correctedCost = computeCorrectContainerCost(
            refreshedContainer[0],
            addlCharges,
            correctedComm
          );

          await cascadeContainerCostChange(tx, {
            containerId,
            companyId,
            newCostPerKg: correctedCost.costPerKg,
            newCostPerKgUsd: correctedCost.costPerKgUsd,
            newTotalCost: correctedCost.totalCost,
            newTotalUsd: correctedCost.totalUsd,
          });
        });
        report.appliedOk = true;
      } catch (err: unknown) {
        report.appliedOk = false;
        report.skippedReason = `Apply error: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
  }

  // ─── Print report ─────────────────────────────────────────────────────────
  console.log("Container         ContCCY  ContFX  CommCCY  Old CommFX  New CommFX  Native     Old USD    New USD    Old Cost/kg(USD)  New Cost/kg(USD)  Batches  Bales  Status");
  console.log("─".repeat(195));
  for (const r of reports) {
    const status = r.skippedReason
      ? `SKIP: ${r.skippedReason}`
      : isDryRun
        ? r.correctCommFx !== r.oldCommFx ? "NEEDS REPAIR" : "OK"
        : r.appliedOk
          ? "APPLIED"
          : "FAILED";
    console.log(
      `${r.containerNumber.padEnd(18)} ${r.containerCcy.padEnd(8)} ${String(r.containerFx).substring(0, 6).padEnd(8)} ${r.commCcy.padEnd(8)} ${r.oldCommFx.substring(0, 10).padEnd(12)} ${(r.correctCommFx ?? "N/A").substring(0, 10).padEnd(12)} ${r.nativeAmt.padEnd(11)} ${r.oldCommUsd.padEnd(11)} ${(r.newCommUsd ?? "N/A").padEnd(11)} ${r.oldCostPerKgUsd.padEnd(17)} ${(r.newCostPerKgUsd ?? "N/A").padEnd(18)} ${String(r.affectedBatches).padEnd(9)} ${String(r.affectedBales).padEnd(7)} ${status}`
    );
  }

  const actionable = reports.filter((r) => !r.skippedReason);
  const needsRepair = actionable.filter((r) => r.correctCommFx !== r.oldCommFx);
  const applied = isDryRun ? 0 : actionable.filter((r) => r.appliedOk).length;
  const failed = isDryRun ? 0 : actionable.filter((r) => r.appliedOk === false).length;

  console.log("\n" + "═".repeat(80));
  console.log("  RECONCILIATION SUMMARY");
  console.log("─".repeat(80));
  console.log(`  Total commission records scanned          : ${reports.length}`);
  console.log(`  Records with potentially wrong FX         : ${needsRepair.length}`);
  console.log(`  Skipped (no rate / not offloaded / other) : ${reports.filter((r) => r.skippedReason).length}`);
  if (!isDryRun) {
    console.log(`  Applied successfully                       : ${applied}`);
    console.log(`  Failed to apply                            : ${failed}`);
  }
  console.log();
  if (isDryRun) {
    console.log("  This was a DRY-RUN — no changes were written to the database.");
    if (needsRepair.length === 0) {
      console.log("  No commission FX corrections needed — database is already consistent.");
    } else {
      console.log(`  Re-run with --apply --confirm=REPAIR_COMMISSION_FX to apply corrections.`);
    }
  }
  console.log("═".repeat(80) + "\n");
  process.exit(0);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
