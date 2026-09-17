/**
 * Add a stock item from Supplier Profit Check.
 *
 * The supplier may belong to the active company or its explicitly linked parent;
 * the optional stock group and the newly created item always belong to the active
 * company. Item creation plus initial overrides commit or roll back together.
 */
import type { Express, Request, Response, RequestHandler } from "express";
import { pool } from "../../db";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { getProfitCheckSupplierScope } from "./supplier-scope";

export function registerSupplierProfitAddStockItemRoutes(app: Express, requireAuth: RequestHandler) {
  app.post("/api/supplier-profit-check/add-stock-item", requireAuth, async (req: Request, res: Response) => {
    const companyId = req.session.currentCompanyId;
    if (!companyId) return res.status(400).json({ message: "No company selected" });

    const { code, name, stockGroupId: rawStockGroupId, supplierId: rawSupplierId, dubaiPrice, avgSellPrice } = req.body;
    const normalizedCode = String(code ?? "")
      .trim()
      .toUpperCase();
    const normalizedName = String(name ?? "").trim();
    const supplierId = Number(rawSupplierId);
    const stockGroupId = rawStockGroupId ? Number(rawStockGroupId) : null;
    if (!normalizedCode || !normalizedName) return res.status(400).json({ message: "Code and name are required" });
    if (!Number.isInteger(supplierId) || supplierId <= 0)
      return res.status(400).json({ message: "supplierId required" });
    if (stockGroupId !== null && (!Number.isInteger(stockGroupId) || stockGroupId <= 0)) {
      return res.status(400).json({ message: "Invalid stockGroupId" });
    }

    if (!(await getProfitCheckSupplierScope(supplierId, companyId))) {
      return res.status(404).json({ message: "Supplier not found" });
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      if (stockGroupId !== null) {
        const group = await client.query(`SELECT id FROM stock_groups WHERE id = $1 AND company_id = $2`, [
          stockGroupId,
          companyId,
        ]);
        if (group.rows.length === 0) {
          await client.query("ROLLBACK");
          return res.status(404).json({ message: "Stock group not found" });
        }
      }

      const existing = await client.query(
        `SELECT id FROM stock_items WHERE company_id = $1 AND lower(code) = lower($2) AND deleted_at IS NULL`,
        [companyId, normalizedCode]
      );
      if (existing.rows.length > 0) {
        await client.query("ROLLBACK");
        return res.status(409).json({ message: `Item with code "${normalizedCode}" already exists` });
      }

      const result = await client.query(
        `
        INSERT INTO stock_items (company_id, code, name, stock_group_id, uom, active, created_at)
        VALUES ($1, $2, $3, $4, 'Bale', true, now())
        RETURNING id, code, name, stock_group_id
      `,
        [companyId, normalizedCode, normalizedName, stockGroupId]
      );
      const item = result.rows[0];

      const parsedDubai = Number(dubaiPrice);
      const parsedAvg = Number(avgSellPrice);
      const hasDubai = Number.isFinite(parsedDubai) && parsedDubai > 0;
      const hasAvg = Number.isFinite(parsedAvg) && parsedAvg > 0;
      if (hasDubai || hasAvg) {
        await client.query(
          `
          INSERT INTO supplier_profit_po_overrides
            (supplier_id, stock_item_id, po_price, avg_price, updated_at)
          VALUES ($1, $2, $3, $4, now())
          ON CONFLICT (supplier_id, stock_item_id)
          DO UPDATE SET
            po_price = EXCLUDED.po_price,
            avg_price = EXCLUDED.avg_price,
            updated_at = now()
        `,
          [supplierId, item.id, hasDubai ? parsedDubai : null, hasAvg ? parsedAvg : null]
        );
      }

      await client.query("COMMIT");
      res.json({ id: item.id, code: item.code, name: item.name, stockGroupId: item.stock_group_id });
    } catch (err: unknown) {
      await client.query("ROLLBACK").catch(() => undefined);
      logger.error("[supplier-profit-check/add-stock-item]", { error: getErrorMessage(err) });
      res.status(500).json({ message: getErrorMessage(err) });
    } finally {
      client.release();
    }
  });
}
