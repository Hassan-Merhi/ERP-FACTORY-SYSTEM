import { punctuationInsensitiveSearch } from "../lib/searchNormalization";
import { normalizeSearchText } from "@shared/searchNormalization";
import { parseId } from "../lib/parseId";
import { logger } from "../lib/logger";
import { requireNonPOS } from "../auth";
import type { Express, Request, RequestHandler } from "express";
import { db } from "../db";
import {
  vouchers,
  voucherEntries,
  ledgerAccounts,
  companies,
  salesItems,
  stockItems,
  stockTransferVouchers,
  stockTransferItems,
  stockAdjustmentVouchers,
  stockAdjustmentItems,
  purchaseOrders,
  poLineItems,
  suppliers,
  containers,
  customers,
  bankAccounts,
  employees,
  fixedAssets,
  factorySuppliers,
} from "../../shared/schema";
import { eq, and, gte, lte, inArray, or, asc, desc, sql, count, isNull, type SQL } from "drizzle-orm";
import {
  assertCompaniesAccess,
  assertCompanyAccess,
  getAccessibleCompanyIds,
  getCompanyAccessContext,
  parsePositiveCompanyId,
  sendCompanyAccessError,
} from "../security/companyAccessBoundary";

async function resolveGlobalCompanyScope(req: Request): Promise<{ userId: string; companyIds: number[] }> {
  const access = getCompanyAccessContext(req);
  const accessible = await getAccessibleCompanyIds(access.userId);
  return {
    userId: access.userId,
    companyIds: [...accessible].sort((left, right) => left - right),
  };
}

