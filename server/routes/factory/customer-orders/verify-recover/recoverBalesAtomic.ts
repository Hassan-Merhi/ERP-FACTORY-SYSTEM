import { and, eq, inArray, or, sql } from "drizzle-orm";
import { db } from "../../../../db";
import {
  customerOrderBales,
  customerOrders,
  customerProformaLines,
  factoryBaleProducts,
  factoryBales,
} from "@shared/schema";
import { recalculateOrderTotals } from "../../_helpers";
import { firstRow, resultRows } from "../../../../lib/queryResult";
import { getProformaCapacitySnapshot } from "../proformaCapacity";
import { acquireProformaCapacityTransactionLock } from "../proformaCapacityConcurrency";
import {
  allocateRemainingProformaLines,
  evaluateProformaArticleCapacity,
} from "../proformaCapacityEnforcement";
import { normalizeLoadingArticleCode } from "../bale-scanning/proformaScanPolicy";

const RECOVERABLE_STATUSES = ["LOADING", "PENDING_VERIFICATION", "VERIFIED", "FINALIZED"];

export class RecoverBalesError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 = 400
  ) {
    super(message);
    this.name = "RecoverBalesError";
  }
}

async function loadOrderBeforeLock(companyId: number, orderId: number) {
  const [order] = await db
    .select()
    .from(customerOrders)
    .where(and(eq(customerOrders.id, orderId), eq(customerOrders.companyId, companyId)))
    .limit(1);
  if (!order) throw new RecoverBalesError("Order not found", 404);
  return order;
}

function assertOrderUnchanged(
  before: typeof customerOrders.$inferSelect,
  locked: typeof customerOrders.$inferSelect | undefined
) {
  if (!locked) throw new RecoverBalesError("Order not found", 404);
  if (locked.proformaIdUsed !== before.proformaIdUsed || locked.status !== before.status) {
    throw new RecoverBalesError("Order changed while recovery was starting. Please retry.");
  }
  if (!RECOVERABLE_STATUSES.includes(locked.status)) {
    throw new RecoverBalesError(
      "Recovery is only available for LOADING, PENDING_VERIFICATION, VERIFIED, or FINALIZED orders"
    );
  }
  return locked;
}

async function activeBaleLinkExists(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  baleId: number,
  orderId: number
): Promise<boolean> {
  return !!firstRow(
    await tx.execute(sql`
      SELECT cob.order_id
      FROM customer_order_bales cob
      JOIN customer_orders co ON co.id = cob.order_id
      WHERE cob.bale_id = ${baleId}
        AND cob.order_id <> ${orderId}
        AND co.status <> 'CANCELLED'
        AND co.deleted_at IS NULL
      LIMIT 1
    `)
  );
}

