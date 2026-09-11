import { and, eq, sql } from "drizzle-orm";

import {
  factoryContainers,
  factorySuppliers,
  factorySupplierFxTransfers,
  factorySupplierPayments,
} from "@shared/schema";
import { db } from "../../../db";
import { resolveStoredFxRate } from "../../../services/factory/currencyConversion";

/**
 * Per-linked-supplier rollups for a broker's statement.
 *
 * A broker supplier has child suppliers (factorySuppliers.parentId), and its
 * statement shows one group per child: that child's containers, its payments,
 * and the resulting balance. Extracted verbatim from the statement handler; it
 * returns the groups instead of pushing into a local array.
 *
 * `commissions` is passed in rather than re-queried: the caller has already
 * loaded every commission row for this broker, and re-fetching per linked
 * supplier would change the query count for no benefit.
 *
 * config/report-characterization.json pins the endpoint's output across the move.
 */
export async function buildLinkedSupplierGroups(
  supplierId: number,
  companyId: number,
  commissions: { containerId: number; commissionTotal: string }[]
) {
  // Phase 2: Broker statement — aggregate linked suppliers if this is a broker
  const linkedSuppliers = await db
    .select({ id: factorySuppliers.id, name: factorySuppliers.name })
    .from(factorySuppliers)
    .where(and(eq(factorySuppliers.parentId, supplierId), eq(factorySuppliers.companyId, companyId)));

  const linkedSupplierGroups = [];
  for (const linked of linkedSuppliers) {
    const linkedContainers = await db
      .select()
      .from(factoryContainers)
      .where(and(eq(factoryContainers.companyId, companyId), eq(factoryContainers.supplierId, linked.id)))
      .orderBy(factoryContainers.arrivalDate, factoryContainers.createdAt);

    const linkedPayments = await db
      .select()
      .from(factorySupplierPayments)
      .where(and(eq(factorySupplierPayments.companyId, companyId), eq(factorySupplierPayments.supplierId, linked.id)));

    const linkedFxTransfers = await db
      .select()
      .from(factorySupplierFxTransfers)
      .where(
        and(
          eq(factorySupplierFxTransfers.companyId, companyId),
          sql`(${factorySupplierFxTransfers.fromSupplierId} = ${linked.id} OR ${factorySupplierFxTransfers.toSupplierId} = ${linked.id})`
        )
      );

    const linkedByCurrency: Record<string, { containers: unknown[]; totalValue: number; totalCommission: number }> = {};
    for (const c of linkedContainers) {
      const kg = parseFloat(c.actualReceivedKg || c.totalKg || "0");
      const rate = parseFloat(c.ratePerKg || "0");
      const freight = parseFloat(c.freight || "0");
      const cc = c.currencyCode || "USD";
      // Use freightCurrencyCode directly (DB default is "USD", so AUD containers correctly separate USD freight)
      const freightCc = c.freightCurrencyCode || cc;
      const freightSameCcy = freightCc === cc;
      // Only include freight in this currency's value when it shares the container's currency
      const value = kg * rate + (freightSameCcy ? freight : 0);
      const cComms = commissions.filter((cm) => cm.containerId === c.id);
      const totalComm = cComms.reduce((s: number, cm) => s + parseFloat(cm.commissionTotal || "0"), 0);
      const commCc = c.commissionCurrencyCode || "USD";
      if (!linkedByCurrency[cc]) linkedByCurrency[cc] = { containers: [], totalValue: 0, totalCommission: 0 };
      linkedByCurrency[cc].containers.push({
        id: c.id,
        containerNumber: c.containerNumber,
        date: c.arrivalDate || c.createdAt,
        freight: freight.toFixed(2),
        freightCurrencyCode: freightCc,
        value: value.toFixed(2),
        currencyCode: cc,
        fxRateToUsd: (() => {
          const { fxRate, looksSet } = resolveStoredFxRate(cc, c.fxRateToUsd, c.fxRateConfirmed);
          return looksSet ? String(fxRate) : "unresolved";
        })(),
        status: c.status,
        commissionAmount: c.commissionAmount || "0",
        commissionCurrencyCode: commCc,
        commissionSupplierId: c.commissionSupplierId || null,
        commissionNotes: c.commissionNotes || null,
        notes: c.notes,
      });
      linkedByCurrency[cc].totalValue += value;
      // Cross-currency freight (e.g. USD freight on an AUD container) belongs to the
      // child supplier's own statement — NOT to the broker's linked-supplier view.
      // Once the child transfers it via an FX transfer, it settles on the child's
      // statement and disappears. The broker does not need to track it here.
      // Commission goes into its own currency bucket
      if (totalComm > 0) {
        if (!linkedByCurrency[commCc]) linkedByCurrency[commCc] = { containers: [], totalValue: 0, totalCommission: 0 };
        linkedByCurrency[commCc].totalCommission += totalComm;
      }
    }

    const linkedPaidByCurrency: Record<string, number> = {};
    for (const p of linkedPayments) {
      const cc = p.currencyCode || "USD";
      linkedPaidByCurrency[cc] = (linkedPaidByCurrency[cc] || 0) + parseFloat(p.amount || "0");
    }
    for (const t of linkedFxTransfers) {
      if (t.fromSupplierId === linked.id) {
        // Linked supplier sent funds out (FX Out) — counts as settled against their balance
        const cc = t.fromCurrencyCode || "USD";
        linkedPaidByCurrency[cc] = (linkedPaidByCurrency[cc] || 0) + parseFloat(t.fromAmount || "0");
      }
      if (t.toSupplierId === linked.id) {
        // Linked supplier received USD back (e.g. round-trip return from broker) —
        // reduces net-settled so the exposure is correctly restored.
        linkedPaidByCurrency["USD"] = (linkedPaidByCurrency["USD"] || 0) - parseFloat(t.toAmountUsd || "0");
      }
    }

    const linkedCurrencyGroups = Object.entries(linkedByCurrency).map(([cc, data]) => {
      const paid = linkedPaidByCurrency[cc] || 0;
      const netPayable = data.totalValue - data.totalCommission - paid;
      return {
        currencyCode: cc,
        containers: data.containers,
        totalValue: data.totalValue.toFixed(2),
        totalCommission: data.totalCommission.toFixed(2),
        totalPaid: paid.toFixed(2),
        netPayable: netPayable.toFixed(2),
        containerCount: data.containers.length,
        lastActivity:
          linkedContainers.length > 0
            ? linkedContainers[linkedContainers.length - 1].arrivalDate ||
              linkedContainers[linkedContainers.length - 1].createdAt
            : null,
      };
    });

    linkedSupplierGroups.push({
      supplierId: linked.id,
      supplierName: linked.name,
      containerCount: linkedContainers.length,
      currencyGroups: linkedCurrencyGroups,
      lastActivity:
        linkedContainers.length > 0
          ? linkedContainers[linkedContainers.length - 1].arrivalDate ||
            linkedContainers[linkedContainers.length - 1].createdAt
          : null,
    });
  }

  return linkedSupplierGroups;
}
