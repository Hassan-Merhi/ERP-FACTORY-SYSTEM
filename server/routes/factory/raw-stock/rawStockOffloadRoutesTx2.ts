// Extracted from ./rawStockOffloadRoutes.ts: a stage of rawStockOffloadRoutes.
import Decimal from "decimal.js";
import { resolveStoredFxRateOrThrow } from "../../../services/factory/currencyConversion";
import { writeDaybookEntry } from "../_helpers";
import { postFactoryVoucherTx } from "../../../services/factory/factoryVoucherPosting";
import { factoryDaybookEntries, vouchers } from "@shared/schema";
import { eq, and, or, ilike } from "drizzle-orm";
import { parseMoneyInput, toMoney } from "../../../lib/money";
import { retireVouchersTx, sessionRetirementActor } from "../../../services/accounting/voucherRetirement";
import { requestNumber } from "./rawStockOffloadRoutesHelpers";
import type { Request } from "express";
import type { DbTransaction } from "../../../db";
import type { factoryRawStock } from "@shared/schema";
import type { rawStockOffloadRoutesStep } from "./rawStockOffloadRoutesStep";
import type { rawStockOffloadRoutesTx } from "./rawStockOffloadRoutesTx";

type RawStockOffloadRoutesStepResult = Awaited<ReturnType<typeof rawStockOffloadRoutesStep>>;
type RawStockOffloadRoutesTxResult = Awaited<ReturnType<typeof rawStockOffloadRoutesTx>>;