export async function recoverBalesByReferencesAtomically(input: {
  companyId: number;
  orderId: number;
  baleReferences: string[];
  scannerName: string | null;
}) {
  const before = await loadOrderBeforeLock(input.companyId, input.orderId);

  return db.transaction(async (tx) => {
    if (before.proformaIdUsed) {
      await acquireProformaCapacityTransactionLock(tx, {
        companyId: input.companyId,
        proformaId: before.proformaIdUsed,
      });
    }

    const [lockedOrder] = await tx
      .select()
      .from(customerOrders)
      .where(and(eq(customerOrders.id, input.orderId), eq(customerOrders.companyId, input.companyId)))
      .for("update");
    const order = assertOrderUnchanged(before, lockedOrder);

    const existingCount = Number(
      firstRow<{ count: number }>(
        await tx.execute(sql`SELECT COUNT(*)::int AS count FROM customer_order_bales WHERE order_id = ${input.orderId}`)
      )?.count ?? 0
    );
    if (existingCount > 0) {
      throw new RecoverBalesError(
        `Order already has ${existingCount} bale(s) linked. Recovery is only for orders with 0 linked bales.`
      );
    }

    const proformaLines = order.proformaIdUsed
      ? await tx.select().from(customerProformaLines).where(eq(customerProformaLines.proformaId, order.proformaIdUsed))
      : [];
    const priceByArticle = new Map<string, string>();
    for (const line of proformaLines) {
      priceByArticle.set(normalizeLoadingArticleCode(line.articleCode), line.pricePerBale);
    }

    const capacity = order.proformaIdUsed
      ? await getProformaCapacitySnapshot(tx, {
          companyId: input.companyId,
          proformaId: order.proformaIdUsed,
          currentOrderId: input.orderId,
        })
      : null;
    if (order.proformaIdUsed && !capacity) throw new RecoverBalesError("Linked proforma is unavailable");
    const pendingByArticle = new Map<string, number>();

    let linked = 0;
    const notFound: string[] = [];

    for (const rawRef of input.baleReferences) {
      const refClean = String(rawRef ?? "").trim();
      if (!refClean) continue;

      const [bale] = await tx
        .select({
          id: factoryBales.id,
          referenceNumber: factoryBales.referenceNumber,
          baleCode: factoryBales.baleCode,
          articleCode: factoryBales.articleCode,
          productName: factoryBales.productName,
          productId: factoryBales.productId,
          weightKg: factoryBales.weightKg,
          erpLocationId: factoryBales.erpLocationId,
          status: factoryBales.status,
          costPerKg: factoryBales.costPerKg,
          productArticleCode: sql<string | null>`(
            SELECT fbp.article_code
            FROM factory_bale_products fbp
            WHERE fbp.id = ${factoryBales.productId}
              AND fbp.company_id = ${input.companyId}
            LIMIT 1
          )`,
        })
        .from(factoryBales)
        .where(
          and(
            eq(factoryBales.companyId, input.companyId),
            or(
              sql`LOWER(${factoryBales.referenceNumber}) = ${refClean.toLowerCase()}`,
              sql`LOWER(${factoryBales.baleCode}) = ${refClean.toLowerCase()}`
            )
          )
        )
        .orderBy(factoryBales.id)
        .limit(1)
        .for("update");

      if (!bale) {
        notFound.push(refClean);
        continue;
      }
      if (await activeBaleLinkExists(tx, bale.id, input.orderId)) {
        notFound.push(`${refClean} (already linked to active order)`);
        continue;
      }

      const effectiveArticleCode = String(bale.articleCode || bale.productArticleCode || "").trim();
      const normalized = normalizeLoadingArticleCode(effectiveArticleCode);
      if (capacity) {
        const proposed = (pendingByArticle.get(normalized) || 0) + 1;
        const decision = evaluateProformaArticleCapacity(capacity, effectiveArticleCode, proposed);
        if (!decision.allowed) {
          notFound.push(
            decision.reason === "not_in_proforma"
              ? `${refClean} (article not on linked proforma)`
              : `${refClean} (proforma quantity exceeded)`
          );
          continue;
        }
        pendingByArticle.set(normalized, proposed);
      }

      const priceUsed = priceByArticle.get(normalized) || bale.costPerKg || "0";
      await tx.insert(customerOrderBales).values({
        orderId: input.orderId,
        baleId: bale.id,
        baleReference: bale.referenceNumber,
        locationId: bale.erpLocationId ?? 1,
        weight: bale.weightKg,
        articleCode: effectiveArticleCode || bale.articleCode,
        baleName: bale.productName || effectiveArticleCode || bale.baleCode,
        priceUsed,
        scannedBy: input.scannerName,
      });

      const targetStatus = ["VERIFIED", "FINALIZED"].includes(order.status) ? "SOLD" : "SOLD";
      if (bale.status !== targetStatus) {
        await tx
          .update(factoryBales)
          .set({ status: targetStatus, updatedAt: new Date() })
          .where(eq(factoryBales.id, bale.id));
      }
      linked++;
    }

    await recalculateOrderTotals(tx, input.orderId);
    return { linked, notFound };
  });
}

