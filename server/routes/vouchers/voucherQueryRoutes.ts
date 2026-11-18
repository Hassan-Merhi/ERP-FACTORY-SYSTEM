import { searchAny } from "@shared/searchNormalization";
import type { Express } from "express";
import { logger } from "../../lib/logger";
import { db } from "../../db";
import { storage } from "../../storage";
import { requireAuth, requireNonPOS } from "../../auth";

import { containers, vouchers } from "@shared/schema";
import { eq, and, inArray, sql, isNull } from "drizzle-orm";

import { buildVoucherPage, filterAndSortVouchers, parseVoucherListQuery } from "./voucherListPaging";
import { loadVoucherRelatedData } from "./voucherDetailBatching";
import { buildUnifiedSupplierLedger } from "./unifiedSupplierLedger";
import { resolveSupplierDestinations } from "../../services/intercompany/supplierDestinationRead";

import {
  assertActiveCompanyAccess,
  getAccessibleCompanyIds,
  isPrivilegedRole,
  resolveAuthorizedCompanyId,
  sendCompanyAccessError,
} from "../../security/companyAccessBoundary";
import { toMoney } from "../../lib/money";
import { withStockTransferNarrations } from "../../services/inventory/stockTransferNarration";
import { withPosZmwNativeTotals } from "../../services/pos/posVoucherNativeTotals";
import { withPosVoucherShiftUserIds } from "../../services/pos/posVoucherShiftOwnership";
import { getActiveCompanyPermissionContext } from "../../services/security/activeCompanyPermissionContext";
import { posDaybookTransferText } from "@shared/posDaybookTransferText";
import {
  getPosDaybookLocations,
  getPosTransferScope,
  isStockTransferVoucherType,
  posTransferVisibleItems,
  scopePosDaybookVouchers,
} from "../../services/pos/posDaybookTransferAccess";
import { withPropertiesRentalTenantNames } from "../../services/rental/rentalVoucherTenantRead";
import { keepRoutineVoucher } from "../../services/accounting/operationalCorrectionVisibility";
import {
  isInternalFactoryAdvanceReconciliation,
  isInternalHistoricalSupplierCatchup,
} from "../../services/accounting/internalHistoricalSupplierRoutineVisibility";

/**
 * After saving a journal voucher, if it has a customer entry + a ledger account entry,
 * look for order charges linked to that ledger account for that customer.
 * If exactly one charge is found, update its amount and recalculate the order totals.
 */

