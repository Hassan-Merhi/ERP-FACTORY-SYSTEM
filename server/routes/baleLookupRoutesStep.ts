// Extracted from ./baleLookupRoutes.ts: a stage of baleLookupRoutes.
import { eq, and, desc, sql, isNull } from "drizzle-orm";
import { db } from "../db";
import { storage } from "../storage";
import { canViewBookingInfo } from "./factory/customer-orders/bookingInfo";
import {
  auditLog,
  customerOrderBales,
  customerOrders,
  customers,
  factoryBaleProducts,
  factoryBales,
  factoryWorkers,
  locations,
} from "@shared/schema";
import type { Request, Response } from "express";

export type BaleLookupInfo = Pick<
  typeof factoryBales.$inferSelect,
  | "id"
  | "baleCode"
  | "productName"
  | "status"
  | "weightKg"
  | "costPerKg"
  | "totalCost"
  | "grade"
  | "stockEntryDate"
  | "pressedAt"
  | "finalizedAt"
  | "workerName"
  | "createdAt"
  | "updatedAt"
  | "deletedAt"
> & { isInLoadingOrder?: boolean };

/**
 * factory_bales.product_id and bale_label_prints.product_id both reference
 * factory_bale_products(id), so resolve the product there and only within the
 * session company: never another company's (or a legacy bale_products) row
 * that happens to share the number.
 */
async function getCompanyFactoryBaleProduct(productId: number, companyId: number) {
  const [product] = await db
    .select()
    .from(factoryBaleProducts)
    .where(and(eq(factoryBaleProducts.id, productId), eq(factoryBaleProducts.companyId, companyId)))
    .limit(1);
  return product ?? null;
}

