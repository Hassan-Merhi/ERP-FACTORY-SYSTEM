/**
 * inventoryMovementRoutes: InventoryMovementReport endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express } from "express";
import { rateLimit } from "express-rate-limit";
import { getErrorMessage } from "../../lib/httpHandlers";
import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "../../db";
import { requireAuth } from "../../auth";
import { calculateHistoricalLocationInventory } from "../helpers/inventoryHistoryHelpers";
import { inventory, locations } from "@shared/schema";

import { MONTH_NAMES_INV, dayBefore, fetchStockMovements, type StockMovementTx } from "./_helpers";

const inventoryMovementLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
});

type InventoryBalance = {
  quantity: number;
  totalValue: number;
};

function movementDelta(movements: StockMovementTx[]): InventoryBalance {
  return movements.reduce(
    (total, movement) => ({
      quantity: total.quantity + movement.inwardQty - movement.outwardQty,
      totalValue: total.totalValue + movement.inwardValue - movement.outwardValue,
    }),
    { quantity: 0, totalValue: 0 }
  );
}

/**
 * All Locations must use the live inventory ledger as the authoritative close.
 * Summing stored value (rather than quantity * a rounded rate) preserves the exact
 * asset value, and dividing the summed value by summed quantity gives the true
 * weighted average rate across locations.
 */
async function getLiveCompanyInventoryBalance(companyId: number, stockItemId: number): Promise<InventoryBalance> {
  const [row] = await db
    .select({
      quantity: sql<string>`COALESCE(SUM(CAST(${inventory.quantity} AS numeric)), 0)`,
      totalValue: sql<string>`COALESCE(SUM(CAST(${inventory.totalValue} AS numeric)), 0)`,
    })
    .from(inventory)
    .innerJoin(locations, eq(inventory.locationId, locations.id))
    .where(
      and(
        eq(inventory.companyId, companyId),
        eq(inventory.stockItemId, stockItemId),
        isNull(locations.deletedAt)
      )
    );

  return {
    quantity: Number.parseFloat(row?.quantity ?? "0") || 0,
    totalValue: Number.parseFloat(row?.totalValue ?? "0") || 0,
  };
}

/**
 * Reconstruct an All Locations balance at a historical date by starting from the
 * authoritative current inventory total and reversing movements after the cutoff.
 * Internal location transfers are intentionally absent from fetchStockMovements
 * when locationId is null because they do not change company-wide stock.
 */
async function getCompanyInventoryBalanceAsOf(
  companyId: number,
  stockItemId: number,
  asOfDate: string,
  today: string
): Promise<InventoryBalance> {
  const current = await getLiveCompanyInventoryBalance(companyId, stockItemId);
  if (asOfDate >= today) return current;

  const movementsFromCutoff = await fetchStockMovements(companyId, stockItemId, null, asOfDate, null);
  const afterCutoff = movementsFromCutoff.filter((movement) => movement.date > asOfDate);
  const delta = movementDelta(afterCutoff);

  return {
    quantity: current.quantity - delta.quantity,
    totalValue: current.totalValue - delta.totalValue,
  };
}