export function registerVoucherQueryRoutes(app: Express) {
  app.get("/api/vouchers", requireAuth, async (req, res) => {
    try {
      const access = await assertActiveCompanyAccess(req);
      const parsedListQuery = parseVoucherListQuery(req.query as Record<string, unknown>);
      if (!parsedListQuery.ok) return res.status(400).json({ message: parsedListQuery.message });
      const listQuery = parsedListQuery.query;
      const { startDate, endDate } = listQuery;

      // Always use the current company role; the session flag may be stale.
      const liveContext = await getActiveCompanyPermissionContext(req);
      const isPOS = liveContext.role === "POS";

      let vouchers;
      if (startDate && endDate) {
        vouchers = await storage.getVouchersByDateRange(access.activeCompanyId, startDate as string, endDate as string);
      } else {
        // No date range supplied — default to the last 90 days so we never do
        // a full-table scan. The UI already shows this window by default.
        // getVouchersByDateRange hits the vouchers_company_date_idx index.
        const end = new Date();
        const start = new Date();
        start.setDate(start.getDate() - 90);
        const fmt = (d: Date) => d.toISOString().slice(0, 10);
        vouchers = await storage.getVouchersByDateRange(access.activeCompanyId, fmt(start), fmt(end));
      }

      vouchers = (await withStockTransferNarrations(access.activeCompanyId, vouchers)).filter(
        (voucher) =>
          keepRoutineVoucher(voucher, req.session.currentRole) &&
          !isInternalHistoricalSupplierCatchup({
            companyId: access.activeCompanyId,
            voucherNumber: voucher.voucherNumber,
            description: voucher.description,
            createdAt: voucher.createdAt,
          }) &&
          // Internal, already-posted historical GL backfills are not routine
          // operator journals. Keep all official accounting and audit effects.
          !isInternalFactoryAdvanceReconciliation({
            companyId: access.activeCompanyId,
            id: voucher.id,
            voucherNumber: voucher.voucherNumber,
            voucherDate: voucher.voucherDate,
            description: voucher.description,
          })
      );

      // Preserve historical GL descriptions; enrich only the read model.
      vouchers = await withPropertiesRentalTenantNames(access.activeCompanyId, vouchers);

      // The source and destination stock legs, not a voucher header, decide
      // whether an assigned cashier can see each transfer. Zero all POS
      // transfer amounts; a transfer is movement, not cashier revenue.
      const sanitizedVouchers = isPOS ? await scopePosDaybookVouchers(vouchers, liveContext) : vouchers;

      const ownedVouchers = isPOS
        ? await withPosVoucherShiftUserIds(sanitizedVouchers, access.activeCompanyId)
        : sanitizedVouchers;
      const filteredVouchers = await withPosZmwNativeTotals(filterAndSortVouchers(ownedVouchers, listQuery));
      res.setHeader("Cache-Control", "private, max-age=30, stale-while-revalidate=30");
      if (!listQuery.paginated) return res.json(filteredVouchers);
      return res.json(buildVoucherPage(filteredVouchers, listQuery.page, listQuery.pageSize));
    } catch (error: unknown) {
      return sendCompanyAccessError(res, error);
    }
  });

  // Get unified ledger for a supplier across explicitly accessible companies
  app.get("/api/suppliers/:supplierId/unified-ledger", requireAuth, async (req, res) => {
    try {
      const access = await assertActiveCompanyAccess(req);
      const supplierId = parseInt(req.params.supplierId);

      if (isNaN(supplierId)) {
        return res.status(400).json({ message: "Invalid supplier ID" });
      }

      const { companyId, startDate, endDate } = req.query;
      const companyIds = companyId
        ? [await resolveAuthorizedCompanyId(req, companyId)]
        : isPrivilegedRole(access.role)
          ? [...(await getAccessibleCompanyIds(access.userId))].sort((left, right) => left - right)
          : [access.activeCompanyId];

      // Wave 14: one supplier rule (the posting company) — the engine's lines
      // and period opening per company, never the global parent setting.
      const isoDay = (value: unknown) =>
        typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : undefined;
      const result = await buildUnifiedSupplierLedger({
        supplierId,
        companyIds,
        startDate: isoDay(startDate),
        endDate: isoDay(endDate),
      });

      // Extract container numbers from narrations and resolve their IDs so the
      // frontend can build direct links.  Shipping container numbers follow the
      // ISO 6346 format: 4 uppercase letters + 7 digits (e.g. HASU5142160).
      const containerNumRegex = /[A-Z]{4}\d{7}/g;
      const containerNumberSet = new Set<string>();
      for (const t of result) {
        if (t.type !== "opening" && t.description) {
          const matches = t.description.match(containerNumRegex);
          if (matches) matches.forEach((m: string) => containerNumberSet.add(m));
        }
      }

      const containerIdMap = new Map<string, number>();
      if (containerNumberSet.size > 0) {
        const containerRows = await db
          .select({ id: containers.id, containerNumber: containers.containerNumber })
          .from(containers)
          .where(
            and(
              inArray(containers.companyId, companyIds),
              inArray(containers.containerNumber, Array.from(containerNumberSet))
            )
          );
        for (const c of containerRows) {
          containerIdMap.set(c.containerNumber, c.id);
        }
      }

      for (const t of result) {
        if (t.type !== "opening" && t.description) {
          const matches = t.description.match(containerNumRegex);
          if (matches && matches.length > 0) {
            t.containerNumber = matches[0];
            t.containerId = containerIdMap.get(matches[0]) ?? null;
          }
        }
      }

      // Attribute supplier transactions using actual intercompany PO links.
      // Unallocated payments and unrelated journals have no guessed destination.
      const destinations = await resolveSupplierDestinations({
        accessibleCompanyIds: companyIds,
        voucherIds: result.flatMap((row) => (row.voucherId == null ? [] : [row.voucherId])),
      });
      for (const row of result) {
        if (row.type !== "voucher") continue;
        const destination = row.voucherId == null ? undefined : destinations.byVoucherId.get(row.voucherId);
        const ordinaryPurchase = !destination && row.voucherType === "Purchase";
        row.destinationCompanyId = destination?.destinationCompanyId ?? (ordinaryPurchase ? row.companyId : null);
        row.destinationCompanyName = destination?.destinationCompanyName ?? (ordinaryPurchase ? row.companyName : null);
      }

      res.json(result); // Already in chronological order
    } catch (error: unknown) {
      return sendCompanyAccessError(res, error);
    }
  });

  app.get("/api/vouchers/optional", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const access = await assertActiveCompanyAccess(req);
      const companyId = access.activeCompanyId;

      const { type, locationId, startDate, endDate, search } = req.query;

      const conditions = [eq(vouchers.companyId, companyId), eq(vouchers.optional, true), isNull(vouchers.deletedAt)];

      if (type) {
        conditions.push(eq(vouchers.voucherType, type as string));
      }
      if (locationId) {
        conditions.push(eq(vouchers.locationId, parseInt(locationId as string)));
      }
      if (startDate) {
        conditions.push(sql`${vouchers.voucherDate} >= ${startDate as string}`);
      }
      if (endDate) {
        conditions.push(sql`${vouchers.voucherDate} <= ${endDate as string}`);
      }

      const results = await db
        .select()
        .from(vouchers)
        .where(and(...conditions))
        .orderBy(sql`${vouchers.voucherDate} DESC`);

      let filtered = results;
      if (search) {
        filtered = filtered.filter((r) => searchAny(search, r.voucherNumber, r.description, r.locationName));
      }

      res.json(filtered);
    } catch (error: unknown) {
      logger.error("Optional vouchers error:", { error });
      return sendCompanyAccessError(res, error);
    }
  });

  // Get a specific voucher with all entries and related data
  app.get("/api/vouchers/:id", requireAuth, async (req, res) => {
    try {
      const access = await assertActiveCompanyAccess(req);
      const id = parseInt(req.params.id);
      if (isNaN(id)) {
        return res.status(400).json({ message: "Invalid voucher ID" });
      }

      const voucher = await storage.getVoucherById(id);
      if (!voucher) {
        return res.status(404).json({ message: "Voucher not found" });
      }

      // Verify voucher belongs to current company
      if (voucher.companyId !== access.activeCompanyId) {
        return res.status(403).json({
          message: "Access denied: Voucher belongs to a different company",
        });
      }

      // A transfer is read-only to a POS cashier and visible only when the
      // actual source/destination stock legs include an assigned location.
      // Never return ledger entries, transfer valuations, or other sources'
      // item rows through the generic voucher detail endpoint.
      const liveContext = await getActiveCompanyPermissionContext(req);
      if (liveContext.role === "POS" && isStockTransferVoucherType(voucher.voucherType)) {
        const scope = await getPosTransferScope(liveContext, voucher.id);
        if (!scope) return res.status(404).json({ message: posDaybookTransferText.notFound });
        const { transferData } = await loadVoucherRelatedData(voucher);
        if (!transferData?.id) return res.status(404).json({ message: posDaybookTransferText.notFound });
        const visibleItems = posTransferVisibleItems(transferData.items, scope);
        return res.json({
          id: voucher.id,
          voucherNumber: voucher.voucherNumber,
          voucherType: voucher.voucherType,
          voucherDate: voucher.voucherDate,
          createdAt: voucher.createdAt,
          description: transferData.notes || voucher.description,
          optional: voucher.optional,
          locationId: scope.displayLocationId,
          locationName: scope.displayLocationName,
          totalAmount: "0",
          entries: [],
          transferData: {
            id: transferData.id,
            voucherId: voucher.id,
            sourceLocationId: scope.isDestination ? transferData.sourceLocationId : scope.displayLocationId,
            sourceLocationName: scope.isDestination
              ? transferData.sourceLocationName || "Multi-source"
              : scope.displayLocationName,
            destinationLocationId: transferData.destinationLocationId,
            destinationLocationName: transferData.destinationLocationName,
            inventoryApplied: "inventoryApplied" in transferData ? transferData.inventoryApplied : undefined,
            notes: transferData.notes,
            items: visibleItems.map((item) => ({
              id: item.id,
              stockItemId: item.stockItemId,
              stockItemCode: item.stockItemCode,
              stockItemName: item.stockItemName,
              stockItemUom: item.stockItemUom,
              sourceLocationId: item.sourceLocationId ?? scope.headerSourceLocationId,
              sourceLocationName: item.sourceLocationName,
              quantity: item.quantity,
            })),
          },
        });
      }
      if (liveContext.role === "POS") {
        if (voucher.voucherType !== "Sales") {
          return res.status(404).json({ message: "Voucher not found" });
        }
        const locations = await getPosDaybookLocations(liveContext);
        if (voucher.locationId == null || !locations.has(voucher.locationId)) {
          return res.status(404).json({ message: "Voucher not found" });
        }
      }

      const [displayVoucher] = await withPropertiesRentalTenantNames(access.activeCompanyId, [voucher]);
      const [entries, relatedData] = await Promise.all([
        storage.getVoucherEntriesByVoucher(id),
        loadVoucherRelatedData(voucher),
      ]);
      const { purchaseOrder, salesItems: salesItemsList, adjustmentData, transferData } = relatedData;

      // For credit sales, resolve customer name from the voucher entries.
      // Credit sale entries store the customer receivable account via ledgerAccountId
      // (not customerId). getVoucherEntriesByVoucher already joins ledgerAccounts and
      // returns accountName, so we just find the debit entry and use its accountName.
      let customerName: string | null = null;
      if (voucher.isCreditSale) {
        const debitEntry = entries.find((e) => toMoney(e.debitAmount).toNumber() > 0);
        if (debitEntry?.accountName && debitEntry.accountName !== "Unknown Account") {
          customerName = debitEntry.accountName;
        }
      }

      // Cashiers may inspect sales at any of their assigned locations, but
      // never receive general-ledger entries, costs, profits or other ERP data.
      if (liveContext.role === "POS") {
        const [nativeSale] = await withPosZmwNativeTotals([displayVoucher]);
        return res.json({
          id: voucher.id,
          voucherNumber: voucher.voucherNumber,
          voucherType: voucher.voucherType,
          voucherDate: voucher.voucherDate,
          createdAt: voucher.createdAt,
          description: voucher.description,
          optional: voucher.optional,
          locationId: voucher.locationId,
          locationName: voucher.locationName,
          totalAmount: voucher.totalAmount,
          currency: voucher.currency,
          exchangeRate: voucher.exchangeRate,
          isCreditSale: voucher.isCreditSale,
          nativeZmwTotal: nativeSale.nativeZmwTotal ?? null,
          customerName,
          entries: [],
          salesItems: (salesItemsList ?? []).map((item) => ({
            id: item.id,
            stockItemId: item.stockItemId,
            stockItemName: item.stockItemName,
            stockItemCode: item.stockItemCode,
            quantity: item.quantity,
            sellingPrice: item.sellingPrice,
          })),
        });
      }

      res.json({
        ...displayVoucher,
        entries,
        purchaseOrder,
        salesItems: salesItemsList,
        adjustmentData,
        transferData,
        customerName,
      });
    } catch (error: unknown) {
      return sendCompanyAccessError(res, error);
    }
  });

  // Update a voucher with entries (Admin, Owner, or Manager for today's vouchers)
}
