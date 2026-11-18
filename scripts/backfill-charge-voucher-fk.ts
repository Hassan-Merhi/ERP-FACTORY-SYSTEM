/**
 * Phase 6 backfill — populate `customer_order_charges.voucher_id` for historical
 * CHARGE-* vouchers that were created before the FK-stamp logic was introduced.
 *
 * Strategy: parse the voucherNumber to derive (orderId|invoiceNumber, chargeId),
 * then UPDATE charges.voucher_id WHERE charges.id matches AND voucher_id IS NULL.
 *
 * Voucher number patterns:
 *   - CHARGE-PRE-{orderId}-{chargeId}                    (PRE / pre-finalize)
 *   - CHARGE-{invoiceNumber}-{chargeId}-{timestamp}      (finalized; new format)
 *   - CHARGE-INV-{invoiceNumberShort}-{chargeId}-{ts}    (legacy alias of above)
 *
 * Usage:
 *   tsx scripts/backfill-charge-voucher-fk.ts            # DRY-RUN
 *   tsx scripts/backfill-charge-voucher-fk.ts --apply    # COMMIT
 */
import { db } from "../server/db";
import { runWithDatabaseMaintenanceScope } from "../server/services/security/databaseScopeRuntimeContext";
import { vouchers, customerOrderCharges, customerOrders } from "../shared/schema";
import { and, eq, isNull, sql } from "drizzle-orm";

const APPLY = process.argv.includes("--apply");

type ChargeVoucher = {
  id: number;
  companyId: number;
  voucherNumber: string;
};

function parseChargeVoucherNumber(
  vn: string,
):
  | { kind: "PRE"; orderId: number; chargeId: number }
  | { kind: "INV"; invoiceNumber: string; chargeId: number }
  | null {
  if (!vn.startsWith("CHARGE-")) return null;
  const parts = vn.split("-");
  // CHARGE - PRE - orderId - chargeId
  if (parts[1] === "PRE" && parts.length >= 4) {
    const orderId = parseInt(parts[2]);
    const chargeId = parseInt(parts[3]);
    if (!isNaN(orderId) && !isNaN(chargeId)) return { kind: "PRE", orderId, chargeId };
    return null;
  }
  // CHARGE - INV - 000001 - chargeId - timestamp  (5+ parts)
  if (parts[1] === "INV" && parts.length >= 5) {
    const invoiceNumber = `INV-${parts[2]}`;
    const chargeId = parseInt(parts[3]);
    if (!isNaN(chargeId)) return { kind: "INV", invoiceNumber, chargeId };
    return null;
  }
  // CHARGE - <freeform-invoice> - chargeId - timestamp
  // chargeId is parts[length-2], timestamp is parts[length-1], invoice is parts[1..length-3].join('-')
  if (parts.length >= 4) {
    const chargeId = parseInt(parts[parts.length - 2]);
    const ts = parts[parts.length - 1];
    if (!isNaN(chargeId) && /^\d{10,}$/.test(ts)) {
      const invoiceNumber = parts.slice(1, parts.length - 2).join("-");
      return { kind: "INV", invoiceNumber, chargeId };
    }
  }
  return null;
}

async function main() {
  console.log(`Backfill charge.voucher_id — mode=${APPLY ? "APPLY" : "DRY-RUN"}`);

  const candidates: ChargeVoucher[] = await db
    .select({ id: vouchers.id, companyId: vouchers.companyId, voucherNumber: vouchers.voucherNumber })
    .from(vouchers)
    .where(sql`${vouchers.voucherNumber} LIKE 'CHARGE-%'`);

  console.log(`Inspecting ${candidates.length} CHARGE-* voucher(s).`);

  let stamped = 0;
  let skippedAlready = 0;
  let skippedNoCharge = 0;
  let skippedAmbiguous = 0;
  let skippedUnparsed = 0;

  for (const v of candidates) {
    const parsed = parseChargeVoucherNumber(v.voucherNumber);
    if (!parsed) {
      skippedUnparsed++;
      continue;
    }

    // Locate the matching charge row. Two cases:
    //   PRE → match by id + orderId
    //   INV → match by id + customer_orders.invoiceNumber (joined)
    let chargeRows;
    if (parsed.kind === "PRE") {
      chargeRows = await db
        .select({ id: customerOrderCharges.id, voucherId: customerOrderCharges.voucherId })
        .from(customerOrderCharges)
        .where(
          and(
            eq(customerOrderCharges.id, parsed.chargeId),
            eq(customerOrderCharges.orderId, parsed.orderId),
          ),
        );
    } else {
      chargeRows = await db
        .select({ id: customerOrderCharges.id, voucherId: customerOrderCharges.voucherId })
        .from(customerOrderCharges)
        .innerJoin(
          customerOrders,
          and(
            eq(customerOrderCharges.orderId, customerOrders.id),
            eq(customerOrders.companyId, v.companyId),
            eq(customerOrders.invoiceNumber, parsed.invoiceNumber),
          ),
        )
        .where(eq(customerOrderCharges.id, parsed.chargeId));
    }

    if (chargeRows.length === 0) {
      skippedNoCharge++;
      continue;
    }
    if (chargeRows.length > 1) {
      skippedAmbiguous++;
      continue;
    }
    // Both queries select the same flat projection, including the joined INV case.
    const charge = chargeRows[0];
    const chargeId = charge.id;
    const existingVoucherId = charge.voucherId;

    if (existingVoucherId === v.id) {
      skippedAlready++;
      continue;
    }
    if (existingVoucherId != null && existingVoucherId !== v.id) {
      // FK already points elsewhere — don't overwrite, log it
      console.warn(
        `  charge#${chargeId}: already linked to voucher#${existingVoucherId}, current voucher is #${v.id} (${v.voucherNumber}) — skipping`,
      );
      skippedAlready++;
      continue;
    }

    if (APPLY) {
      await db
        .update(customerOrderCharges)
        .set({ voucherId: v.id })
        .where(eq(customerOrderCharges.id, chargeId));
    }
    console.log(`  charge#${chargeId} ← voucher#${v.id} (${v.voucherNumber})`);
    stamped++;
  }

  console.log("\n──────── Summary ────────");
  console.log(`Inspected:           ${candidates.length}`);
  console.log(`Stamped:             ${stamped}`);
  console.log(`Already linked:      ${skippedAlready}`);
  console.log(`No matching charge:  ${skippedNoCharge}`);
  console.log(`Ambiguous (>1 row):  ${skippedAmbiguous}`);
  console.log(`Unparsed format:     ${skippedUnparsed}`);
  console.log(`Mode:                ${APPLY ? "APPLY" : "DRY-RUN"}`);

  if (!APPLY) console.log("\nRe-run with --apply to commit changes.");
  process.exit(0);
}

runWithDatabaseMaintenanceScope("script:backfill-charge-voucher-fk", main).catch((err) => {
  console.error("Backfill error:", err);
  process.exit(1);
});