export function registerInventoryMovementReportRoutes(app: Express) {
  // GET /api/inventory/movement — monthly summary
  app.get("/api/inventory/movement", requireAuth, inventoryMovementLimiter, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const {
        stockItemId: stockItemIdRaw,
        locationId: locationIdRaw,
        startDate: startDateRaw,
        endDate: endDateRaw,
      } = req.query;
      if (typeof stockItemIdRaw !== "string") {
        return res.status(400).json({ message: "stockItemId must be a single positive integer" });
      }
      if (locationIdRaw !== undefined && typeof locationIdRaw !== "string") {
        return res.status(400).json({ message: "locationId must be a single positive integer" });
      }
      if (startDateRaw !== undefined && typeof startDateRaw !== "string") {
        return res.status(400).json({ message: "startDate must be a single YYYY-MM-DD value" });
      }
      if (endDateRaw !== undefined && typeof endDateRaw !== "string") {
        return res.status(400).json({ message: "endDate must be a single YYYY-MM-DD value" });
      }

      const stockItemId = Number.parseInt(stockItemIdRaw, 10);
      if (!Number.isSafeInteger(stockItemId) || stockItemId <= 0) {
        return res.status(400).json({ message: "stockItemId must be a single positive integer" });
      }

      let locationId: number | null = null;
      if (locationIdRaw) {
        const parsedLocationId = Number.parseInt(locationIdRaw, 10);
        if (!Number.isSafeInteger(parsedLocationId) || parsedLocationId <= 0) {
          return res.status(400).json({ message: "locationId must be a single positive integer" });
        }
        locationId = parsedLocationId;
      }

      // When no dates supplied (All Time preset), span from a safe epoch to today.
      const today = new Date().toISOString().slice(0, 10);
      const sd = startDateRaw || "2000-01-01";
      const ed = endDateRaw || today;
      const datePattern = /^\d{4}-\d{2}-\d{2}$/;
      if (!datePattern.test(sd) || !datePattern.test(ed) || sd > ed) {
        return res.status(400).json({ message: "Invalid inventory movement date range" });
      }

      const periodMovements = await fetchStockMovements(companyId, stockItemId, locationId, sd, ed);
      periodMovements.sort((a, b) => a.date.localeCompare(b.date));

      // Build list of months in the range. The date format is already validated above,
      // so split the scalar strings instead of using String/Array-ambiguous slice calls.
      const [startYearPart, startMonthPart] = sd.split("-");
      const [endYearPart, endMonthPart] = ed.split("-");
      const startY = Number.parseInt(startYearPart, 10),
        startM = Number.parseInt(startMonthPart, 10);
      const endY = Number.parseInt(endYearPart, 10),
        endM = Number.parseInt(endMonthPart, 10);
      const months: { year: number; month: number; monthName: string }[] = [];
      let y = startY,
        m = startM;
      while (y < endY || (y === endY && m <= endM)) {
        months.push({ year: y, month: m, monthName: MONTH_NAMES_INV[m - 1] });
        m++;
        if (m > 12) {
          m = 1;
          y++;
        }
      }

      let monthlySummary;
      let closingQtyForPeriod = 0;
      let closingValueForPeriod = 0;

      if (locationId === null) {
        // All Locations: inventory rows are the source of truth for the ending
        // quantity/value. Reconstruct older month closes backward from that anchor.
        // This prevents sales/movement history from inventing a negative inventory
        // value while the real inventory table still has positive stock and value.
        const endBalance = await getCompanyInventoryBalanceAsOf(companyId, stockItemId, ed, today);
        closingQtyForPeriod = endBalance.quantity;
        closingValueForPeriod = endBalance.totalValue;

        let runQty = endBalance.quantity;
        let runValue = endBalance.totalValue;
        const rows = [];

        for (let index = months.length - 1; index >= 0; index--) {
          const { year, month, monthName } = months[index];
          const mStart = `${year}-${String(month).padStart(2, "0")}-01`;
          const lastDay = new Date(year, month, 0).getDate();
          const mEnd = `${year}-${String(month).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
          const mTx = periodMovements.filter((t) => t.date >= mStart && t.date <= mEnd);
          const inQty = mTx.reduce((s, t) => s + t.inwardQty, 0);
          const inVal = mTx.reduce((s, t) => s + t.inwardValue, 0);
          const outQty = mTx.reduce((s, t) => s + t.outwardQty, 0);
          const outVal = mTx.reduce((s, t) => s + t.outwardValue, 0);
          const cQty = runQty;
          const cVal = runValue;
          const oQty = cQty - inQty + outQty;
          const oVal = cVal - inVal + outVal;

          rows.push({
            year,
            month,
            monthName,
            openingQty: oQty,
            openingRate: oQty !== 0 ? oVal / oQty : 0,
            openingValue: oVal,
            inwardQty: inQty,
            inwardRate: inQty > 0 ? inVal / inQty : 0,
            inwardValue: inVal,
            outwardQty: outQty,
            outwardRate: outQty > 0 ? outVal / outQty : 0,
            outwardValue: outVal,
            closingQty: cQty,
            closingRate: cQty !== 0 ? cVal / cQty : 0,
            closingValue: cVal,
          });

          runQty = oQty;
          runValue = oVal;
        }

        monthlySummary = rows.reverse();
      } else {
        // A specific location already has a location-aware historical inventory
        // reconstruction. Keep that behavior and roll the selected period forward.
        const historical = await calculateHistoricalLocationInventory(locationId, companyId, dayBefore(sd));
        const row = historical.find((historicalRow) => historicalRow.stockItemId === stockItemId);
        let runQty = row ? Number.parseFloat(row.quantity) || 0 : 0;
        let runValue = row ? Number.parseFloat(row.totalValue) || 0 : 0;

        monthlySummary = months.map(({ year, month, monthName }) => {
          const mStart = `${year}-${String(month).padStart(2, "0")}-01`;
          const lastDay = new Date(year, month, 0).getDate();
          const mEnd = `${year}-${String(month).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
          const mTx = periodMovements.filter((t) => t.date >= mStart && t.date <= mEnd);
          const inQty = mTx.reduce((s, t) => s + t.inwardQty, 0);
          const inVal = mTx.reduce((s, t) => s + t.inwardValue, 0);
          const outQty = mTx.reduce((s, t) => s + t.outwardQty, 0);
          const outVal = mTx.reduce((s, t) => s + t.outwardValue, 0);
          const oQty = runQty;
          const oVal = runValue;
          const cQty = oQty + inQty - outQty;
          const cVal = oVal + inVal - outVal;
          runQty = cQty;
          runValue = cVal;

          return {
            year,
            month,
            monthName,
            openingQty: oQty,
            openingRate: oQty !== 0 ? oVal / oQty : 0,
            openingValue: oVal,
            inwardQty: inQty,
            inwardRate: inQty > 0 ? inVal / inQty : 0,
            inwardValue: inVal,
            outwardQty: outQty,
            outwardRate: outQty > 0 ? outVal / outQty : 0,
            outwardValue: outVal,
            closingQty: cQty,
            closingRate: cQty !== 0 ? cVal / cQty : 0,
            closingValue: cVal,
          };
        });

        closingQtyForPeriod = runQty;
        closingValueForPeriod = runValue;
      }

      const gt = {
        inwardQty: monthlySummary.reduce((s, month) => s + month.inwardQty, 0),
        inwardValue: monthlySummary.reduce((s, month) => s + month.inwardValue, 0),
        outwardQty: monthlySummary.reduce((s, month) => s + month.outwardQty, 0),
        outwardValue: monthlySummary.reduce((s, month) => s + month.outwardValue, 0),
        closingQty: closingQtyForPeriod,
        closingValue: closingValueForPeriod,
      };

      res.json({ months: monthlySummary, grandTotal: gt });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // GET /api/inventory/movement/drill — transaction-level drill for one month
  app.get("/api/inventory/movement/drill", requireAuth, inventoryMovementLimiter, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const { stockItemId: stockItemIdRaw, locationId: locationIdRaw, year: yearRaw, month: monthRaw } = req.query;
      if (typeof stockItemIdRaw !== "string" || typeof yearRaw !== "string" || typeof monthRaw !== "string") {
        return res.status(400).json({ message: "stockItemId, year, month must be single integer values" });
      }
      if (locationIdRaw !== undefined && typeof locationIdRaw !== "string") {
        return res.status(400).json({ message: "locationId must be a single positive integer" });
      }

      const stockItemId = Number.parseInt(stockItemIdRaw, 10);
      const year = Number.parseInt(yearRaw, 10);
      const month = Number.parseInt(monthRaw, 10);
      if (!Number.isSafeInteger(stockItemId) || stockItemId <= 0) {
        return res.status(400).json({ message: "stockItemId must be a single positive integer" });
      }
      if (!Number.isSafeInteger(year) || year < 2000 || year > 9999) {
        return res.status(400).json({ message: "year must be a valid four-digit year" });
      }
      if (!Number.isSafeInteger(month) || month < 1 || month > 12) {
        return res.status(400).json({ message: "month must be between 1 and 12" });
      }

      let locationId: number | null = null;
      if (locationIdRaw) {
        const parsedLocationId = Number.parseInt(locationIdRaw, 10);
        if (!Number.isSafeInteger(parsedLocationId) || parsedLocationId <= 0) {
          return res.status(400).json({ message: "locationId must be a single positive integer" });
        }
        locationId = parsedLocationId;
      }

      const mStart = `${year}-${String(month).padStart(2, "0")}-01`;
      const lastDay = new Date(year, month, 0).getDate();
      const mEnd = `${year}-${String(month).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
      const today = new Date().toISOString().slice(0, 10);

      let runQty = 0;
      let runValue = 0;
      if (locationId !== null) {
        const historical = await calculateHistoricalLocationInventory(locationId, companyId, dayBefore(mStart));
        const row = historical.find((historicalRow) => historicalRow.stockItemId === stockItemId);
        runQty = row ? Number.parseFloat(row.quantity) || 0 : 0;
        runValue = row ? Number.parseFloat(row.totalValue) || 0 : 0;
      } else {
        const openingBalance = await getCompanyInventoryBalanceAsOf(companyId, stockItemId, dayBefore(mStart), today);
        runQty = openingBalance.quantity;
        runValue = openingBalance.totalValue;
      }

      const monthMovements = await fetchStockMovements(companyId, stockItemId, locationId, mStart, mEnd);
      monthMovements.sort((a, b) => a.date.localeCompare(b.date) || a.vchType.localeCompare(b.vchType));

      const transactions = [];
      if (runQty !== 0 || runValue !== 0) {
        transactions.push({
          date: mStart,
          particulars: "Opening Balance",
          vchType: "",
          voucherId: null,
          poId: null,
          inwardQty: 0,
          inwardRate: 0,
          inwardValue: 0,
          outwardQty: 0,
          outwardRate: 0,
          outwardValue: 0,
          closingQty: runQty,
          closingRate: runQty !== 0 ? runValue / runQty : 0,
          closingValue: runValue,
          isOpeningBalance: true,
          isPOS: false,
          posSellingRate: 0,
          posSellingValue: 0,
        });
      }

      let totInQty = 0,
        totInVal = 0,
        totOutQty = 0,
        totOutVal = 0;
      for (const movement of monthMovements) {
        runQty += movement.inwardQty - movement.outwardQty;
        runValue += movement.inwardValue - movement.outwardValue;
        totInQty += movement.inwardQty;
        totInVal += movement.inwardValue;
        totOutQty += movement.outwardQty;
        totOutVal += movement.outwardValue;
        transactions.push({
          ...movement,
          closingQty: runQty,
          closingRate: runQty !== 0 ? runValue / runQty : 0,
          closingValue: runValue,
          isOpeningBalance: false,
        });
      }

      const totals = {
        inwardQty: totInQty,
        inwardRate: totInQty > 0 ? totInVal / totInQty : 0,
        inwardValue: totInVal,
        outwardQty: totOutQty,
        outwardRate: totOutQty > 0 ? totOutVal / totOutQty : 0,
        outwardValue: totOutVal,
      };

      res.json({ transactions, totals });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