export function registerGlobalTransactionRoutes(app: Express, requireAuth: RequestHandler) {
  // GET /api/global/transactions
  // Returns vouchers across all ERP companies the user has access to.
  app.get("/api/global/transactions", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const { userId, companyIds: accessibleCompanyIds } = await resolveGlobalCompanyScope(req);

      const {
        startDate,
        endDate,
        companyIds: companyIdsParam,
        voucherType,
        currency,
        search,
        optional: optionalParam,
        includeFactory: includeFactoryParam,
        page: pageParam,
        limit: limitParam,
      } = req.query as Record<string, string>;

      const includeFactoryBool = includeFactoryParam === "true";

      const page = Math.max(1, parseInt(pageParam || "1"));
      const limit = Math.min(200, Math.max(1, parseInt(limitParam || "50")));
      const offset = (page - 1) * limit;

      // 1. Resolve which ERP company IDs this user may see
      let allowedCompanyIds: number[];

      const allowedTypeFilter = or(
        eq(companies.companyType, "erp"),
        eq(companies.companyType, "properties"),
        eq(companies.companyType, "factory"),
        eq(companies.companyType, "factory_v2"),
        eq(companies.companyType, "supplier_partner")
      );

      const erpCompanies = accessibleCompanyIds.length
        ? await db
            .select({ id: companies.id })
            .from(companies)
            .where(and(allowedTypeFilter, inArray(companies.id, accessibleCompanyIds)))
        : [];
      allowedCompanyIds = erpCompanies.map((c) => c.id);

      if (allowedCompanyIds.length === 0) {
        return res.json({ vouchers: [], total: 0, page, totalPages: 0, summary: [] });
      }

      // 1b. Optionally exclude factory companies (supplier_partner is ERP-like, always kept)
      if (!includeFactoryBool) {
        const nonFactoryCompanies = await db
          .select({ id: companies.id })
          .from(companies)
          .where(
            and(
              inArray(companies.id, allowedCompanyIds),
              or(
                eq(companies.companyType, "erp"),
                eq(companies.companyType, "properties"),
                eq(companies.companyType, "supplier_partner")
              )
            )
          );
        allowedCompanyIds = nonFactoryCompanies.map((c) => c.id);
        if (allowedCompanyIds.length === 0) {
          return res.json({ vouchers: [], total: 0, page, totalPages: 0, summary: [], companies: [] });
        }
      }

      // 2. Apply company filter from request (must be subset of allowed)
      let targetCompanyIds = allowedCompanyIds;
      if (companyIdsParam && companyIdsParam !== "all") {
        const requested = companyIdsParam.split(",").map((id) => parsePositiveCompanyId(id, "companyId"));
        await assertCompaniesAccess(userId, requested);
        targetCompanyIds = requested.filter((id) => allowedCompanyIds.includes(id));
        if (targetCompanyIds.length === 0) {
          return res.json({ vouchers: [], total: 0, page, totalPages: 0, summary: [] });
        }
      }

      // 3. Build WHERE conditions
      const conditions: (SQL | undefined)[] = [
        inArray(vouchers.companyId, targetCompanyIds),
        isNull(vouchers.deletedAt),
      ];

      if (startDate) conditions.push(gte(vouchers.voucherDate, startDate));
      if (endDate) conditions.push(lte(vouchers.voucherDate, endDate));
      if (voucherType && voucherType !== "all") {
        // Treat "Stock Transfer" and "StockTransfer" as the same type
        if (voucherType === "Stock Transfer" || voucherType === "StockTransfer") {
          conditions.push(or(eq(vouchers.voucherType, "Stock Transfer"), eq(vouchers.voucherType, "StockTransfer")));
        } else {
          conditions.push(eq(vouchers.voucherType, voucherType));
        }
      }
      if (currency && currency !== "all") conditions.push(eq(vouchers.currency, currency));

      // optional filter: "active" → false, "optional" → true, "all" → both
      if (optionalParam === "active") conditions.push(eq(vouchers.optional, false));
      if (optionalParam === "optional") conditions.push(eq(vouchers.optional, true));

      if (search) {
        conditions.push(
          or(
            punctuationInsensitiveSearch(vouchers.voucherNumber, String(search)),
            punctuationInsensitiveSearch(vouchers.description, String(search)),
            // narration search: check if any entry for this voucher matches
            sql`EXISTS (
              SELECT 1 FROM voucher_entries ve
              WHERE ve.voucher_id = ${vouchers.id}
              AND (
                ve.narration ILIKE ${"%" + search + "%"}
                OR regexp_replace(lower(COALESCE(ve.narration, '')), '[^[:alnum:]]+', '', 'g')
                  LIKE ${"%" + normalizeSearchText(search) + "%"}
              )
            )`
          )
        );
      }

      const whereClause = and(...conditions);

      // 4. Count total
      const [{ total }] = await db.select({ total: count() }).from(vouchers).where(whereClause);

      const totalCount = Number(total);
      const totalPages = Math.ceil(totalCount / limit);

      // 5. Fetch paginated vouchers with company name + first entry narration
      const rows = await db
        .select({
          id: vouchers.id,
          companyId: vouchers.companyId,
          companyName: companies.name,
          voucherNumber: vouchers.voucherNumber,
          voucherType: vouchers.voucherType,
          voucherDate: vouchers.voucherDate,
          totalAmount: vouchers.totalAmount,
          currency: vouchers.currency,
          optional: vouchers.optional,
          description: vouchers.description,
          deletedAt: vouchers.deletedAt,
          narration: sql<string>`(
            SELECT ve.narration FROM voucher_entries ve
            WHERE ve.voucher_id = ${vouchers.id}
            AND ve.narration IS NOT NULL AND ve.narration != ''
            LIMIT 1
          )`,
        })
        .from(vouchers)
        .innerJoin(companies, eq(companies.id, vouchers.companyId))
        .where(whereClause)
        .orderBy(asc(companies.name), desc(vouchers.voucherDate), desc(vouchers.id))
        .limit(limit)
        .offset(offset);

      // 6. Per-company summary (debit/credit totals for the filtered period)
      const summaryRows = await db
        .select({
          companyId: vouchers.companyId,
          companyName: companies.name,
          currency: vouchers.currency,
          voucherCount: count(),
          totalDebits: sql<string>`SUM(CASE WHEN ${voucherEntries.debitAmount}  > 0 THEN ${voucherEntries.debitAmount}  ELSE 0 END)`,
          totalCredits: sql<string>`SUM(CASE WHEN ${voucherEntries.creditAmount} > 0 THEN ${voucherEntries.creditAmount} ELSE 0 END)`,
        })
        .from(vouchers)
        .innerJoin(companies, eq(companies.id, vouchers.companyId))
        .innerJoin(voucherEntries, eq(voucherEntries.voucherId, vouchers.id))
        .where(whereClause)
        .groupBy(vouchers.companyId, companies.name, vouchers.currency)
        .orderBy(companies.name);

      // 7. Return all company names (for the filter dropdown)
      const allCompanyRows = await db
        .select({ id: companies.id, name: companies.name })
        .from(companies)
        .where(inArray(companies.id, allowedCompanyIds))
        .orderBy(companies.name);

      return res.json({
        vouchers: rows,
        total: totalCount,
        page,
        totalPages,
        summary: summaryRows,
        companies: allCompanyRows,
      });
    } catch (err) {
      logger.error("[GlobalTransactions]", { error: err });
      return sendCompanyAccessError(res, err);
    }
  });

  // GET /api/global/transactions/voucher-types
  // Returns the distinct voucher types present across the user's companies
  app.get("/api/global/transactions/voucher-types", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const { companyIds: accessibleCompanyIds } = await resolveGlobalCompanyScope(req);
      const typeFilter = or(
        eq(companies.companyType, "erp"),
        eq(companies.companyType, "properties"),
        eq(companies.companyType, "factory"),
        eq(companies.companyType, "factory_v2"),
        eq(companies.companyType, "supplier_partner")
      );
      const allowed = accessibleCompanyIds.length
        ? await db
            .select({ id: companies.id })
            .from(companies)
            .where(and(typeFilter, inArray(companies.id, accessibleCompanyIds)))
        : [];
      const allowedCompanyIds = allowed.map((c) => c.id);

      if (allowedCompanyIds.length === 0) return res.json([]);

      const types = await db
        .selectDistinct({ voucherType: vouchers.voucherType })
        .from(vouchers)
        .where(and(inArray(vouchers.companyId, allowedCompanyIds), isNull(vouchers.deletedAt)))
        .orderBy(vouchers.voucherType);

      return res.json(types.map((t) => t.voucherType));
    } catch (err) {
      logger.error("[GlobalTransactions/types]", { error: err });
      return sendCompanyAccessError(res, err);
    }
  });

  // GET /api/global/transactions/:voucherId/detail
  // Returns full voucher + entries after checking the voucher's company scope.
  app.get("/api/global/transactions/:voucherId/detail", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const { userId } = await resolveGlobalCompanyScope(req);
      const voucherId = parseId(req.params.voucherId);
      if (voucherId === null) return res.status(400).json({ message: "Invalid id" });
      if (isNaN(voucherId)) return res.status(400).json({ message: "Invalid voucher ID" });

      const [voucher] = await db
        .select({
          id: vouchers.id,
          companyId: vouchers.companyId,
          companyName: companies.name,
          voucherNumber: vouchers.voucherNumber,
          voucherType: vouchers.voucherType,
          voucherDate: vouchers.voucherDate,
          totalAmount: vouchers.totalAmount,
          currency: vouchers.currency,
          optional: vouchers.optional,
          description: vouchers.description,
        })
        .from(vouchers)
        .innerJoin(companies, eq(companies.id, vouchers.companyId))
        .where(eq(vouchers.id, voucherId));

      if (!voucher) return res.status(404).json({ message: "Voucher not found" });
      await assertCompanyAccess(userId, voucher.companyId);

      const entriesRaw = await db
        .select({
          id: voucherEntries.id,
          ledgerAccountId: voucherEntries.ledgerAccountId,
          bankAccountId: voucherEntries.bankAccountId,
          fixedAssetId: voucherEntries.fixedAssetId,
          supplierId: voucherEntries.supplierId,
          employeeId: voucherEntries.employeeId,
          factorySupplierId: voucherEntries.factorySupplierId,
          customerId: voucherEntries.customerId,
          ledgerName: ledgerAccounts.name,
          bankName: bankAccounts.name,
          fixedAssetName: fixedAssets.name,
          supplierName: suppliers.legalName,
          employeeFirst: employees.firstName,
          employeeLast: employees.lastName,
          factorySupplierName: factorySuppliers.name,
          customerName: customers.legalName,
          debitAmount: voucherEntries.debitAmount,
          creditAmount: voucherEntries.creditAmount,
          narration: voucherEntries.narration,
        })
        .from(voucherEntries)
        .leftJoin(ledgerAccounts, eq(ledgerAccounts.id, voucherEntries.ledgerAccountId))
        .leftJoin(bankAccounts, eq(bankAccounts.id, voucherEntries.bankAccountId))
        .leftJoin(fixedAssets, eq(fixedAssets.id, voucherEntries.fixedAssetId))
        .leftJoin(suppliers, eq(suppliers.id, voucherEntries.supplierId))
        .leftJoin(employees, eq(employees.id, voucherEntries.employeeId))
        .leftJoin(factorySuppliers, eq(factorySuppliers.id, voucherEntries.factorySupplierId))
        .leftJoin(customers, eq(customers.id, voucherEntries.customerId))
        .where(eq(voucherEntries.voucherId, voucherId))
        .orderBy(voucherEntries.id);

      const entries = entriesRaw.map((e) => {
        const employeeName =
          e.employeeFirst && e.employeeLast
            ? `${e.employeeFirst} ${e.employeeLast}`.trim()
            : e.employeeFirst || e.employeeLast || null;
        return {
          ...e,
          accountName:
            e.ledgerName ||
            e.bankName ||
            e.fixedAssetName ||
            e.supplierName ||
            employeeName ||
            e.factorySupplierName ||
            e.customerName ||
            null,
        };
      });

      return res.json({ voucher, entries });
    } catch (err) {
      logger.error("[GlobalTransactions/detail]", { error: err });
      return sendCompanyAccessError(res, err);
    }
  });

  // GET /api/global/transactions/:voucherId/view-entries
  // Returns rich entries (items for Sales/Purchase/StockTransfer/Mixed) after
  // checking the voucher's company scope.
  app.get("/api/global/transactions/:voucherId/view-entries", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const { userId } = await resolveGlobalCompanyScope(req);
      const voucherId = parseId(req.params.voucherId);
      if (voucherId === null) return res.status(400).json({ message: "Invalid id" });
      if (isNaN(voucherId)) return res.status(400).json({ message: "Invalid voucher ID" });

      const [voucher] = await db
        .select({ id: vouchers.id, companyId: vouchers.companyId, voucherType: vouchers.voucherType })
        .from(vouchers)
        .where(eq(vouchers.id, voucherId));
      if (!voucher) return res.status(404).json({ message: "Voucher not found" });
      await assertCompanyAccess(userId, voucher.companyId);

      const type = voucher.voucherType;

      // Always fetch base ledger entries (resolve all account types)
      const rawEntries = await db
        .select({
          id: voucherEntries.id,
          ledgerAccountId: voucherEntries.ledgerAccountId,
          bankAccountId: voucherEntries.bankAccountId,
          fixedAssetId: voucherEntries.fixedAssetId,
          supplierId: voucherEntries.supplierId,
          employeeId: voucherEntries.employeeId,
          factorySupplierId: voucherEntries.factorySupplierId,
          customerId: voucherEntries.customerId,
          ledgerName: ledgerAccounts.name,
          bankName: bankAccounts.name,
          fixedAssetName: fixedAssets.name,
          supplierName: suppliers.legalName,
          employeeFirst: employees.firstName,
          employeeLast: employees.lastName,
          factorySupplierName: factorySuppliers.name,
          customerName: customers.legalName,
          debitAmount: voucherEntries.debitAmount,
          creditAmount: voucherEntries.creditAmount,
          narration: voucherEntries.narration,
        })
        .from(voucherEntries)
        .leftJoin(ledgerAccounts, eq(ledgerAccounts.id, voucherEntries.ledgerAccountId))
        .leftJoin(bankAccounts, eq(bankAccounts.id, voucherEntries.bankAccountId))
        .leftJoin(fixedAssets, eq(fixedAssets.id, voucherEntries.fixedAssetId))
        .leftJoin(suppliers, eq(suppliers.id, voucherEntries.supplierId))
        .leftJoin(employees, eq(employees.id, voucherEntries.employeeId))
        .leftJoin(factorySuppliers, eq(factorySuppliers.id, voucherEntries.factorySupplierId))
        .leftJoin(customers, eq(customers.id, voucherEntries.customerId))
        .where(eq(voucherEntries.voucherId, voucherId))
        .orderBy(voucherEntries.id);

      const entries = rawEntries.map((e) => {
        const employeeName =
          e.employeeFirst && e.employeeLast
            ? `${e.employeeFirst} ${e.employeeLast}`.trim()
            : e.employeeFirst || e.employeeLast || null;
        return {
          ...e,
          accountName:
            e.ledgerName ||
            e.bankName ||
            e.fixedAssetName ||
            e.supplierName ||
            employeeName ||
            e.factorySupplierName ||
            e.customerName ||
            null,
        };
      });

      // Sales: return ledger entries + sales item rows
      if (type === "Sales" || type === "POS") {
        const items = await db
          .select({
            id: salesItems.id,
            voucherId: salesItems.voucherId,
            stockItemId: salesItems.stockItemId,
            quantity: salesItems.quantity,
            sellingPrice: salesItems.sellingPrice,
            costPrice: salesItems.costPrice,
            totalSales: salesItems.totalSales,
            profit: salesItems.profit,
            configuredPrice: salesItems.configuredPrice,
            stockItemName: stockItems.name,
            stockItemCode: stockItems.code,
          })
          .from(salesItems)
          .leftJoin(stockItems, eq(salesItems.stockItemId, stockItems.id))
          .where(eq(salesItems.voucherId, voucherId));

        if (items.length > 0) {
          const itemRows = items.map((item) => {
            const qty = parseFloat(item.quantity) || 0;
            const price = parseFloat(item.sellingPrice) || 0;
            const cfg = parseFloat(item.configuredPrice || "0");
            const hassansProfit = cfg > 0 ? (price - cfg) * qty : 0;
            const hassansPercentage = cfg > 0 && cfg * qty > 0 ? (hassansProfit / (cfg * qty)) * 100 : 0;
            return {
              id: item.id,
              voucherId: item.voucherId,
              stockItemId: item.stockItemId,
              stockItemName: item.stockItemName || "Unknown Item",
              stockItemCode: item.stockItemCode || "-",
              quantity: item.quantity,
              rate: item.sellingPrice,
              sellingPrice: item.sellingPrice,
              costPrice: item.costPrice,
              totalSales: item.totalSales,
              profit: item.profit,
              hassansPrice: cfg > 0 ? cfg.toFixed(2) : null,
              hassansProfit: cfg > 0 ? hassansProfit.toFixed(2) : null,
              hassansPercentage: cfg > 0 ? hassansPercentage.toFixed(1) : null,
              debitAmount: "0",
              creditAmount: item.totalSales,
              accountName: item.stockItemName || "Unknown Item",
              isStockItem: true,
            };
          });
          return res.json([...entries, ...itemRows]);
        }
      }

      // Stock Transfer
      if (type === "Stock Transfer" || type === "StockTransfer" || type === "Transfer") {
        const tv = await db.query.stockTransferVouchers.findFirst({
          where: eq(stockTransferVouchers.voucherId, voucherId),
        });
        if (tv) {
          const items = await db
            .select({
              id: stockTransferItems.id,
              transferId: stockTransferItems.transferId,
              stockItemId: stockTransferItems.stockItemId,
              quantity: stockTransferItems.quantity,
              rate: stockTransferItems.rate,
              totalAmount: stockTransferItems.totalAmount,
              stockItemName: stockItems.name,
              stockItemCode: stockItems.code,
            })
            .from(stockTransferItems)
            .leftJoin(stockItems, eq(stockTransferItems.stockItemId, stockItems.id))
            .where(eq(stockTransferItems.transferId, tv.id));
          if (items.length > 0) {
            return res.json(
              items.map((item) => ({
                id: item.id,
                voucherId: voucherId,
                stockItemId: item.stockItemId,
                stockItemName: item.stockItemName || "Unknown Item",
                stockItemCode: item.stockItemCode || "-",
                quantity: item.quantity,
                rate: item.rate,
                totalAmount: item.totalAmount,
                debitAmount: "0",
                creditAmount: item.totalAmount,
                accountName: item.stockItemName || "Unknown Item",
                isStockItem: true,
              }))
            );
          }
        }
      }

      // Production / Consumption / Mixed
      if (type === "Production" || type === "Consumption" || type === "Mixed") {
        const av = await db.query.stockAdjustmentVouchers.findFirst({
          where: eq(stockAdjustmentVouchers.voucherId, voucherId),
        });
        if (av) {
          const items = await db
            .select({
              id: stockAdjustmentItems.id,
              adjustmentId: stockAdjustmentItems.adjustmentId,
              stockItemId: stockAdjustmentItems.stockItemId,
              quantity: stockAdjustmentItems.quantity,
              rate: stockAdjustmentItems.rate,
              totalAmount: stockAdjustmentItems.totalAmount,
              stockItemName: stockItems.name,
              stockItemCode: stockItems.code,
            })
            .from(stockAdjustmentItems)
            .leftJoin(stockItems, eq(stockAdjustmentItems.stockItemId, stockItems.id))
            .where(eq(stockAdjustmentItems.adjustmentId, av.id));
          if (items.length > 0) {
            return res.json(
              items.map((item) => {
                const qty = parseFloat(item.quantity || "0");
                const isProduction = type === "Production" || (type === "Mixed" && qty > 0);
                const label = type === "Mixed" ? (qty > 0 ? "Production" : "Consumption") : type;
                return {
                  id: item.id,
                  voucherId,
                  stockItemId: item.stockItemId,
                  stockItemName: item.stockItemName || "Unknown Item",
                  stockItemCode: item.stockItemCode || "-",
                  quantity: item.quantity,
                  rate: item.rate,
                  totalAmount: item.totalAmount,
                  debitAmount: isProduction ? item.totalAmount : "0",
                  creditAmount: isProduction ? "0" : item.totalAmount,
                  accountName: item.stockItemName || "Unknown Item",
                  isStockItem: true,
                  adjustmentType: label,
                };
              })
            );
          }
        }
      }

      // Purchase: return base entries + PO line items + enriched PO header
      if (type === "Purchase") {
        const [po] = await db
          .select({
            id: purchaseOrders.id,
            poNumber: purchaseOrders.poNumber,
            supplierId: purchaseOrders.supplierId,
            containerId: purchaseOrders.containerId,
            currency: purchaseOrders.currency,
            itemsTotal: purchaseOrders.itemsTotal,
            freight: purchaseOrders.freight,
            fumigation: purchaseOrders.fumigation,
            surcharge: purchaseOrders.surcharge,
            documentCharges: purchaseOrders.documentCharges,
            otherCharges: purchaseOrders.otherCharges,
            discount: purchaseOrders.discount,
            status: purchaseOrders.status,
          })
          .from(purchaseOrders)
          .where(eq(purchaseOrders.voucherId, voucherId));
        if (po) {
          const [supplier] = await db
            .select({ legalName: suppliers.legalName })
            .from(suppliers)
            .where(eq(suppliers.id, po.supplierId));
          const [container] = await db
            .select({ containerNumber: containers.containerNumber })
            .from(containers)
            .where(eq(containers.id, po.containerId));

          const lines = await db
            .select({
              id: poLineItems.id,
              poId: poLineItems.poId,
              stockItemId: poLineItems.stockItemId,
              itemName: poLineItems.itemName,
              quantity: poLineItems.quantity,
              rate: poLineItems.rate,
              lineTotal: poLineItems.lineTotal,
              stockItemName: stockItems.name,
              stockItemCode: stockItems.code,
            })
            .from(poLineItems)
            .leftJoin(stockItems, eq(poLineItems.stockItemId, stockItems.id))
            .where(eq(poLineItems.poId, po.id));

          const lineRows = lines.map((l) => ({
            id: l.id,
            voucherId,
            isPurchaseItem: true,
            stockItemId: l.stockItemId,
            stockItemName: l.stockItemName || l.itemName,
            accountName: l.stockItemName || l.itemName,
            quantity: l.quantity,
            rate: l.rate,
            totalAmount: l.lineTotal,
            debitAmount: l.lineTotal,
            creditAmount: "0",
            isStockItem: true,
          }));

          const purchaseOrderEnriched = {
            id: po.id,
            poNumber: po.poNumber,
            supplierId: po.supplierId,
            supplierName: supplier?.legalName || "Unknown Supplier",
            containerId: po.containerId,
            containerNumber: container?.containerNumber || "",
            currency: po.currency,
            itemsTotal: po.itemsTotal,
            freight: po.freight,
            fumigation: po.fumigation,
            surcharge: po.surcharge,
            documentCharges: po.documentCharges,
            otherCharges: po.otherCharges,
            discount: po.discount,
            status: po.status,
          };

          // Combine: ledger entries + line items as a single array (mirrors /api/vouchers/:id/view-entries)
          return res.json({
            entries: [...entries, ...lineRows],
            purchaseOrder: purchaseOrderEnriched,
            items: lineRows,
          });
        }
      }

      // Default: return base entries
      return res.json(entries);
    } catch (err) {
      logger.error("[GlobalTransactions/view-entries]", { error: err });
      return sendCompanyAccessError(res, err);
    }
  });
}
