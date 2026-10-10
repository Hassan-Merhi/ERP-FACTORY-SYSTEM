import type { Express } from "express";
import { pool } from "../../db";
import { requireAuth } from "../../auth";
import { storage } from "../../storage";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logAudit } from "../_helpers";

export function registerLocationDeleteRoutes(app: Express) {
  app.delete("/api/locations/:locationId", requireAuth, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const locationId = Number.parseInt(req.params.locationId, 10);
      if (!Number.isInteger(locationId) || locationId <= 0) {
        return res.status(400).json({ message: "Invalid location ID" });
      }

      const location = await storage.getLocationById(locationId);
      if (!location || location.deletedAt) {
        return res.status(404).json({ message: "Location not found" });
      }
      if (location.companyId !== companyId) {
        return res.status(403).json({ message: "Access denied" });
      }

      const [inventoryResult, factoryBalesResult] = await Promise.all([
        pool.query(
          `SELECT COUNT(*)::int AS count
             FROM inventory
            WHERE location_id = $1
              AND company_id = $2
              AND (ABS(COALESCE(NULLIF(quantity::text, '')::numeric, 0)) > 0
                   OR ABS(COALESCE(total_value, 0)) > 0)`,
          [locationId, companyId]
        ),
        pool.query(
          `SELECT COUNT(*)::int AS count
             FROM factory_bales
            WHERE erp_location_id = $1
              AND company_id = $2
              AND status = 'IN_STOCK'`,
          [locationId, companyId]
        ),
      ]);

      const inventoryRows = Number(inventoryResult.rows[0]?.count ?? 0);
      const inStockBales = Number(factoryBalesResult.rows[0]?.count ?? 0);
      if (inventoryRows > 0 || inStockBales > 0) {
        return res.status(409).json({
          message: "This location still has stock. Move or remove all stock before deleting the location.",
          inventoryRows,
          inStockBales,
        });
      }

      const result = await pool.query(
        `UPDATE locations
            SET active = FALSE,
                deleted_at = NOW()
          WHERE id = $1
            AND company_id = $2
            AND deleted_at IS NULL
            -- Wave 11: re-checked in the same statement, so stock that arrives
            -- between the check above and this update still blocks the delete.
            AND NOT EXISTS (
              SELECT 1 FROM inventory
               WHERE location_id = $1
                 AND (ABS(COALESCE(quantity, 0)) > 0 OR ABS(COALESCE(total_value, 0)) > 0)
            )
        RETURNING id, name, code, active, deleted_at`,
        [locationId, companyId]
      );

      if (result.rowCount === 0) {
        return res.status(404).json({ message: "Location not found" });
      }

      try {
        await logAudit({
          userId: req.session.userId!,
          username: req.session.username || "unknown",
          companyId,
          action: "delete",
          tableName: "locations",
          recordId: locationId,
          recordIdentifier: location.name,
          changes: {
            active: { old: location.active, new: false },
            deletedAt: { old: location.deletedAt ?? null, new: result.rows[0].deleted_at },
          },
        });
      } catch {
        // Audit failures must not leave a successfully archived location visible.
      }

      res.json({
        success: true,
        id: locationId,
        name: location.name,
        message: "Location deleted",
      });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
