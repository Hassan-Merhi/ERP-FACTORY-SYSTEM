import { logger } from "../../lib/logger";
import type { Request, Response, NextFunction } from "express";
import { db } from "../../db";
import { storage } from "../../storage";
import { vouchers, voucherEntries, intercompanyPosConfigs } from "@shared/schema";
import { eq, and, or, sql, like } from "drizzle-orm";
import type { DatabaseOrTransaction } from "../../db";
import type Decimal from "decimal.js";
import { toMoney, type MoneyInput } from "../../lib/money";

// ──────────────────────────────────────────────────────────────────────────────
// Centralised PO amount calculator — single source of truth for gross/interco
// totals. All PATCH routes and repair endpoints call this so the formula
// cannot drift between them.
// ──────────────────────────────────────────────────────────────────────────────
interface PoAmounts {
  grossTotal: number; // full gross — used for local subsidiary voucher
  intercoTotal: number; // supplier share — used for INTERCO-PARENT voucher
  freightPaidBy: string;
  freight: number;
}

type PoAmountFields = {
  itemsTotal?: MoneyInput;
  freight?: MoneyInput;
  surcharge?: MoneyInput;
  fumigation?: MoneyInput;
  documentCharges?: MoneyInput;
  discount?: MoneyInput;
  otherCharges?: MoneyInput;
  freightPaidBy?: string | null;
};

type EntryAmounts = { debitAmount: string | null; creditAmount: string | null };
/** A voucher entry that only debits. */
export const isDebitOnlyEntry = (e: EntryAmounts) => toMoney(e.debitAmount).gt(0) && toMoney(e.creditAmount).isZero();
/** A voucher entry that only credits. */
export const isCreditOnlyEntry = (e: EntryAmounts) => toMoney(e.creditAmount).gt(0) && toMoney(e.debitAmount).isZero();
/** Differs by more than a tenth of a cent, the tolerance the PO voucher repairs use. */
export const differsByMoreThanTolerance = (a: Decimal, b: Decimal) => a.minus(b).abs().gt("0.001");

/** calcPoAmounts as exact decimals, for callers that store or compare the totals. */
export function calcPoAmountsExact(po: PoAmountFields): {
  grossTotal: Decimal;
  intercoTotal: Decimal;
  freightPaidBy: string;
  freight: Decimal;
} {
  const freight = toMoney(po.freight);
  const freightPaidBy = po.freightPaidBy ?? "supplier";
  const grossTotal = toMoney(po.itemsTotal)
    .plus(freight)
    .plus(toMoney(po.surcharge))
    .plus(toMoney(po.fumigation))
    .plus(toMoney(po.documentCharges))
    .minus(toMoney(po.discount))
    .plus(toMoney(po.otherCharges));
  // intercoTotal is the supplier's share: excludes freight when it's paid
  // by the subsidiary itself ("own") or by the parent company ("parent").
  const intercoTotal =
    (freightPaidBy === "own" || freightPaidBy === "parent") && freight.gt(0) ? grossTotal.minus(freight) : grossTotal;
  return { grossTotal, intercoTotal, freightPaidBy, freight };
}

