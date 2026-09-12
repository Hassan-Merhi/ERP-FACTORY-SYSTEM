import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../../../db";
import { customerOrders, factoryBales } from "@shared/schema";
import { firstRow, resultRows } from "../../../lib/queryResult";
import { recalculateOrderTotals } from "../_helpers";
import { getProformaCapacitySnapshot } from "../customer-orders/proformaCapacity";
import { acquireProformaCapacityTransactionLock } from "../customer-orders/proformaCapacityConcurrency";
import { validateProformaCapacityAdditions } from "../customer-orders/proformaCapacityEnforcement";

export class RestoreCancelledContainerError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 = 400,
    readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "RestoreCancelledContainerError";
  }
}

export async function restoreCancelledContainerAtomically(input: { companyId: number; orderId: number }) {
  const [before] = await db
    .select({
      id: customerOrders.id,
      status: customerOrders.status,
      proformaIdUsed: customerOrders.proformaIdUsed,
      loadingStartedAt: customerOrders.loadingStartedAt,
      customerId: customerOrders.customerId,
    })
    .from(customerOrders)
    .where(and(eq(customerOrders.id, input.orderId), eq(customerOrders.companyId, input.companyId)))
    .limit(1);
  if (!before) throw new RestoreCancelledContainerError("Container not found", 404);
  if (before.status !== "CANCELLED") {
    throw new RestoreCancelledContainerError("Only CANCELLED containers can be restored");
  }
  if (!before.proformaIdUsed) {
    throw new RestoreCancelledContainerError("Only V5 containers (linked to a proforma) can be restored here");
  }

  return db.transaction(async (tx) => {
    // A cancelled order contributes zero to capacity. Take the proforma lock
    // before restoring its rows so a scanner cannot consume the same remaining
    // quantity between this validation and the history reinsert.
    await acquireProformaCapacityTransactionLock(tx, {
      companyId: input.companyId,
      proformaId: before.proformaIdUsed!,
    });

    const [order] = await tx
      .select({
        id: customerOrders.id,
        status: customerOrders.status,
        proformaIdUsed: customerOrders.proformaIdUsed,
        loadingStartedAt: customerOrders.loadingStartedAt,
        customerId: customerOrders.customerId,
      })
      .from(customerOrders)
      .where(and(eq(customerOrders.id, input.orderId), eq(customerOrders.companyId, input.companyId)))
      .for("update");
    if (!order) throw new RestoreCancelledContainerError("Container not found", 404);
    if (order.status !== "CANCELLED" || order.proformaIdUsed !== before.proformaIdUsed) {
      throw new RestoreCancelledContainerError("Container changed while restore was starting. Please retry.");
    }

    const historyRows = resultRows<{
      baleId: number;
      articleCode: string | null;
    }>(
      await tx.execute(sql`
        SELECT bale_id AS "baleId", article_code AS "articleCode"
        FROM customer_order_bales_history
        WHERE order_id = ${input.orderId}
        ORDER BY id
      `)
    );

    if (historyRows.length > 0) {
      const baleIds = [...new Set(historyRows.map((row) => Number(row.baleId)).filter((id) => Number.isSafeInteger(id) && id > 0))];
      if (baleIds.length !== historyRows.length) {
        throw new RestoreCancelledContainerError("Cancelled container history contains invalid or duplicate bale links");
      }

      // Lock physical bales before checking whether another active order reused
      // them after this container was cancelled.
      const lockedBales = await tx
        .select({ id: factoryBales.id })
        .from(factoryBales)
        .where(and(eq(factoryBales.companyId, input.companyId), inArray(factoryBales.id, baleIds)))
        .orderBy(factoryBales.id)
        .for("update");
      if (lockedBales.length !== baleIds.length) {
        throw new RestoreCancelledContainerError("One or more archived bales no longer belong to this company");
      }

      const reused = firstRow<{ baleReference: string | null; orderId: number }>(
        await tx.execute(sql`
          SELECT cob.bale_reference AS "baleReference", cob.order_id AS "orderId"
          FROM customer_order_bales cob
          JOIN customer_orders co ON co.id = cob.order_id
          WHERE cob.bale_id = ANY(${baleIds}::int[])
            AND cob.order_id <> ${input.orderId}
            AND co.status <> 'CANCELLED'
            AND co.deleted_at IS NULL
          ORDER BY cob.id
          LIMIT 1
        `)
      );
      if (reused) {
        throw new RestoreCancelledContainerError(
          `Cannot restore: bale ${reused.baleReference || "#"} is already linked to active order #${reused.orderId}`
        );
      }

      const capacity = await getProformaCapacitySnapshot(tx, {
        companyId: input.companyId,
        proformaId: order.proformaIdUsed!,
        currentOrderId: input.orderId,
      });
      if (!capacity) throw new RestoreCancelledContainerError("Linked proforma is unavailable");

      const grouped = new Map<string, { articleCode: string; quantity: number }>();
      for (const row of historyRows) {
        const articleCode = String(row.articleCode || "").trim();
        const key = articleCode.toLowerCase();
        const existing = grouped.get(key);
        if (existing) existing.quantity += 1;
        else grouped.set(key, { articleCode, quantity: 1 });
      }
      const validation = validateProformaCapacityAdditions(capacity, [...grouped.values()]);
      if (!validation.allowed) {
        throw new RestoreCancelledContainerError(
          "Cannot restore: archived bales no longer fit the linked proforma's remaining capacity",
          400,
          { capacityIssues: validation.issues }
        );
      }
    }

    const restoreStatus = order.loadingStartedAt ? "LOADING" : "DRAFT";
    await tx.execute(sql`
      UPDATE customer_orders
      SET status = ${restoreStatus}, updated_at = NOW()
      WHERE id = ${input.orderId} AND company_id = ${input.companyId}
    `);

    await tx.execute(sql`
      DELETE FROM factory_daybook_entries
      WHERE company_id = ${input.companyId}
        AND tx_type = 'ORDER_CANCELLED'
        AND reference_id = ${input.orderId}
    `);

    if (historyRows.length > 0) {
      await tx.execute(sql`
        INSERT INTO customer_order_bales
          (order_id, bale_id, bale_reference, location_id, weight,
           article_code, bale_name, price_used, scanned_by)
        SELECT order_id, bale_id, bale_reference, location_id, weight,
               article_code, bale_name, price_used, scanned_by
        FROM customer_order_bales_history
        WHERE order_id = ${input.orderId}
      `);
      await tx.execute(sql`DELETE FROM customer_order_bales_history WHERE order_id = ${input.orderId}`);
    }

    await recalculateOrderTotals(tx, input.orderId);
    return { id: input.orderId, restoredTo: restoreStatus, balasRestored: historyRows.length };
  });
}
