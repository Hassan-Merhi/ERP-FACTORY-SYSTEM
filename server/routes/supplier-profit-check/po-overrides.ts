/**
 * Supplier Profit Check manual price overrides.
 *
 * Overrides are supplier/item keyed in the legacy table, so every read/write
 * validates the supplier against the active company or its explicitly linked
 * parent and validates stock items against the active company. Null is an
 * explicit reset value; omitted fields retain their previous value.
 */
import type { Express, Request, Response, RequestHandler } from "express";
import type { PoolClient } from "pg";
import { pool } from "../../db";
import { getErrorMessage } from "../../lib/httpHandlers";
import { getProfitCheckSupplierScope } from "./supplier-scope";

function normalizeNullablePrice(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new Error("Price must be greater than zero or null");
  return number;
}

async function supplierBelongsToCompany(supplierId: number, companyId: number): Promise<boolean> {
  return Boolean(await getProfitCheckSupplierScope(supplierId, companyId));
}

async function stockItemBelongsToCompany(stockItemId: number, companyId: number): Promise<boolean> {
  const result = await pool.query(
    `SELECT id FROM stock_items WHERE id = $1 AND company_id = $2 AND deleted_at IS NULL`,
    [stockItemId, companyId]
  );
  return result.rows.length > 0;
}

interface BulkOverrideRow {
  stockItemId: number;
  hasPoPrice: boolean;
  hasAvgPrice: boolean;
  poPrice: number | null;
  avgPrice: number | null;
}

async function upsertBulkRows(client: PoolClient, supplierId: number, rows: BulkOverrideRow[]) {
  const both = rows.filter((row) => row.hasPoPrice && row.hasAvgPrice);
  const poOnly = rows.filter((row) => row.hasPoPrice && !row.hasAvgPrice);
  const avgOnly = rows.filter((row) => !row.hasPoPrice && row.hasAvgPrice);

  if (both.length > 0) {
    const values: unknown[] = [];
    const placeholders: string[] = [];
    let parameter = 1;
    for (const row of both) {
      values.push(supplierId, row.stockItemId, row.poPrice, row.avgPrice);
      placeholders.push(`($${parameter},$${parameter + 1},$${parameter + 2},$${parameter + 3},now())`);
      parameter += 4;
    }
    await client.query(
      `
      INSERT INTO supplier_profit_po_overrides
        (supplier_id, stock_item_id, po_price, avg_price, updated_at)
      VALUES ${placeholders.join(",")}
      ON CONFLICT (supplier_id, stock_item_id)
      DO UPDATE SET
        po_price = EXCLUDED.po_price,
        avg_price = EXCLUDED.avg_price,
        updated_at = now()
    `,
      values
    );
  }

  if (poOnly.length > 0) {
    const values: unknown[] = [];
    const placeholders: string[] = [];
    let parameter = 1;
    for (const row of poOnly) {
      values.push(supplierId, row.stockItemId, row.poPrice);
      placeholders.push(`($${parameter},$${parameter + 1},$${parameter + 2},NULL,now())`);
      parameter += 3;
    }
    await client.query(
      `
      INSERT INTO supplier_profit_po_overrides
        (supplier_id, stock_item_id, po_price, avg_price, updated_at)
      VALUES ${placeholders.join(",")}
      ON CONFLICT (supplier_id, stock_item_id)
      DO UPDATE SET
        po_price = EXCLUDED.po_price,
        updated_at = now()
    `,
      values
    );
  }

  if (avgOnly.length > 0) {
    const values: unknown[] = [];
    const placeholders: string[] = [];
    let parameter = 1;
    for (const row of avgOnly) {
      values.push(supplierId, row.stockItemId, row.avgPrice);
      placeholders.push(`($${parameter},$${parameter + 1},NULL,$${parameter + 2},now())`);
      parameter += 3;
    }
    await client.query(
      `
      INSERT INTO supplier_profit_po_overrides
        (supplier_id, stock_item_id, po_price, avg_price, updated_at)
      VALUES ${placeholders.join(",")}
      ON CONFLICT (supplier_id, stock_item_id)
      DO UPDATE SET
        avg_price = EXCLUDED.avg_price,
        updated_at = now()
    `,
      values
    );
  }
}

