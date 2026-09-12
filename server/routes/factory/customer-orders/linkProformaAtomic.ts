import { and, eq, sql } from "drizzle-orm";
import { db } from "../../../db";
import { customerOrders, customerProformas } from "@shared/schema";
import { acquireProformaCapacityTransactionLock } from "./proformaCapacityConcurrency";
import { guardExistingOrderProformaLink } from "./proformaCapacityWriteGuards";

export class LinkOrderProformaError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 = 400,
    readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "LinkOrderProformaError";
  }
}

export interface LinkOrderProformaInput {
  companyId: number;
  orderId: number;
  proformaId: number | null;
}

/**
 * Link/unlink a LOADING order atomically.
 *
 * A link added after an order is already in LOADING state is a reusable
 * pricing/reference association. It must not manufacture a per-container
 * quantity plan from the master proforma. Explicit container plans are created
 * earlier by the V5 DRAFT allocation flows in customer_order_expected_lines.
 *
 * Re-linking to the exact same proforma is a no-op so an existing planned
 * container never loses its customized expected quantities just because the
 * user saves the same link again.
 */
export async function linkOrderProformaAtomically(input: LinkOrderProformaInput) {
  return db.transaction(async (tx) => {
    if (input.proformaId) {
      await acquireProformaCapacityTransactionLock(tx, {
        companyId: input.companyId,
        proformaId: input.proformaId,
      });
    }

    const [order] = await tx
      .select()
      .from(customerOrders)
      .where(and(eq(customerOrders.id, input.orderId), eq(customerOrders.companyId, input.companyId)))
      .for("update");
    if (!order) throw new LinkOrderProformaError("Order not found", 404);
    if (order.status !== "LOADING") {
      throw new LinkOrderProformaError("Can only link a proforma to a LOADING order");
    }

    if (!input.proformaId) {
      await tx.execute(sql`DELETE FROM customer_order_expected_lines WHERE order_id = ${input.orderId}`);
      await tx.update(customerOrders).set({ proformaIdUsed: null }).where(eq(customerOrders.id, input.orderId));
      return { success: true, linked: { orderId: input.orderId, proformaId: null, linesBackfilled: 0 } };
    }

    // Saving the same association must not replace a customized per-container
    // expected plan with the master proforma quantities.
    if (order.proformaIdUsed === input.proformaId) {
      return {
        success: true,
        linked: { orderId: input.orderId, proformaId: input.proformaId, linesBackfilled: 0, unchanged: true },
      };
    }

    const [proforma] = await tx
      .select()
      .from(customerProformas)
      .where(and(eq(customerProformas.id, input.proformaId), eq(customerProformas.companyId, input.companyId)))
      .limit(1);
    if (!proforma || proforma.deletedAt) throw new LinkOrderProformaError("Proforma not found", 404);
    if (!proforma.isActive) throw new LinkOrderProformaError("Proforma is not active");
    if (order.customerId && proforma.customerId && order.customerId !== proforma.customerId) {
      throw new LinkOrderProformaError(
        `Customer mismatch: order belongs to customer #${order.customerId} but proforma belongs to customer #${proforma.customerId}. Cannot link.`
      );
    }

    const guard = await guardExistingOrderProformaLink(tx, {
      companyId: input.companyId,
      proformaId: input.proformaId,
      orderId: input.orderId,
      customerId: order.customerId,
    });
    if (!guard.allowed) throw new LinkOrderProformaError(guard.body.message, guard.status, guard.body);

    // Any plan tied to a different proforma is stale. Clear it, then create the
    // new association as reference-only. If a strict container plan is wanted,
    // it must be allocated explicitly before loading starts.
    await tx.execute(sql`DELETE FROM customer_order_expected_lines WHERE order_id = ${input.orderId}`);
    await tx
      .update(customerOrders)
      .set({ proformaIdUsed: input.proformaId })
      .where(eq(customerOrders.id, input.orderId));

    return {
      success: true,
      linked: { orderId: input.orderId, proformaId: input.proformaId, linesBackfilled: 0 },
    };
  });
}
