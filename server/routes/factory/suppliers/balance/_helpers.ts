/**
 * Shared state and helpers for the supplierBalanceRoutes routes.
 *
 * Extracted verbatim from the former single-file supplierBalanceRoutes.ts.
 */
import { db } from "../../../../db";
import { sqlArray } from "../../../../lib/sqlArray";
import { resolveStoredFxRate } from "../../../../services/factory/currencyConversion";
import {
  factorySuppliers,
  factoryContainers,
  voucherEntries,
  factoryOffloadAdditionalCharges,
  factoryContainerOtherCharges,
  vouchers,
  factorySupplierPayments,
  factorySupplierFxTransfers,
} from "@shared/schema";
import { eq, and, sql, inArray, isNull } from "drizzle-orm";

// Resolves a display/aggregate FX rate for the with-balances summary: prefers the
// user-configured company rate, then the row's own confirmed rate; returns 0 (never a
// silent 1) when neither is available, so that currency's contribution to the USD total
// is excluded rather than guessed — callers should treat a 0 result as "unresolved".
export function resolveDisplayFx(
  ccy: string,
  configuredRate: number | undefined,
  storedRate: string | number | null | undefined,
  confirmed?: boolean
): number {
  if (ccy === "USD") return 1;
  if (configuredRate !== undefined) return configuredRate;
  const { fxRate, looksSet } = resolveStoredFxRate(ccy, storedRate, confirmed);
  return looksSet ? fxRate : 0;
}

export const PAYABLE_CONTAINER_STATUSES = new Set(["OFFLOADED", "RECEIVED", "PARTIALLY_RECEIVED"]);

export const isPayableContainer = (c: Record<string, unknown>) =>
  PAYABLE_CONTAINER_STATUSES.has(String(c.status || "").toUpperCase());

/** True when freight should be included in the supplier's payable balance.
 *  Explicit freightPaidBy flag takes priority.
 *  For legacy offloaded containers missing the flag: the offload route always
 *  sets freightSupplierId when it credits the supplier — so if that column is
 *  null on an already-offloaded container, the freight went to an own account. */
export const isSupplierPaidFreight = (c: Record<string, unknown>): boolean => {
  if (c.freightPaidBy === "own") return false;
  if (c.freightPaidBy === "supplier") return true;
  // freightPaidBy is null (legacy row): use freightSupplierId as ground truth
  // only for containers that have already been offloaded (offload always writes
  // freightSupplierId for supplier-paid freight, leaves it null for own-account).
  const offloadedStatuses = new Set(["OFFLOADED", "RECEIVED", "PARTIALLY_RECEIVED"]);
  if (offloadedStatuses.has(String(c.status || "").toUpperCase())) {
    return c.freightSupplierId !== null && c.freightSupplierId !== undefined;
  }
  // Pending / OTW: default to "supplier" (legacy behaviour; determined at offload).
  return true;
};

