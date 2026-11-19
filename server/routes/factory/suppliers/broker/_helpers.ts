import type { LedgerRow } from "./brokerStatementStep2";
/**
 * Shared state and helpers for the supplierBrokerRoutes routes.
 *
 * Extracted verbatim from the former single-file supplierBrokerRoutes.ts.
 */
import { type DatabaseOrTransaction } from "../../../../db";
import type { FactoryNetPositionAsOf } from "@shared/factoryNetPositionAsOf";
import { sqlArray } from "../../../../lib/sqlArray";
import { toMoney, sumMoney } from "../../../../lib/money";
import { factoryContainers } from "@shared/schema";
import { eq, and, sql, isNull } from "drizzle-orm";
import { brokerStatementStep } from "./brokerStatementStep";
import { brokerStatementStep2 } from "./brokerStatementStep2";

export const PAYABLE_CONTAINER_STATUSES = new Set(["OFFLOADED", "RECEIVED", "PARTIALLY_RECEIVED"]);

export const isPayableContainer = (c: Record<string, unknown>) =>
  PAYABLE_CONTAINER_STATUSES.has(String(c.status || "").toUpperCase());

/**
 * `asOf` (YYYY-MM-DD) limits the statement to what existed on that date, for
 * the historical factory Net Position. Omitted, the statement is current.
 */
export async function buildBrokerStatement(
  brokerId: number,
  companyId: number,
  includeOtw = false,
  options: { asOf?: string | null; knownAt?: FactoryNetPositionAsOf; executor?: DatabaseOrTransaction } = {}
) {
  const brh1 = await brokerStatementStep({ options, brokerId, companyId, includeOtw });
  if (brh1.done) return brh1.value;
  const {
    allContainerOtherCharges,
    filteredContainerIdSet,
    allSupplierIds,
    executor,
    supplierNameOf,
    allSuppliers,
    broker,
    linkedRaw,
  } = brh1;
  const brh2 = brokerStatementStep2({ brh1, brokerId });
  const { addRow, ledgerByCurrency } = brh2;

  // Container-level other charge rows (linked via container → supplier)
  for (const oc of allContainerOtherCharges) {
    // Skip charges tied to OTW containers when toggle is off
    if (oc.containerId != null && !filteredContainerIdSet.has(oc.containerId)) continue;
    const cc = oc.chargeCurrencyCode || oc.containerCurrencyCode || "USD";
    const amt = toMoney(oc.amount);
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
      ? await executor
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
    const amt = toMoney(c.otherCharges);
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
    const ob = toMoney(s.openingBalance);
    if (!ob.isZero()) {
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
      let runBal = toMoney(0);
      const rowsWithBal = rows.map((row) => {
        // Commission is excluded from the broker balance until explicitly transferred.
        // commissionAmount is always null now, but guard defensively.
        runBal = runBal.plus(row.amount);
        return {
          ...row,
          amount: row.amount.toNumber(),
          commissionAmount: row.commissionAmount?.toNumber() ?? null,
          runningBalance: runBal.toNumber(),
        };
      });
      const totalOf = (type: LedgerRow["type"]) => sumMoney(rows.filter((r) => r.type === type).map((r) => r.amount));
      const totalContainers = rows.filter((r) => r.type === "container").length;
      const totalValue = totalOf("container");
      const totalPaid = totalOf("payment").abs();
      const totalFxOut = totalOf("fx_out").abs();
      const totalFxIn = totalOf("fx_in");
      const totalOtherCharges = totalOf("other_charge");
      const totalFreight = totalOf("freight");
      const totalCommission = sumMoney(rows.map((r) => r.commissionAmount));
      // A "broker pool" section is the USD section that has no containers —
      // it represents USD the broker has received from FX settlements and commission transfers.
      // Its balance is an ASSET (received), not a payable, so CR/DR labels are inverted vs normal sections.
      const isBrokerPool = cc === "USD" && totalContainers === 0 && totalFxIn.gt(0);
      return {
        currencyCode: cc,
        rows: rowsWithBal,
        totalContainers,
        totalValue: totalValue.toFixed(2),
        totalFreight: totalFreight.toFixed(2),
        totalCommission: totalCommission.toFixed(2),
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
