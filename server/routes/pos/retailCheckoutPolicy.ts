import { and, eq, isNull } from "drizzle-orm";
import { customers, retailPosSales } from "@shared/schema";
import { db } from "../../db";
import { RETAIL_MANAGER_ROLES } from "../../services/retail/retailDiscountApproval";
import type { RetailSaleInput } from "../../services/retail/retailSaleService";

/** Roles allowed to approve account credits and damaged (non-restock) returns. */
export function isRetailManagerRole(role: string | null | undefined): boolean {
  return (RETAIL_MANAGER_ROLES as readonly string[]).includes(role ?? "");
}

export interface RetailReturnRefusal {
  status: number;
  body: { code?: string; message: string };
}

/**
 * The sale's customer: optional for fully paid sales, but uncollected credit
 * must belong to a real, active, company-owned ERP customer — never an
 * anonymous walk-in or a free-text customer name.
 */
export async function resolveRetailSaleCustomer(
  companyId: number,
  body: { customerId?: number | null; customerName?: string | null; payments?: Array<{ method: string }> }
): Promise<{ customer: RetailSaleInput["customer"] } | RetailReturnRefusal> {
  const onCredit = Boolean(body.payments?.some((payment) => payment.method === "credit"));
  if (onCredit && !body.customerId) {
    return {
      status: 400,
      body: { code: "RETAIL_CREDIT_CUSTOMER_REQUIRED", message: "Select a customer before recording a credit sale" },
    };
  }
  if (!body.customerId) {
    return { customer: body.customerName?.trim() ? { id: null, name: body.customerName.trim() } : null };
  }
  const [row] = await db
    .select({ id: customers.id, legalName: customers.legalName, active: customers.active })
    .from(customers)
    .where(and(eq(customers.id, body.customerId), eq(customers.companyId, companyId), isNull(customers.deletedAt)))
    .limit(1);
  if (!row) return { status: 404, body: { message: "Customer not found" } };
  if (onCredit && !row.active) return { status: 400, body: { message: "Select an active customer for credit sales" } };
  return { customer: { id: row.id, name: row.legalName } };
}

/**
 * Authorization for one Retail return request, checked before any write.
 * A cashier shift is optional, as for sales: a refund made without one stays
 * off every drawer (see validateRetailShiftTx) rather than a closed shift.
 */
export async function retailReturnRefusal(input: {
  companyId: number;
  saleId: number;
  role: string | null | undefined;
  refundDestination: "original" | "customer_credit";
  items: Array<{ restock: boolean }>;
}): Promise<RetailReturnRefusal | null> {
  const accountCredit = input.refundDestination === "customer_credit";
  if (!isRetailManagerRole(input.role) && (accountCredit || input.items.some((item) => !item.restock))) {
    return {
      status: 403,
      body: {
        code: "RETAIL_RETURN_MANAGER_REQUIRED",
        message: "Manager access is required for account credits and damaged/non-restock returns",
      },
    };
  }
  if (!accountCredit) return null;
  // A credit to the customer account must belong to a named customer from this same company's sale.
  const [original] = await db
    .select({ customerId: retailPosSales.customerId })
    .from(retailPosSales)
    .where(and(eq(retailPosSales.companyId, input.companyId), eq(retailPosSales.id, input.saleId)))
    .limit(1);
  if (original?.customerId) return null;
  return {
    status: 400,
    body: {
      code: "RETAIL_RETURN_CUSTOMER_REQUIRED",
      message: "Assign an ERP customer to the original sale before issuing account credit",
    },
  };
}