export async function rawStockOffloadRoutesTx2({
  tx,
  rso1,
  offload,
  rsot1,
  req,
}: {
  tx: DbTransaction;
  rso1: Extract<RawStockOffloadRoutesStepResult, { done: false }>;
  offload: { rawStock?: typeof factoryRawStock.$inferSelect };
  rsot1: Extract<RawStockOffloadRoutesTxResult, { done: false }>;
  req: Request;
}) {
  const {
    companyId,
    offloadDate,
    container,
    supplierNarrationSuffix,
    dReceivedKg,
    dInclusiveCostPerKg,
    currencyCode,
    fxRate,
    containerId,
    commissionRecord,
    freightVal,
    freightCcy,
    freightFxRateVal,
    otherChargesVal,
    ocCcy,
    ocFxRateVal,
    dutyVal,
    reqFreight,
    reqOtherCharges,
    reqFreightAccountId,
    effectiveFreightSupplierId,
    reqFreightCurrencyCode,
    reqFreightFxRate,
    fxRateText,
    freightExpenseAcctId,
  } = rso1;

  // 7. Daybook entries
  // Use the value of THIS RECEIPT's kg (incremental), not the full container
  // value. For a fully-received container receivedKg == declaredKg so the result
  // is identical. For a partial first receipt, posting the full container value
  // would overstate the daybook — only what we actually received today is an
  // economic event today.
  await writeDaybookEntry(tx, {
    companyId: companyId,
    txDate: offloadDate,
    txType: "OFFLOAD_RAW_STOCK",
    referenceId: offload.rawStock!.id,
    referenceTable: "factory_raw_stock",
    description: `Offloaded container ${container.containerNumber}${supplierNarrationSuffix}: ${dReceivedKg.toDecimalPlaces(3).toFixed(3)} kg at ${dInclusiveCostPerKg.toDecimalPlaces(6).toFixed(6)}/kg (inclusive)`,
    currencyCode: currencyCode,
    amountCurrency: dReceivedKg.times(dInclusiveCostPerKg).toDecimalPlaces(6).toNumber(),
    fxRateToUsd: fxRate,
    metaJson: JSON.stringify({ containerId: containerId, sourceType: "BASE_MATERIAL" }),
  });
  if (commissionRecord) {
    await writeDaybookEntry(tx, {
      companyId: companyId,
      txDate: offloadDate,
      txType: "COMMISSION",
      referenceId: commissionRecord.id,
      referenceTable: "factory_container_commissions",
      description: `Commission for ${commissionRecord.personName} on container ${container.containerNumber}`,
      currencyCode: commissionRecord.currencyCode || "USD",
      amountCurrency: toMoney(commissionRecord.commissionTotal).toNumber(),
      fxRateToUsd: resolveStoredFxRateOrThrow(
        commissionRecord.currencyCode,
        commissionRecord.fxRateToUsd,
        commissionRecord.fxRateConfirmed
      ),
      metaJson: JSON.stringify({
        containerId: containerId,
        sourceType: "COMMISSION",
        commissionId: commissionRecord.id,
      }),
    });
  }
  if (freightVal > 0) {
    await writeDaybookEntry(tx, {
      companyId: companyId,
      txDate: offloadDate,
      txType: "FREIGHT",
      referenceId: containerId,
      referenceTable: "factory_containers",
      description: `Freight on container ${container.containerNumber}`,
      currencyCode: freightCcy,
      amountCurrency: freightVal,
      fxRateToUsd: freightCcy === "USD" ? 1 : freightFxRateVal,
      metaJson: JSON.stringify({ containerId: containerId, sourceType: "FREIGHT" }),
    });
  }
  if (otherChargesVal > 0) {
    await writeDaybookEntry(tx, {
      companyId: companyId,
      txDate: offloadDate,
      txType: "OTHER_CHARGE",
      referenceId: containerId,
      referenceTable: "factory_containers",
      description: `Other charges on container ${container.containerNumber}`,
      currencyCode: ocCcy,
      amountCurrency: otherChargesVal,
      fxRateToUsd: ocCcy === "USD" ? 1 : ocFxRateVal,
      metaJson: JSON.stringify({ containerId: containerId, sourceType: "CONTAINER_OC" }),
    });
  }
  if (dutyVal > 0) {
    await writeDaybookEntry(tx, {
      companyId: companyId,
      txDate: offloadDate,
      txType: "DUTY",
      referenceId: containerId,
      referenceTable: "factory_containers",
      description: `Duty on container ${container.containerNumber}`,
      currencyCode: currencyCode,
      amountCurrency: dutyVal,
      fxRateToUsd: fxRate,
      metaJson: JSON.stringify({ containerId: containerId, sourceType: "DUTY" }),
    });
  }
  for (const insertedCharge of rsot1.insertedAdditionalCharges) {
    const chargeAmount = toMoney(insertedCharge.amount).toNumber();
    if (chargeAmount > 0) {
      await writeDaybookEntry(tx, {
        companyId: companyId,
        txDate: offloadDate,
        txType: "OTHER_CHARGE",
        referenceId: containerId,
        description: `${insertedCharge.description} on container ${container.containerNumber}`,
        referenceTable: "factory_containers",
        currencyCode: insertedCharge.currencyCode || currencyCode,
        amountCurrency: chargeAmount,
        fxRateToUsd: requestNumber(insertedCharge.fxRateToUsd || String(fxRate)),
        metaJson: JSON.stringify({
          containerId: containerId,
          sourceType: "OFFLOAD_ADDITIONAL",
          chargeId: insertedCharge.id,
        }),
      });
    }
  }

  // 7. Delete any creation-time FACTORY-FREIGHT and FACTORY-OC vouchers
  //    before posting new offload ones (prevents double-posting).
  //    Container creation (factoryContainersRoutes.ts) posts a stable, non-suffixed
  //    `FACTORY-FREIGHT-{id}` voucher number when freight is set at creation time —
  //    match that exact form too, not just the `-{timestamp}` suffixed offload form,
  //    or the creation-time voucher survives and freight gets expensed twice.
  //    Likewise, the other-charges sync endpoint posts `FACTORY-OC-{id}-{chargeId}-{ts}`
  //    vouchers while the container is in PENDING state; these must also be cleared
  //    so the offload doesn't double-count them alongside its own OC vouchers.
  const existingPreOffloadVouchers = await tx
    .select({ id: vouchers.id })
    .from(vouchers)
    .where(
      and(
        eq(vouchers.companyId, companyId),
        eq(vouchers.sourceModule, "FACTORY"),
        or(
          eq(vouchers.voucherNumber, `FACTORY-FREIGHT-${containerId}`),
          ilike(vouchers.voucherNumber, `FACTORY-FREIGHT-${containerId}-%`),
          ilike(vouchers.voucherNumber, `FACTORY-OC-${containerId}-%`)
        )
      )
    );
  if (existingPreOffloadVouchers.length > 0) {
    const vIds = existingPreOffloadVouchers.map((v) => v.id);
    // Wave 16 (A): retired (soft delete with lines, audited here), not hard-deleted.
    await retireVouchersTx(tx, {
      companyId: companyId,
      voucherIds: vIds,
      reason: "factory-raw-stock-offload-delete",
      actor: sessionRetirementActor(req),
    });
  }
  await tx
    .delete(factoryDaybookEntries)
    .where(
      and(
        eq(factoryDaybookEntries.companyId, companyId),
        eq(factoryDaybookEntries.txType, "FREIGHT"),
        eq(factoryDaybookEntries.referenceId, containerId)
      )
    );

  // 8. Freight voucher (double-entry)
  //
  // Every leg of the freight, other-charge and additional-charge vouchers is
  // posted normalized: debit/credit hold the USD base (native × the factory
  // USD-per-unit rate, exactly), transaction_* hold the native amount. The
  // supplier-paid legs used to keep the native amount in the USD columns,
  // which put EUR/AUD figures into the expense accounts and the trial
  // balance as if they were USD (2026-10 accounting audit, wave 6).
  //
  // Phase 22 (C): each voucher goes through the engine (balanced, Decimal,
  // company-owned targets) with this receipt's posting identity, so a replay
  // returns the voucher instead of posting it twice. The FACTORY-FREIGHT- /
  // FACTORY-OC- family numbers are read as identity (reverse offload,
  // container delete, unposted memo), so they keep the prefix with the
  // receipt / charge id as the suffix (was Date.now()).
  const receiptId = offload.rawStock!.id;
  const freightAmount = parseMoneyInput(reqFreight || "0") ?? new Decimal(0);
  const otherChargesAmount = parseMoneyInput(reqOtherCharges || "0") ?? new Decimal(0);
  if (freightAmount.greaterThan(0) && (reqFreightAccountId || effectiveFreightSupplierId)) {
    const freightVoucherCcy = reqFreightCurrencyCode || currencyCode;
    const freightFx = reqFreightFxRate || fxRateText;
    await postFactoryVoucherTx(tx, {
      companyId: companyId,
      voucherNumber: `FACTORY-FREIGHT-${containerId}-${receiptId}`,
      voucherDate: offloadDate,
      description: `Freight on container ${container.containerNumber}`,
      currency: freightVoucherCcy,
      fxRateToUsd: freightFx,
      source: {
        sourceType: "factory-offload-freight",
        sourceId: `${containerId}:${receiptId}`,
        phase: "freight",
      },
      lines: [
        {
          ledgerAccountId: freightExpenseAcctId!,
          debit: freightAmount,
          narration: `Freight expense - container ${container.containerNumber}`,
        },
        effectiveFreightSupplierId
          ? {
              // Supplier: Dr Freight Expense / Cr Supplier Balance
              factorySupplierId: effectiveFreightSupplierId,
              credit: freightAmount,
              narration: `Freight payable to supplier - container ${container.containerNumber}`,
            }
          : {
              // Own-account freight: Dr Freight Expense / Cr own account (the account
              // that physically paid the freight, e.g. Embassy Shipping).
              // reqFreightAccountId here is the credit/own account (set from
              // container.freightOwnAccountId by the offload dialog).
              ledgerAccountId: parseInt(reqFreightAccountId),
              credit: freightAmount,
              narration: `Freight paid via own account - container ${container.containerNumber}`,
            },
      ],
    });
  }

  return { receiptId, otherChargesAmount };
}