export async function baleLookupRoutesStep({ req, res }: { req: Request; res: Response }) {
  const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
  if (!companyId) {
    return { done: true as const, value: res.status(400).json({ message: "No company selected" }) };
  }

  const referenceNumber = decodeURIComponent(req.params.referenceNumber).trim().toUpperCase();
  const bookingInfoVisible = canViewBookingInfo(req.session);
  const labelPrint = await storage.getBaleLabelPrintByReference(referenceNumber, companyId);

  // If no label print exists, try to find the bale directly in factory_bales
  // (bales can exist without a label print if entered manually / imported)
  // Use normalized comparison for legacy lowercase/whitespace references, but
  // reject ambiguous normalized duplicates rather than returning an arbitrary bale.
  if (!labelPrint) {
    const directBaleMatches = await db
      .select()
      .from(factoryBales)
      .where(
        and(
          eq(factoryBales.companyId, companyId),
          sql`LOWER(TRIM(${factoryBales.referenceNumber})) = LOWER(TRIM(${referenceNumber}))`
        )
      )
      .limit(2);

    if (directBaleMatches.length === 0) {
      return { done: true as const, value: res.status(404).json({ message: "Reference number not found" }) };
    }
    if (directBaleMatches.length > 1) {
      return {
        done: true as const,
        value: res.status(409).json({ message: "Reference number not found", code: "AMBIGUOUS_REFERENCE" }),
      };
    }
    const directBale = directBaleMatches[0];

    // Build a minimal response from the bale row alone
    let locationInfo = null;
    if (directBale.erpLocationId) {
      const [loc] = await db
        .select({ id: locations.id, name: locations.name, city: locations.city, state: locations.state })
        .from(locations)
        .where(eq(locations.id, directBale.erpLocationId))
        .limit(1);
      if (loc) locationInfo = loc;
    }

    let product = null;
    if (directBale.productId) {
      product = await getCompanyFactoryBaleProduct(directBale.productId, companyId);
    } else if (directBale.articleCode) {
      product = await storage.getBaleProductByArticleCode(directBale.articleCode, companyId);
    }

    // Use stored workerName first (denormalized); fall back to join if not yet populated
    let directWorkerName: string | null = directBale.workerName ?? null;
    if (!directWorkerName && directBale.finalizedBy) {
      const [wk] = await db
        .select({ fullName: factoryWorkers.fullName })
        .from(factoryWorkers)
        .where(eq(factoryWorkers.id, directBale.finalizedBy))
        .limit(1);
      if (wk) directWorkerName = wk.fullName;
    }

    // Check if this bale is in a non-deleted outbound order.
    // Soft-deleted orders are historical records only and must not make a bale look loaded.
    const [directOrderBale] = await db
      .select({
        orderId: customerOrderBales.orderId,
        status: customerOrders.status,
        invoiceNumber: customerOrders.invoiceNumber,
        orderDate: customerOrders.orderDate,
        containerNumber: customerOrders.containerNumber,
        shippingCompany: customerOrders.shippingCompany,
        containerNotes: customerOrders.containerNotes,
        destination: customerOrders.destination,
        bookingInfo: customerOrders.bookingInfo,
        loadingStartedAt: customerOrders.loadingStartedAt,
        loadingFinalizedAt: customerOrders.loadingFinalizedAt,
        grandTotal: customerOrders.grandTotal,
        totalQtyBales: customerOrders.totalQtyBales,
        customerName: customers.legalName,
        priceUsed: customerOrderBales.priceUsed,
        baleWeight: customerOrderBales.weight,
        scannedBy: customerOrderBales.scannedBy,
      })
      .from(customerOrderBales)
      .innerJoin(customerOrders, eq(customerOrderBales.orderId, customerOrders.id))
      .leftJoin(customers, eq(customerOrders.customerId, customers.id))
      .where(
        and(
          sql`LOWER(TRIM(${customerOrderBales.baleReference})) = LOWER(TRIM(${referenceNumber}))`,
          eq(customerOrders.companyId, companyId),
          isNull(customerOrders.deletedAt)
        )
      )
      .orderBy(
        sql`CASE ${customerOrders.status}
            WHEN 'FINALIZED' THEN 0 WHEN 'SOLD' THEN 1
            WHEN 'DISPATCHED' THEN 2 WHEN 'VERIFIED' THEN 3
            WHEN 'PENDING_VERIFICATION' THEN 4 WHEN 'LOADING' THEN 5
            ELSE 9 END`
      )
      .limit(1);
    let directLoadedOnOrder = null;
    let directIsInLoadingOrder = false;
    if (directOrderBale) {
      if (directOrderBale.status === "LOADING") directIsInLoadingOrder = true;
      directLoadedOnOrder = {
        ...directOrderBale,
        bookingInfo: bookingInfoVisible ? directOrderBale.bookingInfo : null,
        canViewBookingInfo: bookingInfoVisible,
      };
    }

    // If the bale's stored status is IN_STOCK but it's already on a finalized order,
    // derive the correct effective status so the Bale Explorer shows it accurately.
    const directOrderStatus = directLoadedOnOrder?.status;
    const directEffectiveStatus =
      directBale.status !== "IN_STOCK" || !directOrderStatus
        ? directBale.status
        : ["FINALIZED", "DISPATCHED", "SOLD"].includes(directOrderStatus)
          ? "SOLD"
          : directOrderStatus === "LOADING"
            ? "LOADING"
            : ["PENDING_VERIFICATION", "VERIFIED"].includes(directOrderStatus)
              ? "RESERVED_FOR_ORDER"
              : directBale.status;

    // Fetch audit history for this bale
    const directAuditHistory = await db
      .select({
        id: auditLog.id,
        action: auditLog.action,
        username: auditLog.username,
        changes: auditLog.changes,
        createdAt: auditLog.createdAt,
      })
      .from(auditLog)
      .where(and(eq(auditLog.tableName, "factory_bales"), eq(auditLog.recordId, directBale.id)))
      .orderBy(desc(auditLog.createdAt))
      .limit(30);

    return {
      done: true as const,
      value: res.json({
        labelPrint: null,
        product: product || null,
        baleInfo: {
          id: directBale.id,
          baleCode: directBale.baleCode,
          articleCode: product?.articleCode || directBale.articleCode || null,
          productName: directBale.productName,
          status: directEffectiveStatus,
          isInLoadingOrder: directIsInLoadingOrder,
          weightKg: directBale.weightKg,
          costPerKg: directBale.costPerKg,
          totalCost: directBale.totalCost,
          grade: directBale.grade,
          stockEntryDate: directBale.stockEntryDate,
          pressedAt: directBale.pressedAt,
          finalizedAt: directBale.finalizedAt,
          workerName: directWorkerName,
          createdAt: directBale.createdAt,
          updatedAt: directBale.updatedAt,
          deletedAt: directBale.deletedAt,
        },
        locationInfo,
        pressingBatch: null,
        mixBatch: null,
        containers_used: [],
        loadedOnOrder: directLoadedOnOrder,
        auditHistory: directAuditHistory,
      }),
    };
  }

  let printedByName = null;
  let scannedByName = null;
  if (labelPrint.printedByUserId) {
    const printedUser = await storage.getUser(labelPrint.printedByUserId);
    printedByName = printedUser?.username || null;
  }
  if (labelPrint.scannedByUserId) {
    const scannedUser = await storage.getUser(labelPrint.scannedByUserId);
    scannedByName = scannedUser?.username || null;
  }

  const product = labelPrint.productId
    ? await getCompanyFactoryBaleProduct(labelPrint.productId, companyId)
    : await storage.getBaleProductByArticleCode(labelPrint.articleCode, companyId);

  // ── Enrich with factory_bales data (stable id first, normalized reference fallback) ──

  const normalizedBaleReferenceMatch = sql`LOWER(TRIM(${factoryBales.referenceNumber})) = LOWER(TRIM(${referenceNumber}))`;

  return {
    done: false as const,
    companyId,
    referenceNumber,
    bookingInfoVisible,
    labelPrint,
    printedByName,
    scannedByName,
    product,
    normalizedBaleReferenceMatch,
  };
}
