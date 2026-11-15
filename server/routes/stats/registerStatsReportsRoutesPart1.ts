// Extracted from ./statsReportsRoutes.ts to keep that module under the source-size cap.
import type { Express } from "express";
import { getErrorMessage } from "../../lib/httpHandlers";
import {
  addInventoryValues,
  divideInventoryValues,
  multiplyInventoryValues,
  toInventoryDecimal,
} from "../../lib/inventoryMath";
import { db } from "../../db";
import { storage } from "../../storage";
import { requireAuth, requireNonPOS } from "../../auth";
import {
  companies,
  containerOffloads,
  containers,
  inventory,
  locations,
  salesItems,
  stockItems,
  suppliers,
  vouchers,
} from "@shared/schema";
import { and, desc, eq, inArray, isNull, like, or, sql } from "drizzle-orm";
import { sumMoney, toMoney } from "../../lib/money";
import { countedStockRowValue } from "../../services/inventory/stockValuation";

const numberValue = (value: unknown) =>
  toInventoryDecimal(value as unknown as Parameters<typeof toInventoryDecimal>[0]).toNumber();

const percentage = (numerator: unknown, denominator: unknown) => {
  const divisor = toInventoryDecimal(denominator as unknown as Parameters<typeof toInventoryDecimal>[0]);
  return divisor.isZero()
    ? 0
    : multiplyInventoryValues(
        divideInventoryValues(numerator as unknown as Parameters<typeof divideInventoryValues>[0], divisor),
        100
      ).toNumber();
};

