// Extracted from ./bulk-import.ts: a stage of bulk-import.
import { parseId } from "../../../../lib/parseId";
import { db } from "../../../../db";
import { factoryBaleProducts, customerOrders, customerOrderBales } from "@shared/schema";
import { eq, and } from "drizzle-orm";
import { isFactorySessionLocation } from "../../../helpers/companyOwnership";
import type { Request, Response } from "express";

export async function bulkImportStep({ req, res }: { req: Request; res: Response }) {
  const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
  if (!companyId) return { done: true as const, value: res.status(400).json({ message: "No company selected" }) };

  const orderId = parseId(req.params.id);

  if (orderId === null) return { done: true as const, value: res.status(400).json({ message: "Invalid id" }) };
  const { locationId, items, refNumbers: refNumbersRaw } = req.body;
  const ignoreProforma = req.body.allowBypassProforma === true;
  const hasRefNumbers = Array.isArray(refNumbersRaw) && refNumbersRaw.length > 0;
  const hasItems = Array.isArray(items) && items.length > 0;
  if (!locationId || (!hasItems && !hasRefNumbers)) {
    return {
      done: true as const,
      value: res.status(400).json({ message: "locationId and either items or refNumbers are required" }),
    };
  }
  if (!(await isFactorySessionLocation(req.session, locationId))) {
    return { done: true as const, value: res.status(400).json({ message: "Location not found" }) };
  }
  const scannerName: string | null = req.session?.username || req.session?.name || req.session?.email || null;

  const [order] = await db
    .select()
    .from(customerOrders)
    .where(and(eq(customerOrders.id, orderId), eq(customerOrders.companyId, companyId)));
  if (!order || order.deletedAt)
    return { done: true as const, value: res.status(404).json({ message: "Order not found" }) };
  if (!["DRAFT", "LOADING", "PENDING_VERIFICATION"].includes(order.status)) {
    return {
      done: true as const,
      value: res.status(400).json({ message: "Can only add bales to DRAFT, LOADING, or PENDING_VERIFICATION orders" }),
    };
  }

  // V5 guard: proformaIdUsed IS NOT NULL
  // V5 bales are SOLD once the order reaches PENDING_VERIFICATION — no further bulk scanning allowed.
  // Legacy V2/V3 behavior (PENDING_VERIFICATION scan allowed) is unchanged.
  if (order.proformaIdUsed && order.status === "PENDING_VERIFICATION") {
    return {
      done: true as const,
      value: res
        .status(400)
        .json({ message: "Cannot add bales to a V5 order that is already in PENDING_VERIFICATION" }),
    };
  }

  const parsedLocationId = parseInt(locationId);

  // Get all products for this company for matching
  const allProducts = await db.select().from(factoryBaleProducts).where(eq(factoryBaleProducts.companyId, companyId));

  // Get bales already in this order
  const existingOrderBales = await db
    .select({ baleId: customerOrderBales.baleId })
    .from(customerOrderBales)
    .where(eq(customerOrderBales.orderId, orderId));
  const alreadyAddedBaleIds = new Set(existingOrderBales.map((b) => b.baleId));

  let totalAdded = 0;
  const notFound: Array<{ articleCode: string; requestedQty: number; foundQty: number }> = [];
  const notFoundRefs: string[] = [];

  return {
    done: false as const,
    companyId,
    orderId,
    items,
    refNumbersRaw,
    ignoreProforma,
    hasRefNumbers,
    scannerName,
    order,
    parsedLocationId,
    allProducts,
    alreadyAddedBaleIds,
    totalAdded,
    notFound,
    notFoundRefs,
  };
}
