// Extracted from ./scan.ts to keep that module under the source-size cap.
import type { Request, Response } from "express";
import { parseId } from "../../../../lib/parseId";
import { getCompanyBusinessDate } from "../../../../lib/dateUtils";
import { db } from "../../../../db";
import { storage } from "../../../../storage";
import type { ScannedArticleTotalsPatch } from "./incrementalTotals";
import { customerOrderBales, customerOrders, factoryBales } from "@shared/schema";
import { and, eq, or, sql } from "drizzle-orm";
import { isFactorySessionLocation } from "../../../helpers/companyOwnership";

export type PickResult =
  | {
      ok: true;
      bale: typeof customerOrderBales.$inferSelect;
      line: ScannedArticleTotalsPatch["line"];
      totals: ScannedArticleTotalsPatch["totals"];
    }
  | { ok: false; httpStatus: number; body: Record<string, unknown> };

export async function handlePostFactoryCustomerOrdersIdBalesStep1(req: Request, res: Response) {
  const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
  if (!companyId) return { done: true as const, value: res.status(400).json({ message: "No company selected" }) };

  const orderId = parseId(req.params.id);
  if (orderId === null) return { done: true as const, value: res.status(400).json({ message: "Invalid id" }) };

  const { scanCode, locationId } = req.body;
  if (!scanCode || !locationId)
    return { done: true as const, value: res.status(400).json({ message: "scanCode and locationId are required" }) };
  if (!(await isFactorySessionLocation(req.session, locationId))) {
    return { done: true as const, value: res.status(400).json({ message: "Location not found" }) };
  }

  const isPriorityScan = req.body.priorityScan === true;
  if (isPriorityScan && (req.body.allowBypassProforma === true || req.body.allowBypassOverload === true)) {
    return {
      done: true as const,
      value: res.status(400).json({
        message:
          "Priority Scan cannot bypass proforma requirements or overload limits. Use the normal Pending Loading scanner for manual exceptions.",
      }),
    };
  }

  const parsedLocationId = Number.parseInt(String(locationId), 10);
  if (!Number.isInteger(parsedLocationId) || parsedLocationId <= 0) {
    return { done: true as const, value: res.status(400).json({ message: "scanCode and locationId are required" }) };
  }

  const scannerName: string | null = req.session?.username || req.session?.name || req.session?.email || null;
  const priorityScanBusinessDate = isPriorityScan
    ? getCompanyBusinessDate((await storage.getCompanySettings(companyId))?.timezone)
    : null;

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
  // V5 bales are SOLD once the order reaches PENDING_VERIFICATION — no further scanning allowed.
  // Legacy V2/V3 behavior (PENDING_VERIFICATION scan allowed) is unchanged.
  if (order.proformaIdUsed && order.status === "PENDING_VERIFICATION") {
    return {
      done: true as const,
      value: res
        .status(400)
        .json({ message: "Cannot add bales to a V5 order that is already in PENDING_VERIFICATION" }),
    };
  }

  const scanTrimmed = String(scanCode).trim();
  const scanLower = scanTrimmed.toLowerCase();
  const scanLike = `%${scanTrimmed}%`;

  // Successful scans used to pay for two preflight reads before entering the
  // transaction: one RESERVED_FOR_ORDER lookup and one product-name lookup.
  // Fold both into the locked candidate query instead. Exact reserved unique
  // identifiers still win so the user keeps the same descriptive error.
  const uniqueIdentifierCondition = or(
    sql`LOWER(${factoryBales.referenceNumber}) = ${scanLower}`,
    sql`LOWER(${factoryBales.baleCode}) = ${scanLower}`
  );
  const availableNameCondition = or(
    uniqueIdentifierCondition,
    sql`LOWER(${factoryBales.articleCode}) = ${scanLower}`,
    sql`LOWER(${factoryBales.productName}) = ${scanLower}`,
    sql`EXISTS (
          SELECT 1
          FROM factory_bale_products fbp
          WHERE fbp.id = ${factoryBales.productId}
            AND fbp.company_id = ${companyId}
            AND (
              LOWER(fbp.name) = ${scanLower}
              OR fbp.name ILIKE ${scanLike}
              OR LOWER(fbp.article_code) = ${scanLower}
              OR fbp.article_code ILIKE ${scanLike}
            )
        )`
  );

  return {
    done: false as const,
    availableNameCondition,
    companyId,
    isPriorityScan,
    order,
    orderId,
    parsedLocationId,
    priorityScanBusinessDate,
    scanCode,
    scanLower,
    scannerName,
    uniqueIdentifierCondition,
  };
}
