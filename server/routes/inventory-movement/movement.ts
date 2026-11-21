/**
 * inventoryMovementRoutes: InventoryMovementReport endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express } from "express";
import { getErrorMessage } from "../../lib/httpHandlers";
import { requireAuth } from "../../auth";
import { calculateHistoricalLocationInventory } from "../helpers/inventoryHistoryHelpers";
import { plusMoney, toMoney } from "../../lib/money";

import { dayBefore, fetchStockMovements } from "./_helpers";
import {
  registerInventoryMovementReportRoutesPart1,
  inventoryMovementLimiter,
  net,
  getCompanyInventoryBalanceAsOf,
} from "./registerInventoryMovementReportRoutesPart1";

export function registerInventoryMovementReportRoutes(app: Express) {
  registerInventoryMovementReportRoutesPart1(app);

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
        runQty = row ? toMoney(row.quantity).toNumber() : 0;
        runValue = row ? toMoney(row.totalValue).toNumber() : 0;
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
        runQty = net(runQty, movement.inwardQty, movement.outwardQty);
        runValue = net(runValue, movement.inwardValue, movement.outwardValue);
        totInQty = plusMoney(totInQty, movement.inwardQty);
        totInVal = plusMoney(totInVal, movement.inwardValue);
        totOutQty = plusMoney(totOutQty, movement.outwardQty);
        totOutVal = plusMoney(totOutVal, movement.outwardValue);
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