export function registerStatsReportsRoutesPart1(app: Express) {
  app.get("/api/reports/sales", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const { startDate, endDate, locationId, stockGroupId } = req.query;
      const conditions = [eq(vouchers.companyId, companyId)];
      if (startDate) conditions.push(sql`${vouchers.voucherDate} >= ${startDate}`);
      if (endDate) conditions.push(sql`${vouchers.voucherDate} <= ${endDate}`);
      if (locationId) conditions.push(eq(vouchers.locationId, parseInt(locationId as string)));

      let salesData = await db
        .select({
          id: salesItems.id,
          voucherNumber: vouchers.voucherNumber,
          voucherDate: vouchers.voucherDate,
          locationName: locations.name,
          stockItemCode: stockItems.code,
          stockItemName: stockItems.name,
          stockGroupId: stockItems.stockGroupId,
          quantity: salesItems.quantity,
          sellingPrice: salesItems.sellingPrice,
          costPrice: salesItems.costPrice,
          totalSales: salesItems.totalSales,
          totalCost: salesItems.totalCost,
          profit: sql<string>`COALESCE(${salesItems.totalSales}::numeric, 0) - COALESCE(${salesItems.totalCost}::numeric, 0)`,
        })
        .from(salesItems)
        .innerJoin(vouchers, eq(salesItems.voucherId, vouchers.id))
        .innerJoin(stockItems, eq(salesItems.stockItemId, stockItems.id))
        .leftJoin(locations, eq(vouchers.locationId, locations.id))
        .where(and(...conditions))
        .orderBy(vouchers.voucherDate)
        .execute();
      if (stockGroupId) salesData = salesData.filter((item) => item.stockGroupId === parseInt(stockGroupId as string));

      const totalQuantity = addInventoryValues(...salesData.map((item) => item.quantity));
      const totalSales = addInventoryValues(...salesData.map((item) => item.totalSales));
      const totalCost = addInventoryValues(...salesData.map((item) => item.totalCost));
      const totalProfit = addInventoryValues(...salesData.map((item) => item.profit));
      res.json({
        items: salesData,
        summary: {
          totalQuantity: totalQuantity.toNumber(),
          totalSales: totalSales.toNumber(),
          totalCost: totalCost.toNumber(),
          totalProfit: totalProfit.toNumber(),
          grossProfitMargin: percentage(totalProfit, totalSales),
        },
        filters: {
          startDate: startDate || null,
          endDate: endDate || null,
          locationId: locationId || null,
          stockGroupId: stockGroupId || null,
        },
      });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.get("/api/reports/stock-movement", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const { startDate, endDate, locationId, stockGroupId } = req.query;
      const allStockItems = await storage.getAllStockItems(companyId);
      const stockItemsToReport = stockGroupId
        ? allStockItems.filter((item) => item.stockGroupId === parseInt(stockGroupId as string))
        : allStockItems;
      // Wave 11: the stock valuation policy (stockValuation.ts): non-deleted
      // locations, each row valued at its stored total_value.
      const inventoryConditions = [eq(locations.companyId, companyId), isNull(locations.deletedAt)];
      if (locationId) inventoryConditions.push(eq(inventory.locationId, parseInt(locationId as string)));
      const inventoryRecords = await db
        .select({
          stockItemId: inventory.stockItemId,
          locationId: inventory.locationId,
          locationName: locations.name,
          quantity: inventory.quantity,
          averageRate: inventory.averageRate,
          totalValue: inventory.totalValue,
        })
        .from(inventory)
        .innerJoin(locations, eq(inventory.locationId, locations.id))
        .where(and(...inventoryConditions))
        .execute();

      const inventoryByItem = new Map<number, typeof inventoryRecords>();
      for (const record of inventoryRecords) {
        const records = inventoryByItem.get(record.stockItemId) || [];
        records.push(record);
        inventoryByItem.set(record.stockItemId, records);
      }

      const movementData = stockItemsToReport
        .map((item) => {
          const itemInventory = inventoryByItem.get(item.id) || [];
          const totalQuantity = addInventoryValues(...itemInventory.map((record) => record.quantity));
          const totalValue = addInventoryValues(
            ...itemInventory.map((record) => countedStockRowValue(record.quantity, record.totalValue))
          );
          return {
            stockItemId: item.id,
            stockItemCode: item.code,
            stockItemName: item.name,
            locations: itemInventory.map((record) => ({
              locationId: record.locationId,
              locationName: record.locationName,
              quantity: numberValue(record.quantity),
              averageRate: numberValue(record.averageRate),
              totalValue: countedStockRowValue(record.quantity, record.totalValue).toNumber(),
            })),
            totalQuantity: totalQuantity.toNumber(),
            totalValue: totalValue.toNumber(),
          };
        })
        .filter((item) => item.totalQuantity > 0);
      const grandTotalQuantity = addInventoryValues(...movementData.map((item) => item.totalQuantity));
      const grandTotalValue = addInventoryValues(...movementData.map((item) => item.totalValue));
      res.json({
        items: movementData,
        summary: {
          totalItems: movementData.length,
          grandTotalQuantity: grandTotalQuantity.toNumber(),
          grandTotalValue: grandTotalValue.toNumber(),
        },
        filters: {
          startDate: startDate || null,
          endDate: endDate || null,
          locationId: locationId || null,
          stockGroupId: stockGroupId || null,
        },
      });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.get("/api/reports/containers", requireAuth, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const { status, supplierId, startDate, endDate, allCompanies, specificCompanyId } = req.query;
      let companyCondition;
      if (allCompanies === "true") {
        const isDeveloper = req.user?.role === "Developer";
        const companyIds = isDeveloper
          ? (await storage.getAllCompanies()).map((company) => company.id)
          : (await storage.getUserCompaniesWithRoles(req.user!.id)).map((membership) => membership.companyId);
        companyCondition =
          companyIds.length > 0 ? inArray(containers.companyId, companyIds) : eq(containers.companyId, companyId);
      } else if (specificCompanyId) {
        const requestedCompanyId = Number(specificCompanyId);
        if (!Number.isInteger(requestedCompanyId) || requestedCompanyId <= 0) {
          return res.status(400).json({ message: "Invalid company selected" });
        }
        if (req.user?.role !== "Developer" && requestedCompanyId !== companyId) {
          const memberships = await storage.getUserCompaniesWithRoles(req.user!.id);
          if (!memberships.some((membership) => membership.companyId === requestedCompanyId)) {
            return res.status(403).json({ message: "No access to the requested company" });
          }
        }
        companyCondition = eq(containers.companyId, requestedCompanyId);
      } else {
        companyCondition = eq(containers.companyId, companyId);
      }
      const conditions = [companyCondition];
      const isOffloaded = (status as string | undefined)?.toLowerCase() === "offloaded";
      if (status) conditions.push(eq(containers.status, isOffloaded ? "OFFLOADED" : (status as string)));
      if (supplierId) conditions.push(eq(containers.supplierId, parseInt(supplierId as string)));
      if (isOffloaded) {
        if (startDate) conditions.push(sql`${containers.offloadDate} >= ${startDate}`);
        if (endDate) conditions.push(sql`${containers.offloadDate} <= ${endDate}`);
      } else {
        if (startDate) conditions.push(sql`${containers.importDate} >= ${startDate}`);
        if (endDate) conditions.push(sql`${containers.importDate} <= ${endDate}`);
      }
      const containerData = await db
        .select({
          id: containers.id,
          containerNumber: containers.containerNumber,
          supplierId: containers.supplierId,
          supplierName: suppliers.legalName,
          status: containers.status,
          importDate: containers.importDate,
          offloadDate: containers.offloadDate,
          itemsTotal: containers.itemsTotal,
          chargesTotal: containers.chargesTotal,
          grandTotal: containers.grandTotal,
          companyId: containers.companyId,
          companyName: companies.name,
        })
        .from(containers)
        .innerJoin(suppliers, eq(containers.supplierId, suppliers.id))
        .innerJoin(companies, eq(containers.companyId, companies.id))
        .where(and(...conditions))
        .orderBy(
          isOffloaded ? sql`${containers.offloadDate} DESC NULLS LAST` : sql`${containers.importDate} DESC NULLS LAST`
        );
      // Load the most recent offload for each visible container in one batch.
      // Offload total_charges already includes purchase-order charges; the
      // report must add ONLY the offloading portion on top of grandTotal.
      const offloadedIds = containerData
        .filter((container) => container.status === "OFFLOADED")
        .map((container) => container.id);
      const offloadRows = offloadedIds.length
        ? await db
            .select({
              containerId: containerOffloads.containerId,
              duties: containerOffloads.duties,
              officeCharges: containerOffloads.officeCharges,
              transportFees: containerOffloads.transportFees,
              transferCharges: containerOffloads.transferCharges,
              totalCharges: containerOffloads.totalCharges,
            })
            .from(containerOffloads)
            .where(inArray(containerOffloads.containerId, offloadedIds))
            .orderBy(desc(containerOffloads.id))
        : [];
      const offloadsByContainer = new Map<number, (typeof offloadRows)[number]>();
      for (const row of offloadRows) {
        if (!offloadsByContainer.has(row.containerId)) offloadsByContainer.set(row.containerId, row);
      }

      // Active charge vouchers are the same live source used on Offload Detail.
      // A later voucher edit, or a soft-deleted voucher, must be reflected in
      // this read-only report without changing inventory or accounting records.
      // If a particular category has no active voucher, use its persisted
      // offload amount (legacy/offloads with no voucher).
      type ChargePrefix = "DUTY" | "OFFICE" | "TRANS" | "XFER" | "CHG";
      const voucherPrefixes: ChargePrefix[] = ["DUTY", "OFFICE", "TRANS", "XFER", "CHG"];
      const containerLookup = new Map(
        containerData.map((container) => [`${container.companyId}:${container.containerNumber}`, container.id])
      );
      const companyIds = [...new Set(containerData.filter((c) => c.status === "OFFLOADED").map((c) => c.companyId))];
      const activeChargeVouchers = companyIds.length
        ? await db
            .select({
              companyId: vouchers.companyId,
              voucherNumber: vouchers.voucherNumber,
              totalAmount: vouchers.totalAmount,
            })
            .from(vouchers)
            .where(
              and(
                inArray(vouchers.companyId, companyIds),
                isNull(vouchers.deletedAt),
                or(...voucherPrefixes.map((prefix) => like(vouchers.voucherNumber, `${prefix}-%`)))
              )
            )
        : [];
      const voucherAmountsByContainer = new Map<number, Partial<Record<ChargePrefix, string>>>();
      for (const voucher of activeChargeVouchers) {
        const prefix = voucherPrefixes.find((item) => voucher.voucherNumber.startsWith(`${item}-`));
        if (!prefix) continue;
        const suffix = voucher.voucherNumber.slice(prefix.length + 1);
        // CHG-<container>-<id>-<index>, other types -<id>;
        // older rows may have a timestamp suffix instead. Match full container
        // identities, never an ambiguous substring of a container number.
        const candidates =
          prefix === "CHG"
            ? [suffix.replace(/-\\d+-\\d+$/, ""), suffix.replace(/-\\d+$/, "")]
            : [suffix.replace(/-\\d+$/, "")];
        const containerId = candidates
          .filter((candidate) => candidate !== suffix)
          .map((candidate) => containerLookup.get(`${voucher.companyId}:${candidate}`))
          .find((id): id is number => id !== undefined);
        if (containerId === undefined || !offloadsByContainer.has(containerId)) continue;
        const byType = voucherAmountsByContainer.get(containerId) ?? {};
        byType[prefix] = sumMoney([byType[prefix], voucher.totalAmount]).toFixed(2);
        voucherAmountsByContainer.set(containerId, byType);
      }

      const reportContainers = containerData.map((container) => {
        const offload = offloadsByContainer.get(container.id);
        const active = voucherAmountsByContainer.get(container.id);
        const zero = "0.00";
        const persistedExtras = offload
          ? toMoney(offload.totalCharges)
              .minus(toMoney(container.chargesTotal))
              .minus(sumMoney([offload.duties, offload.officeCharges, offload.transportFees, offload.transferCharges]))
              .toFixed(2)
          : zero;
        const chargeBreakdown = {
          duties: active?.DUTY ?? offload?.duties ?? zero,
          officeCharges: active?.OFFICE ?? offload?.officeCharges ?? zero,
          transportFees: active?.TRANS ?? offload?.transportFees ?? zero,
          transferCharges: active?.XFER ?? offload?.transferCharges ?? zero,
          additionalCharges: active?.CHG ?? persistedExtras,
        };
        const offloadingCharges = sumMoney(Object.values(chargeBreakdown)).toFixed(2);
        return {
          ...container,
          offloadingCharges,
          chargeBreakdown,
          totalContainerCost: sumMoney([container.grandTotal, offloadingCharges]).toFixed(2),
        };
      });
      res.json({
        containers: reportContainers,
        summary: {
          totalContainers: reportContainers.length,
          totalItemsTotal: addInventoryValues(...reportContainers.map((container) => container.itemsTotal)).toNumber(),
          totalChargesTotal: addInventoryValues(
            ...reportContainers.map((container) => container.chargesTotal)
          ).toNumber(),
          totalGrandTotal: addInventoryValues(...reportContainers.map((container) => container.grandTotal)).toNumber(),
          totalOffloadingCharges: addInventoryValues(
            ...reportContainers.map((container) => container.offloadingCharges)
          ).toNumber(),
          totalContainerCost: addInventoryValues(
            ...reportContainers.map((container) => container.totalContainerCost)
          ).toNumber(),
        },
        filters: {
          status: status || null,
          supplierId: supplierId || null,
          startDate: startDate || null,
          endDate: endDate || null,
        },
      });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
