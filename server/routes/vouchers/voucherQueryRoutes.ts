import type { Express } from "express";
import { logger } from "../../lib/logger";
import { db } from "../../db";
import { storage } from "../../storage";
import { requireAuth, requireNonPOS } from "../../auth";

import { containers, vouchers, posShifts, userLocations } from "@shared/schema";
import { eq, and, inArray, sql, isNull } from "drizzle-orm";

import { isParentCompanyContext } from "../helpers/supplierBalanceHelpers";
import { buildVoucherPage, filterAndSortVouchers, parseVoucherListQuery } from "./voucherListPaging";
import { loadVoucherRelatedData } from "./voucherDetailBatching";

/**
 * One line of the supplier statement.
 *
 * The synthetic "opening" row carries no voucher, so the voucher-derived fields
 * are nullable on this shape even though the underlying columns are NOT NULL.
 */
interface SupplierStatementTransaction {
  type: "voucher" | "opening";
  date: string | null;
  companyId: number | null;
  companyName: string;
  docNumber: string;
  voucherId: number | null;
  description: string;
  voucherType: string;
  debit: number;
  credit: number;
}

/**
 * A statement line with its running balance. Container fields are filled in
 * afterwards for rows whose narration mentions an ISO 6346 container number.
 */
interface SupplierStatementRow extends SupplierStatementTransaction {
  balance: number;
  containerNumber?: string;
  containerId?: number | null;
}
import {
  assertActiveCompanyAccess,
  getAccessibleCompanyIds,
  isPrivilegedRole,
  resolveAuthorizedCompanyId,
  sendCompanyAccessError,
} from "../../security/companyAccessBoundary";

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

      // Check if user is POS role
      const isPOS = req.session.currentRole === "POS";

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

      // Strip totalAmount from Stock Transfer vouchers for POS users
      let sanitizedVouchers = isPOS
        ? vouchers.map((v) => {
            // Check for all variants of Stock Transfer voucher type
            const isStockTransfer =
              v.voucherType === "Stock Transfer" ||
              v.voucherType === "StockTransfer" ||
              v.voucherType?.toLowerCase().includes("stock transfer");
            if (isStockTransfer) {
              const { totalAmount, ...rest } = v;
              return { ...rest, totalAmount: "0" };
            }
            return v;
          })
        : vouchers;

      // For POS users, only return vouchers from their assigned locations.
      // Ownership is NOT checked here — POS users can see all sales from their location
      // (not just their own). Ownership is enforced at detail/edit/send-invoice endpoints.
      if (isPOS && req.user?.id) {
        const assignedLocs = await db
          .select({ locationId: userLocations.locationId })
          .from(userLocations)
          .where(and(eq(userLocations.userId, req.user.id), eq(userLocations.companyId, access.activeCompanyId)));
        const allowedLocIds = assignedLocs.map((l) => l.locationId);
        if (allowedLocIds.length > 0) {
          sanitizedVouchers = sanitizedVouchers.filter(
            (v) => v.locationId === null || allowedLocIds.includes(v.locationId)
          );
        }
      }

      const filteredVouchers = filterAndSortVouchers(sanitizedVouchers, listQuery);
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

      const voucherEntryGroups = await Promise.all(
        companyIds.map((allowedCompanyId) =>
          storage.getVoucherEntriesBySupplier(
            supplierId,
            allowedCompanyId,
            startDate as string | undefined,
            endDate as string | undefined
          )
        )
      );
      const voucherEntries = voucherEntryGroups.flat();

      const companyRows = await Promise.all(
        companyIds.map((allowedCompanyId) => storage.getCompanyById(allowedCompanyId))
      );
      const companyMap = new Map(companyRows.filter(Boolean).map((company) => [company!.id, company!] as const));

      // Combine all transactions with company information
      const transactions: SupplierStatementTransaction[] = [];

      // Add voucher entries (which already include PO-generated vouchers)
      // No need to add POs separately as they're already represented by voucher entries
      for (const entry of voucherEntries) {
        const company = companyMap.get(entry.companyId);
        transactions.push({
          type: "voucher",
          date: entry.voucherDate,
          companyId: entry.companyId,
          companyName: company?.name || "Unknown",
          docNumber: entry.voucherNumber,
          voucherId: entry.voucherId,
          description: entry.narration || entry.voucherDescription || "",
          voucherType: entry.voucherType,
          debit: parseFloat(entry.debitAmount || "0"),
          credit: parseFloat(entry.creditAmount || "0"),
        });
      }

      // Sort by date ascending (oldest first) for correct running balance
      transactions.sort((a, b) => {
        const dateA = a.date ? new Date(a.date).getTime() : 0;
        const dateB = b.date ? new Date(b.date).getTime() : 0;
        return dateA - dateB;
      });

      // Get supplier opening balance
      const supplier = await storage.getSupplierById(supplierId);
      const globalOpeningBalance = parseFloat(supplier?.openingBalance || "0");

      // Opening balance is a historical property belonging to the explicitly
      // configured parent company — never guessed via "lowest company ID".
      // Use filterCompanyId if set, otherwise fall back to the session company so that
      // viewing "All Companies" from a sub-company session also hides the opening balance.
      const effectiveCompanyId = companyIds.length === 1 ? companyIds[0] : access.activeCompanyId;
      const isParentContext = await isParentCompanyContext(effectiveCompanyId);
      const openingBalance = isParentContext ? globalOpeningBalance : 0;

      // Add opening balance as first row if it exists
      const result: SupplierStatementRow[] = [];
      if (openingBalance !== 0) {
        result.push({
          type: "opening",
          date: null,
          companyId: null,
          companyName: "Opening Balance",
          docNumber: "-",
          voucherId: null,
          description: "Opening Balance",
          voucherType: "Opening",
          debit: 0,
          credit: 0,
          balance: openingBalance,
        });
      }

      // Calculate running balance starting from opening balance
      let balance = openingBalance;
      for (const t of transactions) {
        balance += t.credit - t.debit;
        result.push({ ...t, balance });
      }

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

      res.json(result); // Already in chronological order
    } catch (error: unknown) {
      return sendCompanyAccessError(res, error);
    }
  });

  // Get purchase orders for a specific supplier filtered by company
  app.get("/api/suppliers/:supplierId/purchase-orders", requireAuth, async (req, res) => {
    try {
      const access = await assertActiveCompanyAccess(req);
      const supplierId = parseInt(req.params.supplierId);

      if (isNaN(supplierId)) {
        return res.status(400).json({ message: "Invalid supplier ID" });
      }

      const { companyId } = req.query;
      const companyIds = companyId
        ? [await resolveAuthorizedCompanyId(req, companyId)]
        : isPrivilegedRole(access.role)
          ? [...(await getAccessibleCompanyIds(access.userId))].sort((left, right) => left - right)
          : [access.activeCompanyId];

      const companyRows = await Promise.all(
        companyIds.map((allowedCompanyId) => storage.getCompanyById(allowedCompanyId))
      );
      const companyNameMap = new Map(
        companyRows.filter(Boolean).map((company) => [company!.id, company!.name] as const)
      );
      const purchaseOrderGroups = await Promise.all(
        companyIds.map(async (allowedCompanyId) => {
          const purchaseOrders = await storage.getPurchaseOrdersBySupplier(supplierId, allowedCompanyId);
          return purchaseOrders.map((purchaseOrder) => ({
            ...purchaseOrder,
            companyName: companyNameMap.get(allowedCompanyId) ?? `Company ${allowedCompanyId}`,
          }));
        })
      );

      return res.json(purchaseOrderGroups.flat());
    } catch (error: unknown) {
      return sendCompanyAccessError(res, error);
    }
  });

  // Create a new voucher

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
        const s = (search as string).toLowerCase();
        filtered = filtered.filter(
          (r) =>
            r.voucherNumber.toLowerCase().includes(s) ||
            (r.description || "").toLowerCase().includes(s) ||
            (r.locationName || "").toLowerCase().includes(s)
        );
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

      // POS sales ownership is recorded through the linked shift.
      if (req.user?.role === "POS" && voucher.voucherType === "Sales") {
        const [ownedShift] = voucher.shiftId
          ? await db
              .select({ id: posShifts.id })
              .from(posShifts)
              .where(and(eq(posShifts.id, voucher.shiftId), eq(posShifts.userId, req.user.id)))
              .limit(1)
          : [];
        if (!ownedShift) {
          return res.status(403).json({ message: "Access denied" });
        }
      }

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
        const debitEntry = entries.find((e) => parseFloat(e.debitAmount || "0") > 0);
        if (debitEntry?.accountName && debitEntry.accountName !== "Unknown Account") {
          customerName = debitEntry.accountName;
        }
      }

      res.json({
        ...voucher,
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