export async function buildBrokerStatement(brokerId: number, companyId: number, includeOtw = false) {
  // Fetch broker
  const [broker] = await db
    .select()
    .from(factorySuppliers)
    .where(and(eq(factorySuppliers.id, brokerId), eq(factorySuppliers.companyId, companyId)));
  if (!broker) return null;

  // Linked suppliers
  const linkedRaw = await db
    .select()
    .from(factorySuppliers)
    .where(and(eq(factorySuppliers.parentId, brokerId), eq(factorySuppliers.companyId, companyId)));

  const allSuppliers = [broker, ...linkedRaw];
  const allSupplierIds = allSuppliers.map((s) => s.id);
  const supplierNameMap: Record<number, string> = {};
  for (const s of allSuppliers) supplierNameMap[s.id] = s.name;
  const supplierNameOf = (supplierId: number | null): string =>
    supplierId != null ? supplierNameMap[supplierId] || "Unknown" : "Unknown";

  // Containers — exclude OTW unless caller opts in; always exclude soft-deleted
  const containersWhereClause = includeOtw
    ? and(
        eq(factoryContainers.companyId, companyId),
        inArray(factoryContainers.supplierId, allSupplierIds),
        isNull(factoryContainers.deletedAt)
      )
    : and(
        eq(factoryContainers.companyId, companyId),
        inArray(factoryContainers.supplierId, allSupplierIds),
        isNull(factoryContainers.deletedAt),
        sql`${factoryContainers.status} NOT IN ('PENDING', 'IN_TRANSIT')`
      );
  const allContainers =
    allSupplierIds.length > 0
      ? await db
          .select()
          .from(factoryContainers)
          .where(containersWhereClause)
          .orderBy(factoryContainers.arrivalDate, factoryContainers.createdAt)
      : [];
  // Build a Set of the filtered container IDs so charge queries can be scoped to the same set.
  const filteredContainerIdSet = new Set(allContainers.map((c) => c.id as number));

  // Payments (direct)
  const allPayments =
    allSupplierIds.length > 0
      ? await db
          .select()
          .from(factorySupplierPayments)
          .where(
            and(
              eq(factorySupplierPayments.companyId, companyId),
              inArray(factorySupplierPayments.supplierId, allSupplierIds)
            )
          )
          .orderBy(factorySupplierPayments.date)
      : [];

  // Voucher-based payments (from general accounting, linked via factorySupplierId)
  const allVoucherPayments =
    allSupplierIds.length > 0
      ? await db
          .select({
            id: voucherEntries.id,
            debitAmount: voucherEntries.debitAmount,
            supplierId: voucherEntries.factorySupplierId,
            voucherDate: vouchers.voucherDate,
            description: vouchers.description,
            voucherNumber: vouchers.voucherNumber,
            currency: vouchers.currency,
            optional: vouchers.optional,
          })
          .from(voucherEntries)
          .innerJoin(vouchers, eq(voucherEntries.voucherId, vouchers.id))
          .where(
            and(
              inArray(voucherEntries.factorySupplierId, allSupplierIds),
              sql`${voucherEntries.debitAmount}::numeric > 0`,
              sql`${vouchers.voucherNumber} NOT LIKE 'FACTORY-PAY-%'`
            )
          )
          .orderBy(vouchers.voucherDate)
      : [];

  // FX transfers (involving any of the suppliers)
  const allFx =
    allSupplierIds.length > 0
      ? await db
          .select()
          .from(factorySupplierFxTransfers)
          .where(
            and(
              eq(factorySupplierFxTransfers.companyId, companyId),
              sql`(${factorySupplierFxTransfers.fromSupplierId} = ANY(${sqlArray(allSupplierIds)}) OR ${factorySupplierFxTransfers.toSupplierId} = ANY(${sqlArray(allSupplierIds)}))`
            )
          )
          .orderBy(factorySupplierFxTransfers.date)
      : [];

  // Offload additional charges explicitly assigned to any of the broker's suppliers.
  // Only rows where supplierId IS NOT NULL are included — if a charge was posted to a ledger
  // account (loan, payable, etc.) its supplierId is null intentionally and must NOT appear here.
  const allOffloadCharges =
    allSupplierIds.length > 0
      ? await db
          .select({
            id: factoryOffloadAdditionalCharges.id,
            containerId: factoryOffloadAdditionalCharges.containerId,
            description: factoryOffloadAdditionalCharges.description,
            amount: factoryOffloadAdditionalCharges.amount,
            currencyCode: factoryOffloadAdditionalCharges.currencyCode,
            fxRateToUsd: factoryOffloadAdditionalCharges.fxRateToUsd,
            createdAt: factoryOffloadAdditionalCharges.createdAt,
            supplierId: factoryOffloadAdditionalCharges.supplierId,
          })
          .from(factoryOffloadAdditionalCharges)
          .where(
            and(
              eq(factoryOffloadAdditionalCharges.companyId, companyId),
              sql`${factoryOffloadAdditionalCharges.supplierId} = ANY(${sqlArray(allSupplierIds)})`
            )
          )
          .orderBy(factoryOffloadAdditionalCharges.createdAt)
      : [];

  // Container-level other charges (entered per-container, use charge's own currency first)
  const allContainerOtherCharges =
    allSupplierIds.length > 0
      ? await db
          .select({
            id: factoryContainerOtherCharges.id,
            containerId: factoryContainerOtherCharges.containerId,
            description: factoryContainerOtherCharges.description,
            amount: factoryContainerOtherCharges.amount,
            createdAt: factoryContainerOtherCharges.createdAt,
            supplierId: factoryContainers.supplierId,
            chargeCurrencyCode: factoryContainerOtherCharges.currencyCode,
            containerCurrencyCode: factoryContainers.currencyCode,
            containerNumber: factoryContainers.containerNumber,
          })
          .from(factoryContainerOtherCharges)
          .innerJoin(factoryContainers, eq(factoryContainerOtherCharges.containerId, factoryContainers.id))
          .where(
            and(
              eq(factoryContainerOtherCharges.companyId, companyId),
              inArray(factoryContainers.supplierId, allSupplierIds)
            )
          )
          .orderBy(factoryContainerOtherCharges.createdAt)
      : [];

  type LedgerRow = {
    date: string | null;
    type: "container" | "payment" | "fx_out" | "fx_in" | "commission" | "freight" | "other_charge" | "opening_balance";
    description: string;
    ref: string;
    amount: number;
    commissionAmount: number | null;
    commissionCurrency: string | null;
    isOtw?: boolean;
  };

  const ledgerByCurrency: Record<string, LedgerRow[]> = {};
  const addRow = (cc: string, row: LedgerRow) => {
    if (!ledgerByCurrency[cc]) ledgerByCurrency[cc] = [];
    ledgerByCurrency[cc].push(row);
  };

  // Container rows
  // Always use totalKg (declared/agreed weight) — weight differences at offload affect inventory
  // only, not what is owed to the supplier. This matches computeBalance and computeStats.
  for (const c of allContainers) {
    const supplierName = supplierNameOf(c.supplierId);
    const cc = c.currencyCode || "USD";
    const kg = parseFloat(c.totalKg || "0");
    const rate = parseFloat(c.ratePerKg || "0");
    // Own-paid freight must not appear in the supplier/broker balance ledger
    const freight = isSupplierPaidFreight(c) ? parseFloat(c.freight || "0") : 0;
    // Use freightCurrencyCode directly (DB default is "USD", so AUD containers correctly separate USD freight)
    const freightCc = c.freightCurrencyCode || cc;
    const freightSameCcy = freightCc === cc;
    // Freight is always a separate row — container row shows goods only
    const mainAmt = kg * rate;
    const commAmt = parseFloat(c.commissionAmount || "0");
    const commCc = c.commissionCurrencyCode || "USD";
    const dateVal = c.arrivalDate
      ? String(c.arrivalDate)
      : c.createdAt
        ? new Date(c.createdAt).toISOString().split("T")[0]
        : null;

    addRow(cc, {
      date: dateVal,
      type: "container",
      description: `${c.containerNumber} - ${supplierName}`,
      ref: c.containerNumber,
      amount: mainAmt,
      commissionAmount: null,
      commissionCurrency: null,
      isOtw: c.status === "PENDING" || c.status === "IN_TRANSIT",
    });

    // Cross-currency freight: add as an individual ledger row in the freight currency section
    if (freight > 0 && !freightSameCcy) {
      addRow(freightCc, {
        date: dateVal,
        type: "freight",
        description: `Freight - ${c.containerNumber} (${supplierName})`,
        ref: c.containerNumber,
        amount: freight,
        commissionAmount: null,
        commissionCurrency: null,
      });
    }
    // Same-currency freight: add a separate freight row in the container's currency section
    if (freight > 0 && freightSameCcy) {
      addRow(cc, {
        date: dateVal,
        type: "freight",
        description: `Freight - ${c.containerNumber} (${supplierName})`,
        ref: c.containerNumber,
        amount: freight,
        commissionAmount: null,
        commissionCurrency: null,
      });
    }
    // USD commission from linked (child) suppliers goes directly to the broker's USD ledger,
    // but only when this broker is actually the designated commission recipient.
    // Commission from the broker's own containers and any non-USD commission stay excluded.
    const commSupplierId = c.commissionSupplierId ?? null;
    const commForBroker = commSupplierId === brokerId || commSupplierId === null;
    if (commAmt > 0 && commCc === "USD" && c.supplierId !== brokerId && commForBroker) {
      addRow("USD", {
        date: dateVal,
        type: "commission",
        description: `Commission from ${supplierName} — ${c.containerNumber}`,
        ref: c.containerNumber,
        amount: commAmt,
        commissionAmount: commAmt,
        commissionCurrency: commCc,
      });
    }
  }

  // Payment rows
  for (const p of allPayments) {
    const supplierName = supplierNameMap[p.supplierId] || "Unknown";
    const cc = p.currencyCode || "USD";
    addRow(cc, {
      date: p.date ? String(p.date) : null,
      type: "payment",
      description: `Payment — ${supplierName}`,
      ref: p.notes || "Payment",
      amount: -parseFloat(p.amount || "0"),
      commissionAmount: null,
      commissionCurrency: null,
    });
  }

  // Voucher-based payment rows (general accounting payments linked to factory suppliers)
  // Skip optional vouchers — they are informational only and don't affect the balance.
  for (const p of allVoucherPayments) {
    if (p.optional) continue;
    const cc = p.currency || "USD";
    const suppId = p.supplierId;
    const supplierName = suppId ? supplierNameMap[suppId] || "Unknown" : "Unknown";
    addRow(cc, {
      date: p.voucherDate ? String(p.voucherDate) : null,
      type: "payment",
      description: `Payment — ${supplierName}`,
      ref: p.voucherNumber || "Voucher Payment",
      amount: -parseFloat(p.debitAmount || "0"),
      commissionAmount: null,
      commissionCurrency: null,
    });
  }

  // FX transfer rows — deduplicate by id to avoid counting same transfer twice
  // Key logic: Only affect the broker's USD pool for transfers TO/FROM the broker.
  // For internal pool transfers (linked supplier → linked supplier), only show the
  // source-currency leg so each supplier's sub-balance is visible without distorting the pool total.
  // For USD→USD transfers FROM a linked supplier TO the broker, adding both fx_out and fx_in
  // to the USD section used to cancel them to zero — now we only add the correct directional row.
  const seenFxIds = new Set<number>();
  for (const t of allFx) {
    if (seenFxIds.has(t.id)) continue;
    seenFxIds.add(t.id);
    const fromCc = t.fromCurrencyCode || "USD";
    const fromAmt = parseFloat(t.fromAmount || "0");
    const toUsd = parseFloat(t.toAmountUsd || "0");
    const rate = fromAmt > 0 ? (toUsd / fromAmt).toFixed(4) : "1";
    const dateVal = t.date ? String(t.date) : null;
    const isFromBroker = t.fromSupplierId === brokerId;
    const isToBroker = t.toSupplierId === brokerId;

    // Non-USD source currency leg: always show fx_out in the foreign currency section
    // so the linked supplier's foreign-currency contribution is visible.
    if (fromCc !== "USD") {
      addRow(fromCc, {
        date: dateVal,
        type: "fx_out",
        description: `FX ${fromCc}→USD @ ${rate}`,
        ref: `FX-${t.id}`,
        amount: -fromAmt,
        commissionAmount: null,
        commissionCurrency: null,
      });
    }

    // USD pool: FX In — only when the broker is the recipient.
    // (Linked-supplier-to-linked-supplier USD transfers don't change the broker's pool.)
    if (isToBroker) {
      addRow("USD", {
        date: dateVal,
        type: "fx_in",
        description: `FX In from ${fromCc} @ ${rate}`,
        ref: `FX-${t.id}`,
        amount: toUsd,
        commissionAmount: null,
        commissionCurrency: null,
      });
    }

    // USD pool: FX Out — only when the broker is the sender (broker redistributes USD out).
    if (isFromBroker && fromCc === "USD") {
      addRow("USD", {
        date: dateVal,
        type: "fx_out",
        description: `FX USD out @ ${rate}`,
        ref: `FX-${t.id}`,
        amount: -fromAmt,
        commissionAmount: null,
        commissionCurrency: null,
      });
    }
  }

  // Offload additional charge rows
  // NOTE: do NOT filter by filteredContainerIdSet here. These charges are explicitly assigned
  // to a supplier via supplierId (already filtered at query level), so they belong on that
  // supplier's statement regardless of which supplier owns the container.
  // Post-offload charges can only be added to OFFLOADED containers, so OTW-toggle is irrelevant.
  for (const oc of allOffloadCharges) {
    const cc = oc.currencyCode || "USD";
    const amt = parseFloat(oc.amount || "0");
    const supplierName = supplierNameOf(oc.supplierId);
    const dateVal = oc.createdAt ? new Date(oc.createdAt).toISOString().split("T")[0] : null;
    addRow(cc, {
      date: dateVal,
      type: "other_charge",
      description: `${oc.description || "Additional Charge"} — ${supplierName}`,
      ref: `Container ${oc.containerId}`,
      amount: amt,
      commissionAmount: null,
      commissionCurrency: null,
    });
  }

  // Container-level other charge rows (linked via container → supplier)
  for (const oc of allContainerOtherCharges) {
    // Skip charges tied to OTW containers when toggle is off
    if (oc.containerId != null && !filteredContainerIdSet.has(oc.containerId)) continue;
    const cc = oc.chargeCurrencyCode || oc.containerCurrencyCode || "USD";
    const amt = parseFloat(oc.amount || "0");
    const dateVal = oc.createdAt ? new Date(oc.createdAt).toISOString().split("T")[0] : null;
    addRow(cc, {
      date: dateVal,
      type: "other_charge",
      description: `${oc.description || "Other Charge"} — ${oc.containerNumber || `Container ${oc.containerId}`}`,
      ref: oc.containerNumber || `Container ${oc.containerId}`,
      amount: amt,
      commissionAmount: null,
      commissionCurrency: null,
    });
  }

  // factory_containers.other_charges column where other_charges_supplier_id is in the broker group
  // (distinct from the factoryContainerOtherCharges table which is a separate multi-row charges table)
  const containerColOtherCharges =
    allSupplierIds.length > 0
      ? await db
          .select({
            id: factoryContainers.id,
            containerNumber: factoryContainers.containerNumber,
            otherCharges: factoryContainers.otherCharges,
            otherChargesSupplierId: factoryContainers.otherChargesSupplierId,
            otherChargesCurrencyCode: factoryContainers.otherChargesCurrencyCode,
            containerCurrencyCode: factoryContainers.currencyCode,
            arrivalDate: factoryContainers.arrivalDate,
            createdAt: factoryContainers.createdAt,
            supplierId: factoryContainers.supplierId,
          })
          .from(factoryContainers)
          .where(
            and(
              eq(factoryContainers.companyId, companyId),
              sql`${factoryContainers.otherChargesSupplierId} = ANY(${sqlArray(allSupplierIds)})`,
              sql`${factoryContainers.otherCharges}::numeric > 0`,
              isNull(factoryContainers.deletedAt)
            )
          )
      : [];

  for (const c of containerColOtherCharges) {
    // Skip charges tied to OTW containers when toggle is off
    if (!filteredContainerIdSet.has(c.id)) continue;
    const cc = c.otherChargesCurrencyCode || "USD";
    const amt = parseFloat(c.otherCharges || "0");
    const chargeSupplierName = supplierNameOf(c.otherChargesSupplierId);
    const containerSupplierName = supplierNameOf(c.supplierId);
    const dateVal = c.arrivalDate
      ? String(c.arrivalDate)
      : c.createdAt
        ? new Date(c.createdAt).toISOString().split("T")[0]
        : null;
    addRow(cc, {
      date: dateVal,
      type: "other_charge",
      description: `Other Charges — ${c.containerNumber} (${containerSupplierName} → ${chargeSupplierName})`,
      ref: c.containerNumber,
      amount: amt,
      commissionAmount: null,
      commissionCurrency: null,
    });
  }

  // Inject opening balance rows (always USD) for broker and all linked suppliers
  for (const s of allSuppliers) {
    const ob = parseFloat(s.openingBalance || "0");
    if (ob !== 0) {
      if (!ledgerByCurrency["USD"]) ledgerByCurrency["USD"] = [];
      ledgerByCurrency["USD"].unshift({
        date: null,
        type: "opening_balance" as const,
        description: `Opening Balance — ${s.name}`,
        ref: "OB",
        amount: ob,
        commissionAmount: null,
        commissionCurrency: null,
      });
    }
  }

  // Sort rows by date within each section
  for (const cc of Object.keys(ledgerByCurrency)) {
    ledgerByCurrency[cc].sort((a, b) => {
      const da = a.date ? new Date(a.date).getTime() : 0;
      const db2 = b.date ? new Date(b.date).getTime() : 0;
      return da - db2;
    });
  }

  // Build ledgers with running balance
  const currencyLedgers = Object.entries(ledgerByCurrency)
    .map(([cc, rows]) => {
      let runBal = 0;
      const rowsWithBal = rows.map((row) => {
        // Commission is excluded from the broker balance until explicitly transferred.
        // commissionAmount is always null now, but guard defensively.
        runBal += row.amount;
        return { ...row, runningBalance: runBal };
      });
      const containerRows = rows.filter((r) => r.type === "container");
      const totalContainers = containerRows.length;
      const totalValue = containerRows.reduce((s, r) => s + r.amount, 0);
      const totalPaid = Math.abs(rows.filter((r) => r.type === "payment").reduce((s, r) => s + r.amount, 0));
      const totalFxOut = Math.abs(rows.filter((r) => r.type === "fx_out").reduce((s, r) => s + r.amount, 0));
      const totalFxIn = rows.filter((r) => r.type === "fx_in").reduce((s, r) => s + r.amount, 0);
      const totalOtherCharges = rows.filter((r) => r.type === "other_charge").reduce((s, r) => s + r.amount, 0);
      const totalFreight = rows.filter((r) => r.type === "freight").reduce((s, r) => s + r.amount, 0);
      // A "broker pool" section is the USD section that has no containers —
      // it represents USD the broker has received from FX settlements and commission transfers.
      // Its balance is an ASSET (received), not a payable, so CR/DR labels are inverted vs normal sections.
      const isBrokerPool = cc === "USD" && totalContainers === 0 && totalFxIn > 0;
      return {
        currencyCode: cc,
        rows: rowsWithBal,
        totalContainers,
        totalValue: totalValue.toFixed(2),
        totalFreight: totalFreight.toFixed(2),
        totalOtherCharges: totalOtherCharges.toFixed(2),
        totalPaid: totalPaid.toFixed(2),
        totalFxOut: totalFxOut.toFixed(2),
        totalFxIn: totalFxIn.toFixed(2),
        netBalance: runBal.toFixed(2),
        isBrokerPool,
      };
    })
    .sort((a, b) =>
      a.currencyCode === "USD" ? 1 : b.currencyCode === "USD" ? -1 : a.currencyCode.localeCompare(b.currencyCode)
    );

  return { supplier: broker, linkedSuppliers: linkedRaw, currencyLedgers };
}
