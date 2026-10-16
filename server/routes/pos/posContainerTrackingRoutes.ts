import type { Express, Request, Response } from "express";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { containers, locations, poLineItems, stockItems, userCompanyRoles } from "@shared/schema";
import { requireAuth, requireRole } from "../../auth";
import { db } from "../../db";
import { ACTIVE_STATUSES, fetchActiveContainers, type RawContainerRow } from "../../lib/gitHelpers";
import { storage } from "../../storage";
import { parseMoneyInput } from "../../lib/money";

type PosTrackingContext = {
  companyId: number;
  location: {
    id: number;
    name: string;
    code: string;
  };
};

/** The saved date is intentionally a calendar DATE, never a timestamp. */
function parsePortDepartureDate(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const [year, month, day] = value.split("-").map(Number);
  const timestamp = Date.UTC(year, month - 1, day);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== value) return undefined;
  // One-day grace across server/client timezones; client input still caps at local today.
  const tomorrowUTC = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  return value <= tomorrowUTC ? value : undefined;
}

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
          portDepartureDate: row.portDepartureDate,
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

  /** POS-only write: cannot mutate any other tracking or accounting field. */
  app.patch("/api/pos/containers-otw/:id/departure-date", requireAuth, requireRole("POS"), async (req, res) => {
    try {
      // requireRole also lets Developers through; do not permit them on this POS-only endpoint.
      if (req.user?.role !== "POS") return res.status(403).json({ message: "POS role required" });

      const context = await resolvePosTrackingContext(req, res);
      if (!context) return;
      const containerId = Number(req.params.id);
      if (!Number.isSafeInteger(containerId) || containerId <= 0) {
        return res.status(400).json({ message: "Invalid container ID" });
      }
      const body = req.body;
      if (!body || typeof body !== "object" || Array.isArray(body) ||
          Object.keys(body).length !== 1 || !Object.prototype.hasOwnProperty.call(body, "portDepartureDate")) {
        return res.status(400).json({ message: "Only portDepartureDate can be changed" });
      }
      const portDepartureDate = parsePortDepartureDate(body.portDepartureDate);
      if (portDepartureDate === undefined) {
        return res.status(400).json({ message: "Enter a valid port departure date, or null to clear it" });
      }

      const [[container], includeUnassigned] = await Promise.all([
        fetchActiveContainers([context.companyId], { containerId }),
        canShowUnassignedContainers(context),
      ]);
      if (!container || !containerMatchesAssignedLocation(container, context, includeUnassigned)) {
        return res.status(404).json({ message: "Container not found for your location" });
      }

      // Check company, original shop and active status in the UPDATE itself, to
      // protect against another user moving/offloading the container after the read.
      const [updated] = await db.update(containers)
        .set({ portDepartureDate })
        .where(and(
          eq(containers.id, containerId),
          eq(containers.companyId, context.companyId),
          container.shopName === null ? isNull(containers.shopName) : eq(containers.shopName, container.shopName),
          inArray(containers.status, [...ACTIVE_STATUSES])
        ))
        .returning({ id: containers.id, portDepartureDate: containers.portDepartureDate });
      if (!updated) return res.status(404).json({ message: "Container is no longer available" });
      res.setHeader("Cache-Control", "no-store");
      return res.json(updated);
    } catch (error) {
      return res.status(500).json({ message: error instanceof Error ? error.message : "Could not save departure date" });
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
        const quantity = parseMoneyInput(item.quantity)?.toNumber() ?? NaN;
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
          portDepartureDate: container.portDepartureDate,
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
