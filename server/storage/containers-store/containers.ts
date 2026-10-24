import { eq, and, asc, sql, ne } from "drizzle-orm";
import { db } from "../../db";
import * as schema from "@shared/schema";
import type { Container, InsertContainer, PurchaseOrder } from "@shared/schema";
import { enrichContainerListOffloadingCost } from "../../services/containers/enrichContainerListOffloadingCost";

// ---------------------------------------------------------------------------
// Containers
// ---------------------------------------------------------------------------

export async function getAllContainers(companyId: number): Promise<Container[]> {
  return await db
    .select()
    .from(schema.containers)
    .where(eq(schema.containers.companyId, companyId))
    .orderBy(asc(schema.containers.containerNumber));
}

export async function getActiveContainers(companyId: number): Promise<Array<Container & { offloadingCost: string }>> {
  const rows = await db
    .select()
    .from(schema.containers)
    .where(and(eq(schema.containers.companyId, companyId), ne(schema.containers.status, "SOLD")))
    .orderBy(asc(schema.containers.containerNumber));
  return enrichContainerListOffloadingCost(rows, companyId);
}

export async function getSoldContainers(companyId: number) {
  return await db
    .select({
      containerId: schema.containers.id,
      containerNumber: schema.containers.containerNumber,
      supplierId: schema.containers.supplierId,
      status: schema.containers.status,
      importDate: schema.containers.importDate,
      itemsTotal: schema.containers.itemsTotal,
      chargesTotal: schema.containers.chargesTotal,
      grandTotal: schema.containers.grandTotal,
      saleId: schema.containerSales.id,
      customerId: schema.containerSales.customerId,
      customerName: schema.customers.legalName,
      saleDate: schema.containerSales.saleDate,
      containerCost: schema.containerSales.containerCost,
      commission: schema.containerSales.commission,
      commissionAccountId: schema.containerSales.commissionAccountId,
      totalAmount: schema.containerSales.totalAmount,
      notes: schema.containerSales.notes,
    })
    .from(schema.containers)
    .innerJoin(schema.containerSales, eq(schema.containers.id, schema.containerSales.containerId))
    .innerJoin(schema.customers, eq(schema.containerSales.customerId, schema.customers.id))
    .where(and(eq(schema.containers.companyId, companyId), eq(schema.containers.status, "SOLD")))
    .orderBy(sql`${schema.containerSales.saleDate} DESC`);
}

export async function getContainerById(id: number): Promise<Container | undefined> {
  const [container] = await db.select().from(schema.containers).where(eq(schema.containers.id, id));
  return container;
}

export async function getContainerByIdForCompany(id: number, companyId: number): Promise<Container | undefined> {
  const [container] = await db
    .select()
    .from(schema.containers)
    .where(and(eq(schema.containers.id, id), eq(schema.containers.companyId, companyId)));
  return container;
}

export async function getContainerByNumber(containerNumber: string): Promise<Container | undefined> {
  const [container] = await db
    .select()
    .from(schema.containers)
    .where(eq(schema.containers.containerNumber, containerNumber));
  return container;
}

export async function createContainer(container: InsertContainer): Promise<Container> {
  const [created] = await db.insert(schema.containers).values(container).returning();
  return created;
}

export async function updateContainer(id: number, updates: Partial<InsertContainer>): Promise<Container> {
  const [updated] = await db.update(schema.containers).set(updates).where(eq(schema.containers.id, id)).returning();
  return updated;
}

// ---------------------------------------------------------------------------
// Purchase Orders
// ---------------------------------------------------------------------------

export async function getAllPurchaseOrders(companyId: number): Promise<PurchaseOrder[]> {
  return await db
    .select()
    .from(schema.purchaseOrders)
    .where(eq(schema.purchaseOrders.companyId, companyId))
    .orderBy(asc(schema.purchaseOrders.poNumber));
}

export async function getPurchaseOrderById(id: number): Promise<PurchaseOrder | undefined> {
  const [po] = await db.select().from(schema.purchaseOrders).where(eq(schema.purchaseOrders.id, id));
  return po;
}

export async function getPurchaseOrderByIdForCompany(id: number, companyId: number): Promise<PurchaseOrder | undefined> {
  const [po] = await db
    .select()
    .from(schema.purchaseOrders)
    .where(and(eq(schema.purchaseOrders.id, id), eq(schema.purchaseOrders.companyId, companyId)));
  return po;
}

export async function getPurchaseOrdersByContainer(containerId: number): Promise<PurchaseOrder[]> {
  return await db.select().from(schema.purchaseOrders).where(eq(schema.purchaseOrders.containerId, containerId));
}

export async function getPurchaseOrdersByContainerForCompany(
  containerId: number,
  companyId: number
): Promise<PurchaseOrder[]> {
  return await db
    .select()
    .from(schema.purchaseOrders)
    .where(and(eq(schema.purchaseOrders.containerId, containerId), eq(schema.purchaseOrders.companyId, companyId)));
}
export async function getPurchaseOrdersBySupplier(supplierId: number, companyId: number) {
  return await db
    .select({
      id: schema.purchaseOrders.id,
      poNumber: schema.purchaseOrders.poNumber,
      companyId: schema.purchaseOrders.companyId,
      containerId: schema.purchaseOrders.containerId,
      containerNumber: schema.containers.containerNumber,
      importDate: schema.containers.importDate,
      itemsTotal: schema.purchaseOrders.itemsTotal,
      freight: schema.purchaseOrders.freight,
      surcharge: schema.purchaseOrders.surcharge,
      fumigation: schema.purchaseOrders.fumigation,
      documentCharges: schema.purchaseOrders.documentCharges,
      discount: schema.purchaseOrders.discount,
      otherCharges: schema.purchaseOrders.otherCharges,
      currency: schema.purchaseOrders.currency,
      createdAt: schema.purchaseOrders.createdAt,
      voucherId: schema.purchaseOrders.voucherId,
    })
    .from(schema.purchaseOrders)
    .leftJoin(schema.containers, eq(schema.purchaseOrders.containerId, schema.containers.id))
    .where(and(eq(schema.purchaseOrders.supplierId, supplierId), eq(schema.purchaseOrders.companyId, companyId)))
    .orderBy(sql`${schema.purchaseOrders.createdAt} DESC`);
}
