// Extracted from ./update.ts: works out which freight, goods and commission vouchers a container update must re-sync.
import { db } from "../../../db";
import { getOrCreateLedgerAccount } from "../_helpers";
import { factorySuppliers, vouchers } from "@shared/schema";
import { eq, and, or, ilike, isNull } from "drizzle-orm";
import { toMoney } from "../../../lib/money";
import type { Response } from "express";
import type { prepareFactoryContainerUpdate } from "./updateInput";

type PrepareFactoryContainerUpdateResult = Awaited<ReturnType<typeof prepareFactoryContainerUpdate>>;

export async function planFactoryContainerUpdateSync({
  input,
  res,
}: {
  input: Extract<PrepareFactoryContainerUpdateResult, { done: false }>;
  res: Response;
}) {
  const { updateData, existing, b, companyId, id, int, dec } = input;
  // Resolve freight effective values — a partial PATCH may omit any freight
  // field, so we must fall back to the existing stored value rather than
  // treating an absent field as "zero" or "supplier".
  const effectiveFreight = updateData.freight !== undefined ? updateData.freight : existing.freight;
  const effectiveFreightPaidBy: string =
    typeof updateData.freightPaidBy === "string" ? updateData.freightPaidBy : existing.freightPaidBy || "supplier";
  const effectiveFreightOwnAccountId =
    updateData.freightOwnAccountId !== undefined ? updateData.freightOwnAccountId : existing.freightOwnAccountId;
  const effectiveFreightSupplierId =
    updateData.freightSupplierId !== undefined ? updateData.freightSupplierId : existing.freightSupplierId;

  const freightNeedsSync = [
    "freight",
    "freightCurrencyCode",
    "freightAccountId",
    "freightSupplierId",
    "freightPaidBy",
    "freightOwnAccountId",
    "supplierId",
    "currencyCode",
    "ratePerKg",
    "fxRateToUsd",
    "fxRateSource",
  ].some((f) => f in b);

  // A notes-only/ETA-only edit must not repair or reject historical freight
  // records with incomplete payer details. Validate/canonicalize only when
  // freight posting inputs really change.
  const effectiveFreightAccountId =
    updateData.freightAccountId !== undefined ? updateData.freightAccountId : existing.freightAccountId;
  if (freightNeedsSync && !effectiveFreightAccountId && toMoney(effectiveFreight).greaterThan(0)) {
    updateData.freightAccountId = await getOrCreateLedgerAccount(companyId, "FREIGHT", "Freight");
  }

  // Canonicalize only when the freight payable is being changed.
  if (freightNeedsSync) {
    if (toMoney(effectiveFreight).lessThanOrEqualTo(0)) {
      // Rule A: no freight → clear both payer fields
      updateData.freightSupplierId = null;
      updateData.freightOwnAccountId = null;
    } else if (effectiveFreightPaidBy === "own") {
      // Rule B: own-account freight → require freightOwnAccountId, clear supplier link
      const ownAcctId =
        updateData.freightOwnAccountId !== undefined ? updateData.freightOwnAccountId : effectiveFreightOwnAccountId;
      if (!ownAcctId) {
        return {
          done: true as const,
          value: res.status(400).json({
            message: "freightOwnAccountId is required when freightPaidBy is 'own'",
          }),
        };
      }
      updateData.freightSupplierId = null;
    } else {
      // Freight is owed to its own chosen payee, never to the goods supplier by fallback.
      if (!effectiveFreightSupplierId) {
        return {
          done: true as const,
          value: res.status(400).json({
            message: "Select the freight supplier before saving supplier-paid freight.",
          }),
        };
      }
      const [freightPayee] = await db
        .select({ id: factorySuppliers.id })
        .from(factorySuppliers)
        .where(and(eq(factorySuppliers.id, effectiveFreightSupplierId), eq(factorySuppliers.companyId, companyId)))
        .limit(1);
      if (!freightPayee) {
        return {
          done: true as const,
          value: res.status(400).json({ message: "The selected freight supplier must belong to this company." }),
        };
      }
      updateData.freightOwnAccountId = null;
      updateData.freightSupplierId = effectiveFreightSupplierId;
    }
  }

  // ── Sync freight voucher ───────────────────────────────────────────────
  // Guard: only re-run FX-dependent freight entry computation when a
  // freight-relevant field was actually included in this request body.
  // A date-only PATCH (e.g. CSV ETA import sending only { arrivalDate })
  // must NOT trigger resolveStoredFxRateOrThrow — doing so causes a 400
  // for EUR/AUD containers that have freight but no confirmed FX rate,
  // because the import only changes the ETA, not anything freight-related.
  // A container's goods payable MUST follow changes to the supplier, goods value,
  // currency and historical rate. Previously only the descriptive daybook row
  // followed those edits, which left the supplier's actual ledger incorrect.
  let goodsNeedsSync = ["supplierId", "totalKg", "ratePerKg", "currencyCode", "fxRateToUsd", "fxRateSource"].some(
    (f) => f in b
  );

  // The original goods credit on the 18 reviewed legacy containers was
  // subsequently corrected by a separate, balanced EUR reclassification.
  // Editing the original goods journal again would leave that correction in
  // place and double-count the supplier transfer. A future change must first
  // use a reviewed, compensating-voucher workflow, not a silent in-place edit.
  if (goodsNeedsSync) {
    const [reviewedReclassification] = await db
      .select({ id: vouchers.id })
      .from(vouchers)
      .where(
        and(
          eq(vouchers.companyId, companyId),
          eq(vouchers.voucherNumber, `FACTORY-PAYABLE-RECLASS-20261015-${id}`),
          isNull(vouchers.deletedAt)
        )
      )
      .limit(1);
    // After the owner's audited compensating journal is posted, the
    // original supplier credit is authoritative again. Only keep this
    // special lock while the Oct-15 reclassification is uncompensated.
    const [undoJournal] = reviewedReclassification
      ? await db
          .select({ id: vouchers.id })
          .from(vouchers)
          .where(
            and(
              eq(vouchers.companyId, companyId),
              eq(vouchers.voucherNumber, `FACTORY-PAYABLE-RECLASS-REV-20261015-${id}`),
              isNull(vouchers.deletedAt)
            )
          )
          .limit(1)
      : [];
    if (reviewedReclassification && !undoJournal) {
      const goodsActuallyChanged =
        (b.supplierId !== undefined && int(b.supplierId) !== existing.supplierId) ||
        (b.totalKg !== undefined && !toMoney(dec(b.totalKg)).eq(toMoney(existing.totalKg))) ||
        (b.ratePerKg !== undefined && !toMoney(dec(b.ratePerKg)).eq(toMoney(existing.ratePerKg))) ||
        (b.currencyCode !== undefined &&
          String(b.currencyCode || "USD").toUpperCase() !== String(existing.currencyCode || "USD").toUpperCase()) ||
        (b.fxRateToUsd !== undefined && !toMoney(dec(b.fxRateToUsd)).eq(toMoney(existing.fxRateToUsd))) ||
        (b.fxRateSource !== undefined && String(b.fxRateSource || "auto") !== String(existing.fxRateSource || "auto"));
      if (goodsActuallyChanged) {
        return {
          done: true as const,
          value: res.status(409).json({
            code: "FACTORY_IMPORT_RECLASS_REVIEW_REQUIRED",
            message: "FPR_LOCKED",
            correctionVoucherId: reviewedReclassification.id,
          }),
        };
      }
      // Many edit dialogs submit unchanged goods fields with unrelated
      // updates. Permit those edits without resynchronizing (and thereby
      // corrupting) the original imported-goods payable or stored FX.
      goodsNeedsSync = false;
      delete updateData.supplierId;
      delete updateData.totalKg;
      delete updateData.ratePerKg;
      delete updateData.currencyCode;
      delete updateData.fxRateToUsd;
      delete updateData.fxRateSource;
      delete updateData.fxRateToUsdImport;
      delete updateData.fxRateDateImport;
      delete updateData.fxRateConfirmed;
      delete updateData.ratePerKgUsd;
    }
  }
  const existingImports = goodsNeedsSync
    ? await db
        .select()
        .from(vouchers)
        .where(
          and(
            eq(vouchers.companyId, companyId),
            isNull(vouchers.deletedAt),
            ilike(vouchers.voucherNumber, `FACTORY-IMPORT-${id}-%`)
          )
        )
        .limit(2)
    : [];
  if (goodsNeedsSync && existingImports.length > 1) {
    return {
      done: true as const,
      value: res.status(409).json({
        code: "FACTORY_IMPORT_DUPLICATE_JOURNALS",
        message:
          "Multiple live import journals exist for this container. Reconcile them before changing supplier or goods value.",
      }),
    };
  }

  // A container created with no goods quantity/value has no initial goods
  // payable. When a user explicitly enters its FIRST positive goods value,
  // post the initial liability through the normal voucher engine. This is
  // not a historical backfill: a container whose old goods value was
  // positive must still follow the reviewed backfill workflow.
  const previousGoodsValue = toMoney(existing.totalKg).times(toMoney(existing.ratePerKg));
  let firstGoodsCostAccountId: number | null = null;
  if (goodsNeedsSync && existingImports.length === 0 && previousGoodsValue.isZero()) {
    // A retired/soft-deleted voucher is historical evidence. Never post a
    // replacement automatically merely because the live query finds none.
    const [historicalImport] = await db
      .select({ id: vouchers.id })
      .from(vouchers)
      .where(and(eq(vouchers.companyId, companyId), ilike(vouchers.voucherNumber, `FACTORY-IMPORT-${id}-%`)))
      .limit(1);
    if (!historicalImport) {
      firstGoodsCostAccountId = await getOrCreateLedgerAccount(companyId, "FACTORY_IMPORT_COST", "Factory Import Cost");
    }
  }

  // Find any existing freight voucher for this container (stable or timestamped number)
  const existingFreightVouchers = await db
    .select()
    .from(vouchers)
    .where(
      and(
        eq(vouchers.companyId, companyId),
        isNull(vouchers.deletedAt),
        or(
          eq(vouchers.voucherNumber, `FACTORY-FREIGHT-${id}`),
          ilike(vouchers.voucherNumber, `FACTORY-FREIGHT-${id}-%`)
        )
      )
    )
    .limit(2);
  // Never edit only the first of multiple live freight journals. That would
  // leave the other journal posting the same amount, or the wrong payable.
  if (freightNeedsSync && existingFreightVouchers.length > 1) {
    return {
      done: true as const,
      value: res.status(409).json({
        code: "FACTORY_FREIGHT_DUPLICATE_JOURNALS",
        message:
          "Multiple live freight journals exist for this container. Reconcile them before changing freight or its supplier.",
      }),
    };
  }
  const existingFV = existingFreightVouchers[0];

  // Wave 8.4 continuation: the commission journal FACTORY-COMM-{container}
  // follows every change to the commission or what it is posted at.
  const commissionNeedsSync = [
    "commissionAmount",
    "commissionCurrencyCode",
    "commissionAccountId",
    "commissionSupplierId",
    "supplierId",
    "currencyCode",
    "fxRateToUsd",
    "fxRateSource",
    "ratePerKg",
    "arrivalDate",
  ].some((f) => f in b);

  return {
    done: false as const,
    freightNeedsSync,
    goodsNeedsSync,
    existingImports,
    previousGoodsValue,
    firstGoodsCostAccountId,
    existingFV,
    commissionNeedsSync,
  };
}