export async function autoRecoverBalesAtomically(input: {
  companyId: number;
  orderId: number;
  scannerName: string | null;
}) {
  const before = await loadOrderBeforeLock(input.companyId, input.orderId);
  if (!before.proformaIdUsed) {
    throw new RecoverBalesError("Auto-recover requires a proforma to be linked on this order");
  }

  return db.transaction(async (tx) => {
    await acquireProformaCapacityTransactionLock(tx, {
      companyId: input.companyId,
      proformaId: before.proformaIdUsed!,
    });

    const [lockedOrder] = await tx
      .select()
      .from(customerOrders)
      .where(and(eq(customerOrders.id, input.orderId), eq(customerOrders.companyId, input.companyId)))
      .for("update");
    const order = assertOrderUnchanged(before, lockedOrder);
    if (!order.proformaIdUsed) throw new RecoverBalesError("Auto-recover requires a linked proforma");

    const existingCount = Number(
      firstRow<{ count: number }>(
        await tx.execute(sql`SELECT COUNT(*)::int AS count FROM customer_order_bales WHERE order_id = ${input.orderId}`)
      )?.count ?? 0
    );
    if (existingCount > 0) {
      throw new RecoverBalesError(
        `Order already has ${existingCount} bale(s) linked. Use manual Recover Bales for partial recovery.`
      );
    }

    const proformaLines = await tx
      .select()
      .from(customerProformaLines)
      .where(eq(customerProformaLines.proformaId, order.proformaIdUsed));
    if (proformaLines.length === 0) throw new RecoverBalesError("No proforma lines found for this order's proforma");

    const capacity = await getProformaCapacitySnapshot(tx, {
      companyId: input.companyId,
      proformaId: order.proformaIdUsed,
      currentOrderId: input.orderId,
    });
    if (!capacity) throw new RecoverBalesError("Linked proforma is unavailable");

    const remainingAllocations = allocateRemainingProformaLines(proformaLines, capacity);
    let totalLinked = 0;
    const summary: { articleCode: string; linked: number; needed: number }[] = [];

    for (const allocation of remainingAllocations) {
      const { line, remainingQty: needed } = allocation;
      if (!line.articleCode || needed <= 0) continue;

      const candidates = await tx
        .select()
        .from(factoryBales)
        .where(
          and(
            eq(factoryBales.companyId, input.companyId),
            inArray(factoryBales.status, ["IN_STOCK", "SOLD", "RESERVED_FOR_ORDER"]),
            sql`${factoryBales.deletedAt} IS NULL`,
            sql`LOWER(TRIM(COALESCE(
              NULLIF(${factoryBales.articleCode}, ''),
              (SELECT fbp.article_code FROM factory_bale_products fbp WHERE fbp.id = ${factoryBales.productId} AND fbp.company_id = ${input.companyId} LIMIT 1),
              ''
            ))) = ${allocation.normalizedArticleCode}`,
            sql`NOT EXISTS (
              SELECT 1
              FROM customer_order_bales existing_cob
              JOIN customer_orders existing_co ON existing_co.id = existing_cob.order_id
              WHERE existing_cob.bale_id = ${factoryBales.id}
                AND existing_cob.order_id <> ${input.orderId}
                AND existing_co.status <> 'CANCELLED'
                AND existing_co.deleted_at IS NULL
            )`
          )
        )
        .orderBy(factoryBales.id)
        .limit(needed)
        .for("update");

      for (const bale of candidates) {
        await tx.insert(customerOrderBales).values({
          orderId: input.orderId,
          baleId: bale.id,
          baleReference: bale.referenceNumber,
          locationId: bale.erpLocationId ?? 1,
          weight: bale.weightKg,
          articleCode: line.articleCode,
          baleName: bale.productName || line.productName || line.articleCode,
          priceUsed: line.pricePerBale,
          scannedBy: input.scannerName,
        });
        totalLinked++;
      }

      summary.push({ articleCode: line.articleCode, linked: candidates.length, needed });
    }

    await recalculateOrderTotals(tx, input.orderId);
    return { linked: totalLinked, summary };
  });
}
