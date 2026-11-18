/**
 * fiscalTransferRoutes: PosTransferDetail endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Response } from "express";
import { getErrorMessage } from "../../lib/httpHandlers";
import { db } from "../../db";
import { requireAuth } from "../../auth";
import {
  stockItems,
  stockTransferVouchers,
  stockTransferItems,
  stockTransferRevisions,
  stockTransferRevisionItems,
  vouchers,
  locations,
} from "@shared/schema";
import { and, asc, eq, inArray, isNotNull, isNull, or } from "drizzle-orm";
import { getActiveCompanyPermissionContext } from "../../services/security/activeCompanyPermissionContext";
import { posDaybookTransferText } from "@shared/posDaybookTransferText";
import { getPosTransferScope, posTransferVisibleItems } from "../../services/pos/posDaybookTransferAccess";

function sendTransferNotFound(res: Response) {
  return res.status(404).json({ message: "Transfer not found" });
}

export function registerPosTransferDetailRoutes(app: Express) {
  // POS Transfer Order Detail endpoint - returns full detail with names
  app.get("/api/pos-transfer-detail", requireAuth, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const rawId = req.query.voucherId;
      const voucherId =
        typeof rawId === "string" && /^[1-9]\d*$/.test(rawId) ? Number(rawId) : null;
      if (!voucherId || !Number.isSafeInteger(voucherId)) {
        return res.status(400).json({ message: posDaybookTransferText.invalidId });
      }

      const [transferRow] = await db
        .select({
          id: stockTransferVouchers.id,
          voucherId: stockTransferVouchers.voucherId,
          sourceLocationId: stockTransferVouchers.sourceLocationId,
          destinationLocationId: stockTransferVouchers.destinationLocationId,
          notes: stockTransferVouchers.notes,
          inventoryApplied: stockTransferVouchers.inventoryApplied,
          createdAt: stockTransferVouchers.createdAt,
          voucherNumber: vouchers.voucherNumber,
          voucherDate: vouchers.voucherDate,
          optional: vouchers.optional,
        })
        .from(stockTransferVouchers)
        .innerJoin(vouchers, eq(stockTransferVouchers.voucherId, vouchers.id))
        .where(and(eq(stockTransferVouchers.voucherId, voucherId), eq(vouchers.companyId, companyId), isNull(vouchers.deletedAt)))
        .limit(1);
      if (!transferRow) return sendTransferNotFound(res);

      const access = await getActiveCompanyPermissionContext(req);
      const isPosUser = access.role === "POS";
      const posScope = isPosUser ? await getPosTransferScope(access, voucherId) : null;
      if (isPosUser && !posScope) return sendTransferNotFound(res);
      const requestedPosLocationId = posScope?.displayLocationId ?? null;

      const requiredLocationIds = new Set<number>([transferRow.destinationLocationId]);
      if (transferRow.sourceLocationId) requiredLocationIds.add(transferRow.sourceLocationId);
      if (requestedPosLocationId) requiredLocationIds.add(requestedPosLocationId);

      const transferLocationRows = await db
        .select({ id: locations.id, name: locations.name })
        .from(locations)
        .where(and(eq(locations.companyId, companyId), inArray(locations.id, Array.from(requiredLocationIds))));
      const locationMap = new Map(transferLocationRows.map((location) => [location.id, location.name]));

      const transferLocationsAreScoped =
        locationMap.has(transferRow.destinationLocationId) &&
        (!transferRow.sourceLocationId || locationMap.has(transferRow.sourceLocationId)) &&
        (!requestedPosLocationId || locationMap.has(requestedPosLocationId));
      if (!transferLocationsAreScoped) {
        return sendTransferNotFound(res);
      }

      const itemRows = await db
        .select({
          id: stockTransferItems.id,
          transferId: stockTransferItems.transferId,
          stockItemId: stockTransferItems.stockItemId,
          sourceLocationId: stockTransferItems.sourceLocationId,
          quantity: stockTransferItems.quantity,
          rate: stockTransferItems.rate,
          totalAmount: stockTransferItems.totalAmount,
          createdAt: stockTransferItems.createdAt,
          stockItemName: stockItems.name,
          sourceLocationName: locations.name,
        })
        .from(stockTransferItems)
        .innerJoin(
          stockItems,
          and(eq(stockTransferItems.stockItemId, stockItems.id), eq(stockItems.companyId, companyId))
        )
        .leftJoin(
          locations,
          and(eq(stockTransferItems.sourceLocationId, locations.id), eq(locations.companyId, companyId))
        )
        .where(
          and(
            eq(stockTransferItems.transferId, transferRow.id),
            or(isNull(stockTransferItems.sourceLocationId), isNotNull(locations.id))
          )
        );

      for (const item of itemRows) {
        if (item.sourceLocationId && item.sourceLocationName) {
          locationMap.set(item.sourceLocationId, item.sourceLocationName);
        }
      }

      // Destination-side POS users see all items (they receive everything).
      // Source-side POS users see only items assigned to their specific location:
      //   - Items with item-level sourceLocationId matching their location
      //   - Items with no item-level sourceLocationId AND voucher-level source matches (true single-source)
      const posLocationId = requestedPosLocationId;
      const isDestinationUser = posScope?.isDestination ?? false;
      const transferItems = posScope ? posTransferVisibleItems(itemRows, posScope) : itemRows;

      const revisionRows = await db
        .select()
        .from(stockTransferRevisions)
        .where(eq(stockTransferRevisions.transferId, transferRow.id))
        .orderBy(asc(stockTransferRevisions.revisionNumber));

      // POS users only see their own revisions; non-POS users (admins) see all
      // POS Daybook is a read-only stock view. Revision histories can reveal
      // unassigned sources and financial changes, so keep them for ERP roles.
      const visibleRevisionRows = isPosUser ? [] : revisionRows;

      const revisions = await Promise.all(
        visibleRevisionRows.map(async (revision) => {
          const revisionItemRows = await db
            .select({
              id: stockTransferRevisionItems.id,
              revisionId: stockTransferRevisionItems.revisionId,
              stockItemId: stockTransferRevisionItems.stockItemId,
              stockItemName: stockTransferRevisionItems.stockItemName,
              sourceLocationId: stockTransferRevisionItems.sourceLocationId,
              storedSourceLocationName: stockTransferRevisionItems.sourceLocationName,
              originalQuantity: stockTransferRevisionItems.originalQuantity,
              delta: stockTransferRevisionItems.delta,
              newQuantity: stockTransferRevisionItems.newQuantity,
              scopedSourceLocationName: locations.name,
            })
            .from(stockTransferRevisionItems)
            .innerJoin(
              stockItems,
              and(eq(stockTransferRevisionItems.stockItemId, stockItems.id), eq(stockItems.companyId, companyId))
            )
            .leftJoin(
              locations,
              and(eq(stockTransferRevisionItems.sourceLocationId, locations.id), eq(locations.companyId, companyId))
            )
            .where(
              and(
                eq(stockTransferRevisionItems.revisionId, revision.id),
                or(isNull(stockTransferRevisionItems.sourceLocationId), isNotNull(locations.id))
              )
            );

          return {
            ...revision,
            items: revisionItemRows.map(({ storedSourceLocationName, scopedSourceLocationName, ...item }) => ({
              ...item,
              sourceLocationName: scopedSourceLocationName ?? storedSourceLocationName,
            })),
          };
        })
      );

      res.json({
        transferId: transferRow.id,
        voucherId,
        voucherNumber: transferRow.voucherNumber,
        voucherDate: transferRow.voucherDate,
        optional: transferRow.optional,
        inventoryApplied: transferRow.inventoryApplied,
        sourceLocationId: isDestinationUser
          ? transferRow.sourceLocationId
          : (posLocationId ?? transferRow.sourceLocationId),
        sourceLocationName: isDestinationUser
          ? transferRow.sourceLocationId
            ? (locationMap.get(transferRow.sourceLocationId) ?? "Unknown")
            : "Multi-source"
          : posLocationId
            ? (locationMap.get(posLocationId) ?? "Unknown")
            : transferRow.sourceLocationId
              ? (locationMap.get(transferRow.sourceLocationId) ?? "Unknown")
              : "Multi-source",
        destinationLocationId: transferRow.destinationLocationId,
        destinationLocationName: locationMap.get(transferRow.destinationLocationId) ?? "Unknown",
        notes: transferRow.notes,
        items: isPosUser
          ? transferItems.map((item) => ({
              id: item.id,
              stockItemId: item.stockItemId,
              stockItemName: item.stockItemName,
              sourceLocationId: item.sourceLocationId,
              sourceLocationName: item.sourceLocationName,
              quantity: item.quantity,
            }))
          : transferItems,
        revisions,
      });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
