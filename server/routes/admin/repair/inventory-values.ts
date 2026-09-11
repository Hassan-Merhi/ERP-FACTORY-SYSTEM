/**
 * adminRepairRoutes: AdminInventoryValueRepair endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express } from "express";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { resultRows } from "../../../lib/queryResult";
import { db } from "../../../db";
import { requireAuth, requireRole } from "../../../auth";
import {} from "@shared/schema";
import { sql } from "drizzle-orm";

type CorruptedInventoryRow = {
  id: number;
  location_id: number | null;
  stock_item_id: number | null;
  quantity: string | null;
  average_rate: string | null;
  total_value: string | null;
  location_name?: string | null;
  stock_item_name?: string | null;
};

export function registerAdminInventoryValueRepairRoutes(app: Express) {
  app.get("/api/admin/repair-inventory-values/preview", requireAuth, requireRole("Admin"), async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) {
        return res.status(400).json({ message: "No company selected" });
      }

      const detectResult = await db.execute(
        sql`SELECT i.id, i.location_id, i.stock_item_id, i.quantity, i.average_rate, i.total_value,
                   l.name AS location_name,
                   si.name AS stock_item_name
            FROM inventory i
            LEFT JOIN locations l ON l.id = i.location_id
            LEFT JOIN stock_items si ON si.id = i.stock_item_id
            WHERE i.company_id = ${companyId}
            AND (
              (CAST(i.quantity AS DECIMAL) <= 0 AND CAST(i.total_value AS DECIMAL) > 0.01)
              OR CAST(i.average_rate AS DECIMAL) < 0
              OR (CAST(i.quantity AS DECIMAL) > 0 AND CAST(i.total_value AS DECIMAL) < -0.01)
              OR (CAST(i.quantity AS DECIMAL) <= 0 AND ABS(CAST(i.average_rate AS DECIMAL)) > 0.001)
            )`
      );

      const corruptedRows = resultRows<CorruptedInventoryRow>(detectResult);

      if (!corruptedRows || corruptedRows.length === 0) {
        return res.json({ rows: [] });
      }

      const previewRows = [];
      for (const row of corruptedRows) {
        const qty = parseFloat(row.quantity || "0");
        const oldRate = parseFloat(row.average_rate || "0");
        const oldValue = parseFloat(row.total_value || "0");

        let newValue = oldValue;
        let newRate = oldRate;
        const reasons: string[] = [];

        if (qty <= 0 && oldValue > 0.01) reasons.push("qty <= 0 but value > 0");
        if (oldRate < 0) reasons.push("negative average_rate");
        if (qty > 0 && oldValue < -0.01) reasons.push("qty > 0 but total_value < 0");
        if (qty <= 0 && Math.abs(oldRate) > 0.001) reasons.push("qty <= 0 but rate != 0");

        if (qty <= 0) {
          newValue = 0;
          newRate = 0;
        } else if (qty > 0 && oldValue < 0) {
          newValue = 0;
          newRate = 0;
        } else if (oldRate < 0) {
          newRate = 0;
        }

        previewRows.push({
          id: row.id,
          locationId: row.location_id,
          locationName: row.location_name || "Unknown",
          stockItemId: row.stock_item_id,
          stockItemName: row.stock_item_name || "Unknown",
          quantity: qty,
          oldRate,
          oldValue,
          newRate,
          newValue,
          reason: reasons.join("; "),
        });
      }

      res.json({ rows: previewRows });
    } catch (error: unknown) {
      logger.error("Inventory repair preview error:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.post("/api/admin/repair-inventory-values", requireAuth, requireRole("Admin"), async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) {
        return res.status(400).json({ message: "No company selected" });
      }

      const detectResult = await db.execute(
        sql`SELECT id, location_id, stock_item_id, quantity, average_rate, total_value
            FROM inventory
            WHERE company_id = ${companyId}
            AND (
              (CAST(quantity AS DECIMAL) <= 0 AND CAST(total_value AS DECIMAL) > 0.01)
              OR CAST(average_rate AS DECIMAL) < 0
              OR (CAST(quantity AS DECIMAL) > 0 AND CAST(total_value AS DECIMAL) < -0.01)
              OR (CAST(quantity AS DECIMAL) <= 0 AND ABS(CAST(average_rate AS DECIMAL)) > 0.001)
            )`
      );

      const corruptedRows = resultRows<CorruptedInventoryRow>(detectResult);

      if (!corruptedRows || corruptedRows.length === 0) {
        return res.json({ message: "No corrupted inventory rows found", corrected: 0, rows: [] });
      }

      const correctedRows = [];
      for (const row of corruptedRows) {
        const qty = parseFloat(row.quantity || "0");
        const oldRate = parseFloat(row.average_rate || "0");
        const oldValue = parseFloat(row.total_value || "0");

        let newValue = oldValue;
        let newRate = oldRate;

        if (qty <= 0) {
          newValue = 0;
          newRate = 0;
        } else if (qty > 0 && oldValue < 0) {
          newValue = 0;
          newRate = 0;
        } else if (oldRate < 0) {
          newRate = 0;
        }

        await db.execute(
          sql`UPDATE inventory
              SET total_value = ${newValue.toFixed(2)},
                  average_rate = ${newRate.toFixed(2)},
                  last_updated = NOW()
              WHERE id = ${row.id}`
        );

        correctedRows.push({
          id: row.id,
          locationId: row.location_id,
          stockItemId: row.stock_item_id,
          quantity: qty,
          oldRate,
          oldValue,
          newRate,
          newValue,
        });

        logger.info(
          `[InventoryRepair] Corrected row id=${row.id} loc=${row.location_id} item=${row.stock_item_id}: qty=${qty} rate=${oldRate}->${newRate} value=${oldValue}->${newValue}`
        );
      }

      res.json({
        message: `Repaired ${correctedRows.length} corrupted inventory rows`,
        corrected: correctedRows.length,
        rows: correctedRows,
      });
    } catch (error: unknown) {
      logger.error("Inventory repair error:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // ============================================================
  // NET PROFIT EXCEL EXPORT
  // ============================================================
}
