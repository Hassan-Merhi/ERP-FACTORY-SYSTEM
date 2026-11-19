// Extracted from ./rawMaterialReconciliation.ts: a stage of rawMaterialReconciliation.
import { eq, and, sql, inArray } from "drizzle-orm";
import { db } from "../../db";
import {
  factoryOffloadAdditionalCharges,
  factoryContainerCommissions,
  factoryContainerOtherCharges,
  factorySupplierPayments,
  voucherEntries,
  vouchers,
} from "@shared/schema";
import { resolveStoredFxRate } from "./currencyConversion";
import { entryNativeAmounts, entryStoredUsdAmounts, voucherEntryCurrencyColumns } from "./voucherEntryCurrency";
import { amountOf, times } from "./rawMaterialReconciliationHelpers";
import type { rawMaterialReconciliationStep } from "./rawMaterialReconciliationStep";

type RawMaterialReconciliationStepResult = Awaited<ReturnType<typeof rawMaterialReconciliationStep>>;

export async function rawMaterialReconciliationStep2({
  rmr1,
  companyId,
}: {
  rmr1: RawMaterialReconciliationStepResult;
  companyId: number;
}) {
  const {
    allContainersById,
    PAYABLE_CONTAINER_STATUSES,
    addGross,
    unresolvedFxRows,
    supplierNameById,
    addPayment,
    suppliers,
  } = rmr1;
  for (const c of allContainersById.values()) {
    if (!c.supplierId) continue;
    if (c.deletedAt) continue;
    if (!PAYABLE_CONTAINER_STATUSES.has(String(c.status || "").toUpperCase())) continue;
    const cc = c.currencyCode || "USD";
    const amt = times(amountOf(c.actualReceivedKg || c.totalKg), amountOf(c.ratePerKg));
    if (amt) {
      const { fxRate, looksSet } = resolveStoredFxRate(cc, c.fxRateToUsd, c.fxRateConfirmed);
      addGross(c.supplierId, cc, amt, cc === "USD" ? amt : looksSet ? times(amt, fxRate) : null);
      if (cc !== "USD" && !looksSet) {
        unresolvedFxRows.push({
          supplierId: c.supplierId,
          supplierName: supplierNameById.get(c.supplierId) || "Unknown Supplier",
          currencyCode: cc,
          source: "container",
          rowId: c.id,
          nativeAmount: amt,
        });
      }
    }

    const freight = amountOf(c.freight);
    if (freight) {
      const freightCc = c.freightCurrencyCode || cc;
      const { fxRate, looksSet } = resolveStoredFxRate(freightCc, c.fxRateToUsd, c.fxRateConfirmed);
      addGross(
        c.supplierId,
        freightCc,
        freight,
        freightCc === "USD" ? freight : looksSet ? times(freight, fxRate) : null
      );
      if (freightCc !== "USD" && !looksSet) {
        unresolvedFxRows.push({
          supplierId: c.supplierId,
          supplierName: supplierNameById.get(c.supplierId) || "Unknown Supplier",
          currencyCode: freightCc,
          source: "container",
          rowId: c.id,
          nativeAmount: freight,
        });
      }
    }
  }

  // Offload additional charges assigned directly to a supplier.
  const allOffloadCharges = await db
    .select()
    .from(factoryOffloadAdditionalCharges)
    .where(eq(factoryOffloadAdditionalCharges.companyId, companyId));
  for (const oc of allOffloadCharges) {
    const supplierId = oc.supplierId ?? allContainersById.get(oc.containerId)?.supplierId ?? null;
    if (!supplierId) continue;
    const cc = oc.currencyCode || "USD";
    const amt = amountOf(oc.amount);
    if (!amt) continue;
    const { fxRate, looksSet } = resolveStoredFxRate(cc, oc.fxRateToUsd, oc.fxRateConfirmed);
    addGross(supplierId, cc, amt, cc === "USD" ? amt : looksSet ? times(amt, fxRate) : null);
    if (cc !== "USD" && !looksSet) {
      unresolvedFxRows.push({
        supplierId,
        supplierName: supplierNameById.get(supplierId) || "Unknown Supplier",
        currencyCode: cc,
        source: "offload_charge",
        rowId: oc.id,
        nativeAmount: amt,
      });
    }
  }

  // Container-level other-charges table (multi-row) and the legacy single
  // other-charges column, both scoped to whichever supplier they're assigned to.
  const allContainerOtherCharges = await db
    .select()
    .from(factoryContainerOtherCharges)
    .where(eq(factoryContainerOtherCharges.companyId, companyId));
  for (const oc of allContainerOtherCharges) {
    const container = allContainersById.get(oc.containerId);
    const supplierId = container?.supplierId ?? null;
    if (!supplierId) continue;
    const cc = oc.currencyCode || container?.currencyCode || "USD";
    const amt = amountOf(oc.amount);
    if (!amt) continue;
    // This table has no FX fields of its own — reuse the container's, since the
    // charge's currency defaults to the container's currency when unset.
    const { fxRate, looksSet } = resolveStoredFxRate(cc, container?.fxRateToUsd, container?.fxRateConfirmed);
    addGross(supplierId, cc, amt, cc === "USD" ? amt : looksSet ? times(amt, fxRate) : null);
    if (cc !== "USD" && !looksSet) {
      unresolvedFxRows.push({
        supplierId,
        supplierName: supplierNameById.get(supplierId) || "Unknown Supplier",
        currencyCode: cc,
        source: "container_other_charge",
        rowId: oc.id,
        nativeAmount: amt,
      });
    }
  }
  for (const c of allContainersById.values()) {
    const chargeSupplierId = c.otherChargesSupplierId;
    if (!chargeSupplierId) continue;
    const amt = amountOf(c.otherCharges);
    if (!amt) continue;
    const cc = c.otherChargesCurrencyCode || "USD";
    const { fxRate, looksSet } = resolveStoredFxRate(cc, c.fxRateToUsd, c.fxRateConfirmed);
    addGross(chargeSupplierId, cc, amt, cc === "USD" ? amt : looksSet ? times(amt, fxRate) : null);
    if (cc !== "USD" && !looksSet) {
      unresolvedFxRows.push({
        supplierId: chargeSupplierId,
        supplierName: supplierNameById.get(chargeSupplierId) || "Unknown Supplier",
        currencyCode: cc,
        source: "container_other_charge",
        rowId: c.id,
        nativeAmount: amt,
      });
    }
  }

  // Commissions — same supplier-recipient rule as the container loop above:
  // owed to whichever supplier is the actual commission recipient.
  const allCommissions = await db
    .select()
    .from(factoryContainerCommissions)
    .where(eq(factoryContainerCommissions.companyId, companyId));
  for (const cm of allCommissions) {
    const container = allContainersById.get(cm.containerId);
    // NOTE — behaviour preserved verbatim: factoryContainerCommissions has no
    // commissionSupplierId column, so this read resolves to undefined and the
    // recipient is always the container's supplier. Reading the container's
    // commissionSupplierId instead would move commission balances and needs
    // its own reviewed change.
    const recipientId =
      (cm as { commissionSupplierId?: number | null }).commissionSupplierId ?? container?.supplierId ?? null;
    if (!recipientId) continue;
    const cc = cm.currencyCode || "USD";
    const amt = amountOf(cm.commissionTotal);
    if (!amt) continue;
    const { fxRate, looksSet } = resolveStoredFxRate(cc, cm.fxRateToUsd, cm.fxRateConfirmed);
    addGross(recipientId, cc, amt, cc === "USD" ? amt : looksSet ? times(amt, fxRate) : null);
    if (cc !== "USD" && !looksSet) {
      unresolvedFxRows.push({
        supplierId: recipientId,
        supplierName: supplierNameById.get(recipientId) || "Unknown Supplier",
        currencyCode: cc,
        source: "commission",
        rowId: cm.id,
        nativeAmount: amt,
      });
    }
  }

  // Supplier payments — amountUsd is already stored at write time, so USD is
  // always resolved here regardless of the payment's native currency.
  const allSupplierPayments = await db
    .select()
    .from(factorySupplierPayments)
    .where(eq(factorySupplierPayments.companyId, companyId));
  for (const p of allSupplierPayments) {
    const cc = p.currencyCode || "USD";
    const amt = amountOf(p.amount);
    const amtUsd = amountOf(p.amountUsd);
    addPayment(p.supplierId, cc, amt, amtUsd);
  }

  // Voucher-linked supplier payments (general accounting), skipping optional
  // (informational-only) vouchers. Uses the voucher's stored exchangeRate; a
  // non-USD voucher with no exchangeRate is flagged unresolved rather than
  // assumed to be 1.
  const supplierIds = suppliers.map((s) => s.id);
  const allVoucherPayments =
    supplierIds.length > 0
      ? await db
          .select({
            id: voucherEntries.id,
            ...voucherEntryCurrencyColumns,
            supplierId: voucherEntries.factorySupplierId,
            exchangeRate: vouchers.exchangeRate,
            optional: vouchers.optional,
            voucherNumber: vouchers.voucherNumber,
          })
          .from(voucherEntries)
          .innerJoin(vouchers, eq(voucherEntries.voucherId, vouchers.id))
          .where(
            and(
              inArray(voucherEntries.factorySupplierId, supplierIds),
              sql`${voucherEntries.debitAmount}::numeric > 0`,
              sql`${vouchers.voucherNumber} NOT LIKE 'FACTORY-PAY-%'`
            )
          )
      : [];
  for (const p of allVoucherPayments) {
    if (p.optional || !p.supplierId) continue;
    // A normalized entry carries its native amount and USD base; only a
    // legacy entry is converted from the voucher's stored rate.
    const native = entryNativeAmounts(p);
    const cc = native.currency;
    const amt = amountOf(native.debit.toFixed());
    if (!amt) continue;
    const stored = entryStoredUsdAmounts(p);
    const rate =
      p.exchangeRate !== null && p.exchangeRate !== undefined ? amountOf(p.exchangeRate) : cc === "USD" ? 1 : null;
    const resolved = stored !== null || cc === "USD" || (rate !== null && rate > 0);
    const usd = stored ? amountOf(stored.debit.toFixed()) : resolved ? times(amt, rate ?? 1) : null;
    addPayment(p.supplierId, cc, amt, usd);
    if (!resolved) {
      unresolvedFxRows.push({
        supplierId: p.supplierId,
        supplierName: supplierNameById.get(p.supplierId) || "Unknown Supplier",
        currencyCode: cc,
        source: "voucher_payment",
        rowId: p.id,
        nativeAmount: amt,
      });
    }
  }
}
