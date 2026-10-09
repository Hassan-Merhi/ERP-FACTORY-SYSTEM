import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "../../../db";
import { firstRow } from "../../../lib/queryResult";
import { getCompanyBusinessDate } from "../../../lib/dateUtils";
import { storage } from "../../../storage";
import { toMoney } from "../../../lib/money";
import {
  customerOrderBales,
  customerOrders,
  customerProformaLines,
  factoryBales,
  factoryBaleProducts,
  factorySettings,
} from "@shared/schema";
import { recalculateOrderTotals } from "../_helpers";
import { recalculateOrderTotalsForScannedArticle } from "./bale-scanning/incrementalTotals";
import { normalizeLoadingArticleCode } from "./bale-scanning/proformaScanPolicy";
import { evaluateProformaArticleCapacity } from "./proformaCapacityEnforcement";
import { getProformaCapacitySnapshot } from "./proformaCapacity";
import { acquireProformaCapacityTransactionLock } from "./proformaCapacityConcurrency";
import {
  PRIORITY_SCAN_LOCK_NAMESPACE,
  advanceSatisfiedPriorityScanConfigsLockedTx,
  resolvePriorityScanArticleTarget,
  reactivateAutoCompletedPriorityLoadingsLockedTx,
  type PriorityScanTransaction,
} from "./priorityScanQueue";

export interface AutomaticPriorityAllocation {
  baleId: number;
  referenceNumber: string;
  orderId: number;
  priority: number;
  color: string;
  source: "stock-entry" | "reprint" | "manual";
  existing: boolean;
}

/** Read directly in the write transaction; never rely on the 30s settings cache. */
export async function automaticPriorityModeEnabled(tx: PriorityScanTransaction, companyId: number) {
  const [settings] = await tx.select({ extraSettings: factorySettings.extraSettings })
    .from(factorySettings).where(eq(factorySettings.companyId, companyId));
  return ((settings?.extraSettings || {}) as Record<string, unknown>).automaticPriorityPrintingEnabled === true;
}

