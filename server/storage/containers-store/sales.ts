import { eq, and, desc, sql } from "drizzle-orm";
import { db } from "../../db";
import * as schema from "@shared/schema";
import type {} from "@shared/schema";

export async function getContainerSales(companyId: number): Promise<schema.ContainerSale[]> {
  return await db
    .select()
    .from(schema.containerSales)
    .where(eq(schema.containerSales.companyId, companyId))
    .orderBy(desc(schema.containerSales.saleDate));
}

export async function getContainerSaleByContainerId(
  containerId: number,
  companyId: number
): Promise<schema.ContainerSale | undefined> {
  const [sale] = await db
    .select()
    .from(schema.containerSales)
    .where(and(eq(schema.containerSales.containerId, containerId), eq(schema.containerSales.companyId, companyId)));
  return sale;
}

export async function getContainerSalesByCustomer(
  customerId: number,
  companyId: number
): Promise<schema.ContainerSale[]> {
  return await db
    .select()
    .from(schema.containerSales)
    .where(and(eq(schema.containerSales.customerId, customerId), eq(schema.containerSales.companyId, companyId)))
    .orderBy(desc(schema.containerSales.saleDate));
}

export async function getContainerCountBySupplier(supplierId: number, companyId?: number): Promise<number> {
  const conditions = [eq(schema.containers.supplierId, supplierId)];
  if (companyId) conditions.push(eq(schema.containers.companyId, companyId));
  const result = await db
    .select({ count: sql<number>`count(*)` })
    .from(schema.containers)
    .where(and(...conditions));
  return Number(result[0]?.count || 0);
}