export function calcPoAmounts(po: PoAmountFields): PoAmounts {
  const exact = calcPoAmountsExact(po);
  return {
    grossTotal: exact.grossTotal.toNumber(),
    intercoTotal: exact.intercoTotal.toNumber(),
    freightPaidBy: exact.freightPaidBy,
    freight: exact.freight.toNumber(),
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Inter-company sync helper
// When a subsidiary PO is edited (amount or container number), the matching
// INTERCO-PARENT-{poNumber} voucher in the parent company must also be updated.
// Only writes to the DB when the stored amount actually differs (idempotent).
// ──────────────────────────────────────────────────────────────────────────────
interface SyncIntercoResult {
  found: boolean;
  updated: boolean;
  voucherId?: number;
  amount: string;
  oldAmount?: string;
}

type IntercoFreightOpts = {
  freightAmount: MoneyInput;
  freightParentAccountId: number;
  subsidiaryCompanyId?: number; // needed for fallback freight journal when no INTERCO-PARENT exists
};

export async function syncIntercoParentVoucher(
  dbOrTx: DatabaseOrTransaction,
  poNumbers: string | string[],
  grossTotal: MoneyInput,
  containerNumber?: string,
  freightOpts?: IntercoFreightOpts
): Promise<SyncIntercoResult> {
  // A voucher's entry rewrites must commit together (balanced-voucher check runs at COMMIT).
  if ("rollback" in dbOrTx) {
    return syncIntercoParentVoucherOn(dbOrTx, poNumbers, grossTotal, containerNumber, freightOpts);
  }
  try {
    return await dbOrTx.transaction((tx) =>
      syncIntercoParentVoucherOn(tx, poNumbers, grossTotal, containerNumber, freightOpts)
    );
  } catch (err) {
    logger.error("[syncIntercoParentVoucher] Error syncing parent INTERCO voucher:", { error: err });
    return { found: false, updated: false, amount: toMoney(grossTotal).toFixed(2) };
  }
}

async function syncIntercoParentVoucherOn(
  dbOrTx: DatabaseOrTransaction,
  poNumbers: string | string[],
  grossTotal: MoneyInput,
  containerNumber?: string,
  freightOpts?: IntercoFreightOpts
): Promise<SyncIntercoResult> {
  // Amounts stay exact: numeric(20, 2) totals above about 10^15 have no cents left as numbers.
  const gross = toMoney(grossTotal);
  const freight = toMoney(freightOpts?.freightAmount);
  const hasFreight = !!freightOpts && freight.greaterThan(0);
  const amountStr = gross.toFixed(2);
  const intercoTotal = hasFreight ? gross.minus(freight) : gross;
  try {
    const parentCompanyId = await storage.getParentCompanyId();
    if (!parentCompanyId) return { found: false, updated: false, amount: amountStr };

    const nums = Array.isArray(poNumbers) ? poNumbers.filter(Boolean) : [poNumbers];

    // Build OR condition across all provided PO number patterns.
    // Three naming conventions exist depending on which creation path was used:
    //   INTERCO-PARENT-{n}-{ts}  — storage.ts / adminRoutes.ts
    //   INTERCO-{n}-{ts}         — adminRoutes.ts (older path)
    //   IC-{childCompanyId}-{n}-{ts} — importRoutes.ts (container import flow)
    const likeConditions = nums.flatMap((n) => [
      like(vouchers.voucherNumber, `INTERCO-PARENT-${n}-%`),
      like(vouchers.voucherNumber, `INTERCO-${n}-%`),
      like(vouchers.voucherNumber, `IC-%-${n}-%`),
    ]);
    const patternClause = likeConditions.length === 1 ? likeConditions[0] : or(...likeConditions);

    // Locate the parent INTERCO voucher for this specific container.
    // Two description formats exist depending on which creation path was used:
    //   A) Container-based:  description starts with the container number
    //      e.g. "CAJU5262333 EUROGULF"
    //   B) PO-based:         description is generic "Inter-company credit: …"
    //      but the entry NARRATION contains "- Container EMCU7265605"
    // We try format A first (description LIKE), then fall back to format B
    // (entry narration LIKE) so both paths are handled.
    let parentVoucher: { id: number; totalAmount: string | null } | undefined;
    if (containerNumber) {
      // Format A: container number in description
      const [byDesc] = await dbOrTx
        .select({ id: vouchers.id, totalAmount: vouchers.totalAmount })
        .from(vouchers)
        .where(
          and(
            eq(vouchers.companyId, parentCompanyId),
            patternClause,
            like(vouchers.description, `%${containerNumber}%`)
          )
        )
        .limit(1);
      if (byDesc) {
        parentVoucher = byDesc;
      } else {
        // Format B: container number in entry narration
        const [byNarration] = await dbOrTx
          .select({ id: vouchers.id, totalAmount: vouchers.totalAmount })
          .from(vouchers)
          .innerJoin(voucherEntries, eq(voucherEntries.voucherId, vouchers.id))
          .where(
            and(
              eq(vouchers.companyId, parentCompanyId),
              patternClause,
              like(voucherEntries.narration, `%${containerNumber}%`)
            )
          )
          .limit(1);
        parentVoucher = byNarration;
      }
    } else {
      const [byPo] = await dbOrTx
        .select({ id: vouchers.id, totalAmount: vouchers.totalAmount })
        .from(vouchers)
        .where(and(eq(vouchers.companyId, parentCompanyId), patternClause))
        .limit(1);
      parentVoucher = byPo;
    }

    if (!parentVoucher) {
      // ── Fallback: no INTERCO-PARENT voucher exists for this PO.
      // When freight opts + subsidiary company ID are provided, create (or update) a
      // standalone PARENT-FREIGHT- journal in the parent company so the freight
      // is still credited to the configured account.
      if (
        freightOpts &&
        hasFreight &&
        freightOpts.subsidiaryCompanyId &&
        freightOpts.subsidiaryCompanyId !== parentCompanyId
      ) {
        try {
          const primaryPoNum = nums[0];
          const fallbackVoucherNum = `PARENT-FREIGHT-${primaryPoNum}`;
          const freightAmtStr = freight.toFixed(2);

          // Look up the interco config to get the subsidiary receivable account (DR side).
          const [icCfg] = await dbOrTx
            .select({ destIntercoAccountId: intercompanyPosConfigs.destIntercoAccountId })
            .from(intercompanyPosConfigs)
            .where(eq(intercompanyPosConfigs.sourceCompanyId, freightOpts.subsidiaryCompanyId))
            .limit(1);
          const drAccountId = icCfg?.destIntercoAccountId ?? null;

          // Check if fallback voucher already exists (idempotent).
          const [existingFallback] = await dbOrTx
            .select({ id: vouchers.id })
            .from(vouchers)
            .where(and(eq(vouchers.companyId, parentCompanyId), eq(vouchers.voucherNumber, fallbackVoucherNum)))
            .limit(1);

          if (existingFallback) {
            // Update existing fallback voucher entries.
            await dbOrTx
              .update(vouchers)
              .set({ totalAmount: freightAmtStr })
              .where(eq(vouchers.id, existingFallback.id));
            const fbEntries = await dbOrTx
              .select()
              .from(voucherEntries)
              .where(eq(voucherEntries.voucherId, existingFallback.id));
            for (const fe of fbEntries) {
              if (toMoney(fe.debitAmount).greaterThan(0)) {
                await dbOrTx
                  .update(voucherEntries)
                  .set({ debitAmount: freightAmtStr })
                  .where(eq(voucherEntries.id, fe.id));
              } else if (toMoney(fe.creditAmount).greaterThan(0)) {
                await dbOrTx
                  .update(voucherEntries)
                  .set({
                    creditAmount: freightAmtStr,
                    ledgerAccountId: freightOpts.freightParentAccountId,
                    narration: `Freight - ${nums.join(", ")}${containerNumber ? ` (${containerNumber})` : ""}`,
                  })
                  .where(eq(voucherEntries.id, fe.id));
              }
            }
            logger.info(
              `[syncIntercoParentVoucher] Updated fallback PARENT-FREIGHT journal #${existingFallback.id} for PO(s) ${nums.join(", ")}`
            );
            return { found: true, updated: true, voucherId: existingFallback.id, amount: freightAmtStr };
          } else {
            // Create new fallback voucher.
            const today = new Date().toISOString().split("T")[0];
            const [newFV] = await dbOrTx
              .insert(vouchers)
              .values({
                companyId: parentCompanyId,
                voucherNumber: fallbackVoucherNum,
                voucherType: "Journal",
                voucherDate: today,
                description: `Parent freight - ${nums.join(", ")}${containerNumber ? ` (${containerNumber})` : ""}`,
                totalAmount: freightAmtStr,
                sourceModule: "ERP",
              })
              .returning();
            const entriesToInsert = [
              {
                voucherId: newFV.id,
                ledgerAccountId: freightOpts.freightParentAccountId,
                debitAmount: "0",
                creditAmount: freightAmtStr,
                narration: `Freight - ${nums.join(", ")}${containerNumber ? ` (${containerNumber})` : ""}`,
              },
            ];
            if (drAccountId) {
              entriesToInsert.push({
                voucherId: newFV.id,
                ledgerAccountId: drAccountId,
                debitAmount: freightAmtStr,
                creditAmount: "0",
                narration: `Freight receivable - ${nums.join(", ")}`,
              });
            }
            await dbOrTx.insert(voucherEntries).values(entriesToInsert);
            logger.info(
              `[syncIntercoParentVoucher] Created fallback PARENT-FREIGHT journal #${newFV.id} for PO(s) ${nums.join(", ")}`
            );
            return { found: true, updated: true, voucherId: newFV.id, amount: freightAmtStr };
          }
        } catch (fbErr) {
          logger.error("[syncIntercoParentVoucher] Failed to create fallback freight journal:", { error: fbErr });
        }
      }
      logger.warn(`[syncIntercoParentVoucher] No INTERCO-PARENT voucher found for PO(s): ${nums.join(", ")}`);
      return { found: false, updated: false, amount: amountStr };
    }

    const parentEntries = await dbOrTx
      .select()
      .from(voucherEntries)
      .where(eq(voucherEntries.voucherId, parentVoucher.id));

    const oldAmount = toMoney(parentVoucher.totalAmount);
    const oldAmountStr = oldAmount.toFixed(2);

    // Check whether an update is needed (idempotent)
    const totalMismatch = differsByMoreThanTolerance(oldAmount, gross);
    let freightEntryMissing = false;
    let freightNarrationMismatch = false;
    if (freightOpts && hasFreight) {
      const fe = parentEntries.find(
        (e) => e.ledgerAccountId === freightOpts.freightParentAccountId && toMoney(e.creditAmount).greaterThan(0)
      );
      freightEntryMissing = !fe || differsByMoreThanTolerance(toMoney(fe.creditAmount), freight);
      if (fe && containerNumber) {
        freightNarrationMismatch = !(fe.narration || "").includes(containerNumber);
      }
    }
    if (!totalMismatch && !freightEntryMissing && !freightNarrationMismatch) {
      return { found: true, updated: false, voucherId: parentVoucher.id, amount: amountStr, oldAmount: oldAmountStr };
    }

    logger.info(
      `[syncIntercoParentVoucher] PO(s) ${nums.join(", ")}: voucher #${parentVoucher.id} ${oldAmountStr} → ${amountStr}`
    );

    await dbOrTx.update(vouchers).set({ totalAmount: amountStr }).where(eq(vouchers.id, parentVoucher.id));

    if (freightOpts && hasFreight) {
      // Split the INTERCO-PARENT: DR subsidiary receivable (grossTotal),
      //   CR supplier (intercoTotal — goods only), CR freightAccount (freight)
      const intercoAmtStr = intercoTotal.toFixed(2);
      const freightAmtStr = freight.toFixed(2);
      let freightEntryFound = false;

      for (const entry of parentEntries) {
        if (toMoney(entry.debitAmount).greaterThan(0)) {
          await dbOrTx.update(voucherEntries).set({ debitAmount: amountStr }).where(eq(voucherEntries.id, entry.id));
        } else if (toMoney(entry.creditAmount).greaterThan(0)) {
          if (entry.ledgerAccountId === freightOpts.freightParentAccountId) {
            freightEntryFound = true;
            await dbOrTx
              .update(voucherEntries)
              .set({
                creditAmount: freightAmtStr,
                narration: `Freight - ${nums.join(", ")}${containerNumber ? ` (${containerNumber})` : ""}`,
              })
              .where(eq(voucherEntries.id, entry.id));
          } else {
            // Supplier CR → intercoTotal (goods share only)
            await dbOrTx
              .update(voucherEntries)
              .set({ creditAmount: intercoAmtStr })
              .where(eq(voucherEntries.id, entry.id));
          }
        }
      }
      if (!freightEntryFound) {
        // voucher_entries has no company_id column — scope comes from the parent voucher.
        await dbOrTx.insert(voucherEntries).values({
          voucherId: parentVoucher.id,
          ledgerAccountId: freightOpts.freightParentAccountId,
          debitAmount: "0",
          creditAmount: freightAmtStr,
          narration: `Freight - ${nums.join(", ")}${containerNumber ? ` (${containerNumber})` : ""}`,
        });
      }
    } else {
      // No freight split — update all entries to grossTotal (original behaviour)
      for (const entry of parentEntries) {
        if (toMoney(entry.debitAmount).greaterThan(0)) {
          await dbOrTx.update(voucherEntries).set({ debitAmount: amountStr }).where(eq(voucherEntries.id, entry.id));
        } else if (toMoney(entry.creditAmount).greaterThan(0)) {
          await dbOrTx.update(voucherEntries).set({ creditAmount: amountStr }).where(eq(voucherEntries.id, entry.id));
        }
      }
    }

    return { found: true, updated: true, voucherId: parentVoucher.id, amount: amountStr, oldAmount: oldAmountStr };
  } catch (err) {
    logger.error("[syncIntercoParentVoucher] Error syncing parent INTERCO voucher:", { error: err });
    return { found: false, updated: false, amount: amountStr };
  }
}

// syncIntercoFreightParentVoucher removed — freight is now recorded directly
// inside the purchase voucher (DR Purchases / CR freightParentAccountId).
// No separate INTERCO-FREIGHT voucher is created. Legacy ones are deleted
// by the sync-all cleanup below.

// ──────────────────────────────────────────────────────────────────────────────
// requireNonSP — blocks Supplier Partner companies from using ERP container
// accounting routes (they must use /api/sp/* endpoints instead).
// Does a single DB read; result is not cached — intentional for correctness.
// ──────────────────────────────────────────────────────────────────────────────
export async function requireNonSP(req: Request, res: Response, next: NextFunction) {
  const companyId = req.session?.currentCompanyId;
  if (!companyId) return next(); // let requireAuth handle missing session

  try {
    const rows = await db.execute(sql`SELECT company_type FROM companies WHERE id = ${companyId} LIMIT 1`);
    const row = rows.rows?.[0] as { company_type: string } | undefined;
    if (row?.company_type === "supplier_partner") {
      return res.status(403).json({
        message: "Supplier Partner companies must use the SP container/offload workflow (/api/sp/*).",
      });
    }
    next();
  } catch (err: unknown) {
    next(err);
  }
}