/** Caller must hold PRIORITY_SCAN_LOCK_NAMESPACE/companyId. */
export async function allocateAutomaticPriorityBaleTx(
  tx: PriorityScanTransaction,
  args: { companyId: number; baleId: number; username: string | null; userId: string | null; source: "stock-entry" | "reprint" }
): Promise<AutomaticPriorityAllocation | null> {
  const { companyId, baleId, username, userId, source } = args;
  const [bale] = await tx.select().from(factoryBales)
    .where(and(eq(factoryBales.id, baleId), eq(factoryBales.companyId, companyId), isNull(factoryBales.deletedAt)))
    .limit(1);
  if (!bale) return null;

  // An active snapshot has a company/bale uniqueness boundary. Reprinting an existing
  // allocation uses its original priority/color even after the queue changes.
  const existing = firstRow(await tx.execute(sql`
    SELECT order_id AS "orderId", priority, color, allocation_source AS "source",
           reversed_at AS "reversedAt"
      FROM factory_priority_auto_allocations
     WHERE company_id = ${companyId} AND bale_id = ${baleId}
       AND reversed_at IS NULL
     LIMIT 1
  `)) as { orderId: number; priority: number; color: string; source: "stock-entry" | "reprint"; reversedAt: string | null } | undefined;
  if (existing) {
    if (existing.reversedAt) return null;
    return {
      baleId, referenceNumber: bale.referenceNumber, orderId: Number(existing.orderId),
      priority: Number(existing.priority), color: existing.color, source: existing.source, existing: true,
    };
  }

  // Never move a bale previously scanned manually or assigned to another order.
  const linked = firstRow(await tx.execute(sql`
    SELECT cob.order_id AS "orderId", co.status
      FROM customer_order_bales cob JOIN customer_orders co ON co.id = cob.order_id
     WHERE cob.bale_id = ${baleId} AND co.company_id = ${companyId}
       AND co.status <> 'CANCELLED' AND co.deleted_at IS NULL
     LIMIT 1
  `)) as { orderId: number; status: string } | undefined;
  if (linked) {
    const prior = firstRow(await tx.execute(sql`
      SELECT priority, color FROM factory_priority_scan_history
       WHERE company_id = ${companyId} AND bale_id = ${baleId}
         AND order_id = ${linked.orderId} AND reversed_at IS NULL
       ORDER BY id ASC LIMIT 1
    `)) as { priority: number; color: string } | undefined;
    return prior ? {
      baleId, referenceNumber: bale.referenceNumber, orderId: Number(linked.orderId),
      priority: Number(prior.priority), color: prior.color, source: "manual", existing: true,
    } : null;
  }

  // OFF prevents NEW automatic allocation, but must never erase the original
  // label destination/color for a bale that was assigned while ON.
  if (!(await automaticPriorityModeEnabled(tx, companyId))) return null;
  if (bale.status !== "IN_STOCK" || !bale.erpLocationId) return null;

  const articleCode = (bale.articleCode || "").trim() ||
    (bale.productId
      ? (await tx.select({ articleCode: factoryBaleProducts.articleCode }).from(factoryBaleProducts)
          .where(and(eq(factoryBaleProducts.id, bale.productId), eq(factoryBaleProducts.companyId, companyId)))
          .limit(1))[0]?.articleCode?.trim()
      : "") || "";
  if (!articleCode) return null;

  // Lock proforma capacity in queue order BEFORE locking the bale, mirroring
  // the manual scanner's priority -> proforma -> bale locking convention.
  const target = await resolvePriorityScanArticleTarget(tx, companyId, articleCode);
  if (!target) return null;

  const [lockedBale] = await tx.select().from(factoryBales)
    .where(and(eq(factoryBales.companyId, companyId), eq(factoryBales.id, baleId)))
    .for("update");
  if (!lockedBale || lockedBale.deletedAt || lockedBale.status !== "IN_STOCK" ||
      !lockedBale.erpLocationId) return null;

  const [order] = await tx.select({ id: customerOrders.id, status: customerOrders.status,
    proformaIdUsed: customerOrders.proformaIdUsed })
    .from(customerOrders)
    .where(and(eq(customerOrders.companyId, companyId), eq(customerOrders.id, target.orderId)))
    .for("update");
  if (!order || order.status !== "LOADING" || order.proformaIdUsed !== target.proformaId) return null;

  // Under the proforma lock, recheck capacity and duplicates at the last write boundary.
  const snapshot = await getProformaCapacitySnapshot(tx, {
    companyId, proformaId: target.proformaId, currentOrderId: target.orderId,
  });
  // Use the same authoritative per-loading decision as the manual scanner.
  // Never fall back to a proforma's global capacity or bypass a full article.
  if (!snapshot) return null;
  const finalCapacityDecision = evaluateProformaArticleCapacity(
    snapshot, articleCode, 1, "per_loading"
  );
  if (!finalCapacityDecision.allowed) return null;
  const duplicate = firstRow(await tx.execute(sql`
    SELECT cob.id FROM customer_order_bales cob
      JOIN customer_orders co ON co.id = cob.order_id
     WHERE cob.bale_id = ${baleId} AND co.company_id = ${companyId}
       AND co.status <> 'CANCELLED' AND co.deleted_at IS NULL LIMIT 1
  `));
  if (duplicate) return null;

  const [product] = lockedBale.productId
    ? await tx.select({ name: factoryBaleProducts.name, nameAr: factoryBaleProducts.nameAr,
      sellingPrice: factoryBaleProducts.sellingPrice })
        .from(factoryBaleProducts)
        .where(and(eq(factoryBaleProducts.companyId, companyId),
          eq(factoryBaleProducts.id, lockedBale.productId))).limit(1)
    : [];
  const [proformaPrice] = await tx.select({
    pricingMode: customerProformaLines.pricingMode,
    pricePerKg: customerProformaLines.pricePerKg,
    pricePerBale: customerProformaLines.pricePerBale,
  }).from(customerProformaLines).where(and(
    eq(customerProformaLines.proformaId, target.proformaId),
    sql`LOWER(TRIM(${customerProformaLines.articleCode})) = ${normalizeLoadingArticleCode(articleCode)}`
  )).limit(1);
  const priceUsed = proformaPrice
    ? proformaPrice.pricingMode === "per_kg" && proformaPrice.pricePerKg
      ? toMoney(lockedBale.weightKg).times(toMoney(proformaPrice.pricePerKg)).toFixed(2)
      : proformaPrice.pricePerBale || "0"
    : product?.sellingPrice || "0";

  await tx.insert(customerOrderBales).values({
    orderId: target.orderId,
    baleId,
    baleReference: lockedBale.referenceNumber,
    locationId: lockedBale.erpLocationId,
    weight: lockedBale.weightKg,
    articleCode,
    baleName: product?.name || lockedBale.productName || articleCode,
    baleNameAr: product?.nameAr || null,
    priceUsed,
    scannedBy: username,
  });

  const businessDate = getCompanyBusinessDate((await storage.getCompanySettings(companyId))?.timezone);
  // The append-only scan timeline is the historical source of truth; the
  // active auto-allocation record links back to this exact event.
  const historyRow = firstRow(await tx.execute(sql`
    INSERT INTO factory_priority_scan_history
      (company_id, order_id, bale_id, reference_number, product_name, article_code,
       priority, color, business_date, scanned_by, assigned_by_user_id, proforma_id, allocation_source)
    VALUES (${companyId}, ${target.orderId}, ${baleId}, ${lockedBale.referenceNumber},
      ${product?.name || lockedBale.productName || articleCode}, ${articleCode},
      ${target.priority}, ${target.color}, ${businessDate}, ${username}, ${userId},
      ${target.proformaId}, ${source})
    RETURNING id
  `)) as { id: number | string } | undefined;
  if (!historyRow) throw new Error("Failed to save Priority Scan allocation history");

  await tx.execute(sql`
    INSERT INTO factory_priority_auto_allocations
      (company_id, bale_id, order_id, reference_number, priority, color, allocation_source,
       proforma_id, article_code, assigned_by_user_id, assigned_by_name, history_id)
    VALUES (${companyId}, ${baleId}, ${target.orderId},
      ${lockedBale.referenceNumber}, ${target.priority}, ${target.color}, ${source},
      ${target.proformaId}, ${articleCode}, ${userId}, ${username}, ${historyRow.id})
  `);

  if (lockedBale.stockEntryDate) {
    await tx.execute(sql`
      INSERT INTO factory_daily_bale_scans
        (company_id, scan_date, reference_number, article_code, product_name, weight_kg, scanned_by_user_id)
      VALUES (${String(companyId)}, ${lockedBale.stockEntryDate}, ${lockedBale.referenceNumber},
        ${articleCode}, ${product?.name || lockedBale.productName},
        ${lockedBale.weightKg}, ${userId})
      ON CONFLICT (company_id, scan_date, reference_number) DO NOTHING
    `);
  }
  await recalculateOrderTotalsForScannedArticle(tx, target.orderId, articleCode);
  await advanceSatisfiedPriorityScanConfigsLockedTx(tx, companyId, target.orderId);
  return { baleId, referenceNumber: lockedBale.referenceNumber, orderId: target.orderId,
    priority: target.priority, color: target.color, source, existing: false };
}

