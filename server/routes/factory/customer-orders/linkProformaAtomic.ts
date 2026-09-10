import { and, eq, sql } from "drizzle-orm";
import { db } from "../../../db";
import { customerOrders, customerProformas, customerProformaLines } from "@shared/schema";
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
 * Link/unlink a LOADING order and its expected-line snapshot atomically.
 * Linking takes the target proforma advisory lock before the order row lock so
 * concurrent scanners/imports cannot consume the same capacity between the
 * validation read and the association write.
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

    if (order.proformaIdUsed !== input.proformaId) {
      const guard = await guardExistingOrderProformaLink(tx, {
        companyId: input.companyId,
        proformaId: input.proformaId,
        orderId: input.orderId,
        customerId: order.customerId,
      });
      if (!guard.allowed) throw new LinkOrderProformaError(guard.body.message, guard.status, guard.body);
    }

    const proformaLines = await tx
      .select()
      .from(customerProformaLines)
      .where(eq(customerProformaLines.proformaId, input.proformaId));

    // Validation is complete; now replace the expected-line snapshot and link
    // together. A failed validation never wipes the existing expected lines.
    await tx.execute(sql`DELETE FROM customer_order_expected_lines WHERE order_id = ${input.orderId}`);
    await tx
      .update(customerOrders)
      .set({ proformaIdUsed: input.proformaId })
      .where(eq(customerOrders.id, input.orderId));

    if (proformaLines.length > 0) {
      await tx.execute(sql`
        INSERT INTO customer_order_expected_lines
          (company_id, order_id, proforma_id, proforma_line_id, article_code, product_name, expected_qty)
        SELECT ${input.companyId}, ${input.orderId}, cpl.proforma_id, cpl.id,
               cpl.article_code, cpl.product_name, cpl.quantity
        FROM customer_proforma_lines cpl
        WHERE cpl.proforma_id = ${input.proformaId}
        ON CONFLICT (order_id, article_code) DO NOTHING
      `);
    }

    return {
      success: true,
      linked: { orderId: input.orderId, proformaId: input.proformaId, linesBackfilled: proformaLines.length },
    };
  });
}
