import type { customerOrders } from "@shared/schema";

/**
 * The audit identifier of a customer order: its order number when the row
 * carries one, else `Order #<id>` (what the order audit rows always recorded).
 */
export function orderAuditIdentifier(order: typeof customerOrders.$inferSelect, orderId: number): string {
  return (order as typeof order & { orderNumber?: string | null }).orderNumber || `Order #${orderId}`;
}