/** Caller holds the company queue lock. Keep historical evidence, remove only active links. */
export async function reversePriorityAllocationForDeletedBaleTx(
  tx: PriorityScanTransaction,
  args: {
    companyId: number;
    baleId: number;
    actor: string;
    actorId?: string | null;
    reason: string;
    detachedOrderId?: number;
    deferQueueRecovery?: boolean;
  }
): Promise<number[]> {
  const { companyId, baleId, actor, reason } = args;
  const rows = await tx.select({ id: customerOrderBales.id, orderId: customerOrderBales.orderId,
    status: customerOrders.status, proformaIdUsed: customerOrders.proformaIdUsed })
    .from(customerOrderBales)
    .innerJoin(customerOrders, eq(customerOrderBales.orderId, customerOrders.id))
    .where(and(eq(customerOrderBales.baleId, baleId), eq(customerOrders.companyId, companyId),
      isNull(customerOrders.deletedAt)));
  // Do not silently bypass invoicing or finalized-order accounting.
  if (rows.some((row) => !["DRAFT", "LOADING"].includes(row.status))) {
    throw new Error("Cannot delete a bale in a verified/finalized loading. Reverse the order financially first.");
  }
  const affected = [...new Set([...rows.map((r) => r.orderId), ...(args.detachedOrderId ? [args.detachedOrderId] : [])])];
  // Respect the existing priority -> proforma lock order.
  for (const id of [...new Set(rows.map((r) => r.proformaIdUsed).filter((id): id is number => id != null))].sort((a,b)=>a-b)) {
    await acquireProformaCapacityTransactionLock(tx, { companyId, proformaId: id });
  }

  // Verification/finalization may be happening outside the priority queue
  // lock. Lock the affected orders AFTER their proforma locks and recheck
  // their current status before removing any active bale/order links.
  for (const orderId of [...new Set(rows.map(r => r.orderId))].sort((a,b)=>a-b)) {
    const [lockedOrder] = await tx.select({ status: customerOrders.status })
      .from(customerOrders)
      .where(and(eq(customerOrders.id, orderId), eq(customerOrders.companyId, companyId)))
      .for("update");
    if (!lockedOrder || !["DRAFT", "LOADING"].includes(lockedOrder.status)) {
      throw new Error("Cannot delete a bale while its loading is verified, finalized or changing status.");
    }
  }

  if (rows.length) {
    await tx.delete(customerOrderBales).where(eq(customerOrderBales.baleId, baleId));
    for (const orderId of affected) await recalculateOrderTotals(tx, orderId);
  }
  await tx.execute(sql`
    UPDATE factory_priority_auto_allocations SET reversed_at = now(),
      reversed_by = ${actor}, reversal_reason = ${reason}
    WHERE company_id = ${companyId} AND bale_id = ${baleId} AND reversed_at IS NULL
  `);
  await tx.execute(sql`
    UPDATE factory_priority_scan_history
       SET reversed_at = now(), reversed_by = ${actor},
           reversed_by_user_id = ${args.actorId ?? null},
           reversal_reason = ${reason}
    WHERE company_id = ${companyId} AND bale_id = ${baleId} AND reversed_at IS NULL
  `);

  // Bulk removal callers defer recovery until ALL selected links are detached.
  // This guarantees input iteration order cannot decide which old loading
  // gets priority #1 when several auto-completed loadings reopen together.
  if (!args.deferQueueRecovery && affected.length > 0) {
    await reactivateAutoCompletedPriorityLoadingsLockedTx(tx, companyId, affected);
  }
  return affected;
}

