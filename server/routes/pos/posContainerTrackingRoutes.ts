import type { Express, Request, Response } from "express";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { locations, poLineItems, stockItems, userCompanyRoles } from "@shared/schema";
import { requireAuth, requireRole } from "../../auth";
import { db } from "../../db";
import { fetchActiveContainers, type RawContainerRow } from "../../lib/gitHelpers";
import { storage } from "../../storage";

type PosTrackingContext = {
  companyId: number;
  location: {
    id: number;
    name: string;
    code: string;
  };
};

function normalizeLocationLabel(value: string | null | undefined): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function containerMatchesAssignedLocation(
  container: Pick<RawContainerRow, "shopName">,
  context: PosTrackingContext,
  includeUnassigned = false
): boolean {
  const shop = normalizeLocationLabel(container.shopName);
  if (!shop) return includeUnassigned;

  const assignedLabels = [context.location.name, context.location.code].map(normalizeLocationLabel).filter(Boolean);

  return assignedLabels.some((label) => label === shop);
}

/**
 * A blank shop cannot normally be exposed to a POS user because the destination
 * is unknown. The one safe exception is a company that currently has exactly
 * one distinct POS-assigned location. In that case an unassigned active
 * container cannot belong to a different POS location, so the sole POS location
 * may see it instead of silently losing the container from the list.
 */
async function canShowUnassignedContainers(context: PosTrackingContext): Promise<boolean> {
  const rows = await db
    .select({ assignedLocationId: userCompanyRoles.assignedLocationId })
    .from(userCompanyRoles)
    .where(and(eq(userCompanyRoles.companyId, context.companyId), eq(userCompanyRoles.role, "POS")));

  const assignedLocationIds = new Set(
    rows.map((row) => Number(row.assignedLocationId)).filter((id) => Number.isInteger(id) && id > 0)
  );

  return assignedLocationIds.size === 1 && assignedLocationIds.has(context.location.id);
}

async function resolvePosTrackingContext(req: Request, res: Response): Promise<PosTrackingContext | null> {
  const companyId = req.session.currentCompanyId;
  if (!companyId) {
    res.status(400).json({ message: "No company selected" });
    return null;
  }

  const rawLocationId = req.user?.assignedLocationId ?? req.session.currentLocationId;
  const assignedLocationId = Number(rawLocationId);
  if (!Number.isInteger(assignedLocationId) || assignedLocationId <= 0) {
    res.status(403).json({ message: "No location is assigned to this POS user" });
    return null;
  }

  const [location] = await db
    .select({ id: locations.id, name: locations.name, code: locations.code })
    .from(locations)
    .where(
      and(
        eq(locations.id, assignedLocationId),
        eq(locations.companyId, companyId),
        eq(locations.active, true),
        isNull(locations.deletedAt)
      )
    )
    .limit(1);

  if (!location) {
    res.status(403).json({ message: "The assigned POS location is unavailable" });
    return null;
  }

  return { companyId, location };
}

export function registerPosContainerTrackingRoutes(app: Express): void {
  app.get("/api/pos/containers-otw", requireAuth, requireRole("POS"), async (req, res) => {
    try {
      const context = await resolvePosTrackingContext(req, res);
      if (!context) return;

      const [rows, includeUnassigned] = await Promise.all([
        fetchActiveContainers([context.companyId]),
        canShowUnassignedContainers(context),
      ]);
      const containers = rows
        .filter((row) => containerMatchesAssignedLocation(row, context, includeUnassigned))
        .map((row) => ({
          id: row.id,
          containerNumber: row.containerNumber,
          supplierName: row.supplierName,
          supplierCode: row.supplierCode,
          status: row.status,
          eta: row.eta,
          numberPlate: row.numberPlate,
          trackingLocation: row.trackingLocation,
          agent: row.agent,
          transporter: row.transporter,
          docReceived: row.docReceived,
          docsSentDate: row.docsSentDate,
        }));

      res.setHeader("Cache-Control", "private, max-age=30, stale-while-revalidate=30");
      return res.json({
        assignedLocation: context.location,
        total: containers.length,
        containers,
      });
    } catch (error) {
      return res.status(500).json({
        message: error instanceof Error ? error.message : "Failed to load containers",
      });
    }
  });

  app.get("/api/pos/containers-otw/:id", requireAuth, requireRole("POS"), async (req, res) => {
    try {
      const context = await resolvePosTrackingContext(req, res);
      if (!context) return;

      const containerId = Number.parseInt(req.params.id, 10);
      if (!Number.isInteger(containerId) || containerId <= 0) {
        return res.status(400).json({ message: "Invalid container ID" });
      }

      const [[container], includeUnassigned] = await Promise.all([
        fetchActiveContainers([context.companyId], { containerId }),
        canShowUnassignedContainers(context),
      ]);
      if (!container || !containerMatchesAssignedLocation(container, context, includeUnassigned)) {
        return res.status(404).json({ message: "Container not found" });
      }

      const purchaseOrders = await storage.getPurchaseOrdersByContainer(containerId);
      const poIds = purchaseOrders.map((po) => po.id);
      const lineItems =
        poIds.length === 0
          ? []
          : await db
              .select({
                id: poLineItems.id,
                itemName: poLineItems.itemName,
                quantity: poLineItems.quantity,
                stockItemName: stockItems.name,
                stockItemCode: stockItems.code,
              })
              .from(poLineItems)
              .leftJoin(
                stockItems,
                and(eq(stockItems.id, poLineItems.stockItemId), eq(stockItems.companyId, context.companyId))
              )
              .where(inArray(poLineItems.poId, poIds))
              .orderBy(poLineItems.id);

      const items = lineItems.map((item) => ({
        itemName: item.stockItemName || item.itemName || "Item",
        itemCode: item.stockItemCode || "",
        quantity: String(item.quantity ?? "0"),
      }));
      const totalQty = items.reduce((sum, item) => {
        const quantity = Number.parseFloat(item.quantity);
        return sum + (Number.isFinite(quantity) ? quantity : 0);
      }, 0);

      res.setHeader("Cache-Control", "private, max-age=30, stale-while-revalidate=30");
      return res.json({
        container: {
          id: container.id,
          containerNumber: container.containerNumber,
          supplierName: container.supplierName,
          supplierCode: container.supplierCode,
          status: container.status,
          eta: container.eta,
          numberPlate: container.numberPlate,
          trackingLocation: container.trackingLocation,
          agent: container.agent,
          transporter: container.transporter,
          docReceived: container.docReceived,
          docsSentDate: container.docsSentDate,
        },
        items,
        totalQty,
      });
    } catch (error) {
      return res.status(500).json({
        message: error instanceof Error ? error.message : "Failed to load container",
      });
    }
  });
}
