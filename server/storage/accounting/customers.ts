import { eq, and, isNull, ilike } from "drizzle-orm";
import { db } from "../../db";
import * as schema from "@shared/schema";

export async function getAllCustomers(companyId: number, search?: string, limit?: number): Promise<schema.Customer[]> {
  const conditions = [eq(schema.customers.companyId, companyId), isNull(schema.customers.deletedAt)];
  if (search) conditions.push(ilike(schema.customers.legalName, `%${search}%`));
  const query = db
    .select()
    .from(schema.customers)
    .where(and(...conditions))
    .orderBy(schema.customers.legalName);
  return limit ? await query.limit(limit) : await query;
}

export async function getCustomerById(id: number): Promise<schema.Customer | undefined> {
  const [customer] = await db.select().from(schema.customers).where(eq(schema.customers.id, id));
  return customer;
}

export async function getCustomerByCode(code: string, companyId: number): Promise<schema.Customer | undefined> {
  const [customer] = await db
    .select()
    .from(schema.customers)
    .where(and(eq(schema.customers.code, code), eq(schema.customers.companyId, companyId)));
  return customer;
}

/**
 * The insert schema omits `code` because it is allocated server-side, but the
 * column is NOT NULL — so the code is part of this function's contract rather
 * than something the row happens to carry. Stating it here is what lets the
 * insert be checked instead of asserted.
 */
export type CreateCustomerInput = schema.InsertCustomer & { code: string };

export async function createCustomer(customer: CreateCustomerInput): Promise<schema.Customer> {
  const [newCustomer] = await db.insert(schema.customers).values(customer).returning();
  return newCustomer;
}

export async function updateCustomer(id: number, updates: Partial<schema.InsertCustomer>): Promise<schema.Customer> {
  const [customer] = await db.update(schema.customers).set(updates).where(eq(schema.customers.id, id)).returning();
  return customer;
}

export async function deleteCustomer(id: number): Promise<void> {
  await db.update(schema.customers).set({ deletedAt: new Date(), active: false }).where(eq(schema.customers.id, id));
}

// ---------------------------------------------------------------------------
// Inter-Company Transfers
// ---------------------------------------------------------------------------