export async function runAutomaticPriorityReprint(
  companyId: number, baleId: number, username: string | null, userId: string | null
): Promise<AutomaticPriorityAllocation | null> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${PRIORITY_SCAN_LOCK_NAMESPACE}, ${companyId})`);
    return allocateAutomaticPriorityBaleTx(tx, { companyId, baleId, username, userId, source: "reprint" });
  });
}

/** Prepare an entire print batch under ONE company lock and transaction.
 *  Invalid/deleted/foreign bales fail the batch instead of silently printing
 *  unallocated labels. Original assignments are returned when mode is OFF.
 *  The caller must not print if this operation fails.
 */
export interface AutomaticPriorityPrintCandidate {
  baleId?: number;
  referenceNumber?: string;
}
export interface AutomaticPriorityPrintResult {
  baleId: number;
  referenceNumber: string;
  priorityAllocation: AutomaticPriorityAllocation | null;
}
export async function runAutomaticPriorityPrintBatch(
  companyId: number,
  items: AutomaticPriorityPrintCandidate[],
  username: string | null,
  userId: string | null
): Promise<AutomaticPriorityPrintResult[]> {
  // Public client preflight is capped at 200 by its route, while legacy
  // /api/bale-label-prints can legitimately contain larger printing batches.
  if (!Array.isArray(items) || items.length === 0 || items.length > 5000) {
    throw new Error("Print batch must contain 1 to 5000 physical bales");
  }
  return db.transaction(async tx => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${PRIORITY_SCAN_LOCK_NAMESPACE}, ${companyId})`);
    const seen = new Set<number>();
    const out: AutomaticPriorityPrintResult[] = [];
    for (const item of items) {
      if (!item || typeof item !== "object") throw new Error("Invalid print batch item");
      const baleId = item.baleId;
      if (item.referenceNumber !== undefined && typeof item.referenceNumber !== "string") {
        throw new Error("Invalid bale reference");
      }
      const ref = item.referenceNumber?.trim();
      if (baleId === undefined && !ref) throw new Error("Each print requires a physical bale ID or exact reference");
      if (baleId !== undefined && (!Number.isSafeInteger(baleId) || baleId < 1)) {
        throw new Error("Invalid physical bale ID");
      }
      if (ref && ref.length > 100) throw new Error("Invalid bale reference");
      const [bale] = await tx.select({
        id: factoryBales.id,
        referenceNumber: factoryBales.referenceNumber,
      }).from(factoryBales).where(and(
        eq(factoryBales.companyId, companyId),
        isNull(factoryBales.deletedAt),
        ...(baleId !== undefined ? [eq(factoryBales.id, baleId)] :
          [sql`LOWER(${factoryBales.referenceNumber}) = ${ref!.toLowerCase()}`])
      )).limit(1);
      if (!bale) throw new Error("Bale not found or already deleted in this company");
      if (baleId !== undefined && ref && bale.referenceNumber.toLowerCase() !== ref.toLowerCase()) {
        throw new Error("Print reference does not match bale ID");
      }
      if (!seen.has(bale.id)) {
        seen.add(bale.id);
        const priorityAllocation = await allocateAutomaticPriorityBaleTx(tx, {
          companyId, baleId: bale.id, username, userId, source: "reprint",
        });
        out.push({ baleId: bale.id, referenceNumber: bale.referenceNumber, priorityAllocation });
      }
    }
    return out;
  });
}