export function registerSupplierProfitPoOverrideRoutes(app: Express, requireAuth: RequestHandler) {
  app.get("/api/supplier-profit-check/po-overrides", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const supplierId = Number(req.query.supplierId);
      if (!Number.isInteger(supplierId) || supplierId <= 0) {
        return res.status(400).json({ message: "supplierId required" });
      }
      if (!(await supplierBelongsToCompany(supplierId, companyId))) {
        return res.status(404).json({ message: "Supplier not found" });
      }

      const result = await pool.query(
        `
        SELECT
          spo.stock_item_id AS "stockItemId",
          spo.po_price AS "poPrice",
          spo.avg_price AS "avgPrice"
        FROM supplier_profit_po_overrides spo
        JOIN stock_items si ON si.id = spo.stock_item_id
        WHERE spo.supplier_id = $1
          AND si.company_id = $2
          AND si.deleted_at IS NULL
        ORDER BY spo.stock_item_id
      `,
        [supplierId, companyId]
      );
      res.json(result.rows);
    } catch (err: unknown) {
      res.status(500).json({ message: getErrorMessage(err) });
    }
  });

  app.put("/api/supplier-profit-check/po-overrides/bulk", requireAuth, async (req: Request, res: Response) => {
    const companyId = req.session.currentCompanyId;
    if (!companyId) return res.status(400).json({ message: "No company selected" });

    try {
      const supplierId = Number(req.body?.supplierId);
      const overrides = req.body?.overrides;
      if (!Number.isInteger(supplierId) || supplierId <= 0 || !Array.isArray(overrides)) {
        return res.status(400).json({ message: "supplierId and overrides required" });
      }
      if (overrides.length > 5000) return res.status(400).json({ message: "Too many overrides" });
      if (!(await supplierBelongsToCompany(supplierId, companyId))) {
        return res.status(404).json({ message: "Supplier not found" });
      }
      if (overrides.length === 0) return res.json({ ok: true });

      const normalized = new Map<number, BulkOverrideRow>();
      for (const row of overrides) {
        const stockItemId = Number(row?.stockItemId);
        if (!Number.isInteger(stockItemId) || stockItemId <= 0) {
          return res.status(400).json({ message: "Invalid stockItemId in overrides" });
        }
        const hasPoPrice = Object.prototype.hasOwnProperty.call(row, "poPrice");
        const hasAvgPrice = Object.prototype.hasOwnProperty.call(row, "avgPrice");
        if (!hasPoPrice && !hasAvgPrice) {
          return res.status(400).json({ message: "Each override requires poPrice and/or avgPrice" });
        }
        normalized.set(stockItemId, {
          stockItemId,
          hasPoPrice,
          hasAvgPrice,
          poPrice: hasPoPrice ? normalizeNullablePrice(row.poPrice) : null,
          avgPrice: hasAvgPrice ? normalizeNullablePrice(row.avgPrice) : null,
        });
      }

      const stockItemIds = [...normalized.keys()];
      const scopedItems = await pool.query(
        `
        SELECT id
        FROM stock_items
        WHERE company_id = $1
          AND deleted_at IS NULL
          AND id = ANY($2::int[])
      `,
        [companyId, stockItemIds]
      );
      if (scopedItems.rows.length !== stockItemIds.length) {
        return res.status(400).json({ message: "One or more stock items are invalid for the active company" });
      }

      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await upsertBulkRows(client, supplierId, [...normalized.values()]);
        await client.query(
          `
          DELETE FROM supplier_profit_po_overrides
          WHERE supplier_id = $1
            AND stock_item_id = ANY($2::int[])
            AND po_price IS NULL
            AND avg_price IS NULL
        `,
          [supplierId, stockItemIds]
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
      res.json({ ok: true });
    } catch (err: unknown) {
      const message = getErrorMessage(err);
      const status = message.includes("Price must") ? 400 : 500;
      res.status(status).json({ message });
    }
  });

  app.put("/api/supplier-profit-check/po-overrides", requireAuth, async (req: Request, res: Response) => {
    const companyId = req.session.currentCompanyId;
    if (!companyId) return res.status(400).json({ message: "No company selected" });

    try {
      const { supplierId: rawSupplierId, stockItemId: rawStockItemId } = req.body;
      const supplierId = Number(rawSupplierId);
      const stockItemId = Number(rawStockItemId);
      if (!Number.isInteger(supplierId) || supplierId <= 0 || !Number.isInteger(stockItemId) || stockItemId <= 0) {
        return res.status(400).json({ message: "supplierId and stockItemId required" });
      }
      const hasPoPrice = Object.prototype.hasOwnProperty.call(req.body, "poPrice");
      const hasAvgPrice = Object.prototype.hasOwnProperty.call(req.body, "avgPrice");
      if (!hasPoPrice && !hasAvgPrice) return res.status(400).json({ message: "No override field supplied" });

      if (!(await supplierBelongsToCompany(supplierId, companyId))) {
        return res.status(404).json({ message: "Supplier not found" });
      }
      if (!(await stockItemBelongsToCompany(stockItemId, companyId))) {
        return res.status(404).json({ message: "Stock item not found" });
      }

      const poPrice = hasPoPrice ? normalizeNullablePrice(req.body.poPrice) : null;
      const avgPrice = hasAvgPrice ? normalizeNullablePrice(req.body.avgPrice) : null;

      await pool.query(
        `
        INSERT INTO supplier_profit_po_overrides
          (supplier_id, stock_item_id, po_price, avg_price, updated_at)
        VALUES ($1, $2, $3, $4, now())
        ON CONFLICT (supplier_id, stock_item_id)
        DO UPDATE SET
          po_price = CASE WHEN $5::boolean THEN EXCLUDED.po_price ELSE supplier_profit_po_overrides.po_price END,
          avg_price = CASE WHEN $6::boolean THEN EXCLUDED.avg_price ELSE supplier_profit_po_overrides.avg_price END,
          updated_at = now()
      `,
        [supplierId, stockItemId, poPrice, avgPrice, hasPoPrice, hasAvgPrice]
      );
      await pool.query(
        `
        DELETE FROM supplier_profit_po_overrides
        WHERE supplier_id = $1
          AND stock_item_id = $2
          AND po_price IS NULL
          AND avg_price IS NULL
      `,
        [supplierId, stockItemId]
      );
      res.json({ ok: true });
    } catch (err: unknown) {
      const message = getErrorMessage(err);
      const status = message.includes("Price must") ? 400 : 500;
      res.status(status).json({ message });
    }
  });
}
