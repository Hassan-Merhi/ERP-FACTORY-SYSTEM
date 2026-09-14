import type { Express, Request, Response } from "express";
import { getErrorMessage, sendHttpError } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { pool } from "../../db";
import { requireAuth } from "../../auth";

function getFactoryCompanyId(req: import("express").Request): number | undefined {
  return req.session.factoryCompanyId || req.session.currentCompanyId;
}

async function hasWriteAccess(req: import("express").Request, companyId: number): Promise<boolean> {
  const role = req.user?.role;
  if (role === "Admin" || role === "Owner" || role === "Developer") return true;
  const userId = req.user?.id;
  if (!userId) return false;
  const { rows } = await pool.query(
    `SELECT 1 FROM factory_user_page_access WHERE user_id = $1 AND company_id = $2 AND page_key = 'factory/sheets-sacks'`,
    [userId, companyId]
  );
  return rows.length > 0;
}

const SELECT_COLS = `
  id, company_id AS "companyId", type, name, size,
  quantity, unit_price AS "unitPrice",
  pack_qty AS "packQty", pcs_per_pack AS "pcsPerPack",
  row_color AS "rowColor",
  notes, created_at AS "createdAt"
`;

const LOG_COLS = `
  id, company_id AS "companyId", item_id AS "itemId",
  item_name AS "itemName", item_type AS "itemType",
  action, pieces, packs,
  unit_price AS "unitPrice", total_value AS "totalValue",
  notes, created_at AS "createdAt"
`;

async function insertLog(
  client: import("pg").PoolClient,
  companyId: number,
  itemId: number,
  itemName: string,
  itemType: string,
  action: "IN" | "OUT" | "ADJUST",
  pieces: number,
  packs: number | null,
  unitPrice: number,
  notes: string | null
) {
  const totalValue = pieces * unitPrice;
  await client.query(
    `INSERT INTO factory_sheets_sacks_log
       (company_id, item_id, item_name, item_type, action, pieces, packs, unit_price, total_value, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [companyId, itemId, itemName, itemType, action, pieces, packs, unitPrice, totalValue, notes]
  );
}

export function registerFactorySheetsAndSacksRoutes(app: Express) {
  // ── GET /api/factory/sheets-sacks/log ─────────────────────────────────────
  // Must be before /:id routes
  app.get("/api/factory/sheets-sacks/log", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = getFactoryCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const { from, to, action, itemId, limit } = req.query;
      const params: unknown[] = [companyId];
      const conditions: string[] = ["company_id = $1"];

      if (from) {
        params.push(from);
        conditions.push(`created_at >= $${params.length}::date`);
      }
      if (to) {
        params.push(to);
        conditions.push(`created_at < ($${params.length}::date + interval '1 day')`);
      }
      if (action && action !== "all") {
        params.push(action);
        conditions.push(`action = $${params.length}`);
      }
      const parsedItemId = itemId ? parseInt(itemId as string) : NaN;
      if (!isNaN(parsedItemId)) {
        params.push(parsedItemId);
        conditions.push(`item_id = $${params.length}`);
      }

      const maxRows = Math.min(parseInt((limit as string) || "500") || 500, 2000);
      params.push(maxRows);

      const { rows } = await pool.query(
        `SELECT ${LOG_COLS}
         FROM factory_sheets_sacks_log
         WHERE ${conditions.join(" AND ")}
         ORDER BY created_at DESC
         LIMIT $${params.length}`,
        params
      );
      res.json(rows);
    } catch (err: unknown) {
      logger.error("GET /api/factory/sheets-sacks/log error:", { error: err });
      res.status(500).json({ message: getErrorMessage(err) });
    }
  });

  // ── GET /api/factory/sheets-sacks ─────────────────────────────────────────
  app.get("/api/factory/sheets-sacks", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = getFactoryCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const { rows } = await pool.query(
        `SELECT ${SELECT_COLS}
         FROM factory_sheets_sacks
         WHERE company_id = $1
         ORDER BY type, name`,
        [companyId]
      );
      res.json(rows);
    } catch (err: unknown) {
      logger.error("GET /api/factory/sheets-sacks error:", { error: err });
      res.status(500).json({ message: getErrorMessage(err) || "Failed to fetch items" });
    }
  });

  // ── POST /api/factory/sheets-sacks ────────────────────────────────────────
  app.post("/api/factory/sheets-sacks", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = getFactoryCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      if (!(await hasWriteAccess(req, companyId))) return res.status(403).json({ message: "Access denied" });

      const { type, name, size, quantity, unitPrice, packQty, pcsPerPack, rowColor, notes } = req.body;
      if (!name || !type) return res.status(400).json({ message: "name and type are required" });

      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const { rows } = await client.query(
          `INSERT INTO factory_sheets_sacks
             (company_id, type, name, size, quantity, unit_price, pack_qty, pcs_per_pack, row_color, notes)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
           RETURNING ${SELECT_COLS}`,
          [
            companyId,
            type,
            name,
            size || null,
            quantity || 0,
            unitPrice || 0,
            packQty != null ? parseInt(packQty) : null,
            pcsPerPack != null ? parseInt(pcsPerPack) : null,
            rowColor || null,
            notes || null,
          ]
        );
        const item = rows[0];
        const pcs = parseInt(quantity) || 0;
        if (pcs > 0) {
          await insertLog(
            client,
            companyId,
            item.id,
            name,
            type,
            "IN",
            pcs,
            packQty != null ? parseInt(packQty) : null,
            parseFloat(unitPrice) || 0,
            "Initial stock"
          );
        }
        await client.query("COMMIT");
        res.status(201).json(item);
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      } finally {
        client.release();
      }
    } catch (err: unknown) {
      logger.error("POST /api/factory/sheets-sacks error:", { error: err });
      res.status(500).json({ message: getErrorMessage(err) || "Failed to create item" });
    }
  });

  // ── PATCH /api/factory/sheets-sacks/:id ──────────────────────────────────
  app.patch("/api/factory/sheets-sacks/:id", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = getFactoryCompanyId(req);
      const id = parseInt(req.params.id);
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      if (!(await hasWriteAccess(req, companyId))) return res.status(403).json({ message: "Access denied" });

      const { type, name, size, quantity, unitPrice, packQty, pcsPerPack, rowColor, notes } = req.body;

      // The text fields above normalize blanks to null so COALESCE keeps the
      // stored value. The numeric ones used `?? null`, which let a blank
      // string through to a numeric column — "invalid input syntax for type
      // numeric" as a 500. Treat blank as absent like the text fields, and
      // reject a value that is present but not a number.
      //
      // pack_qty and pcs_per_pack are INTEGER columns, so they need the
      // integer check too: a finite 1.5 would otherwise reach them and fail
      // the query the same way, which the parseInt these replaced did not do.
      type ParsedNumber = { ok: true; value: number | null } | { ok: false };
      const parseNumber = (value: unknown, integerOnly: boolean): ParsedNumber => {
        if (value === undefined || value === null || value === "") return { ok: true, value: null };
        const parsed = Number(value);
        if (!Number.isFinite(parsed)) return { ok: false };
        if (integerOnly && !Number.isInteger(parsed)) return { ok: false };
        return { ok: true, value: parsed };
      };
      const parsedQuantity = parseNumber(quantity, false);
      const parsedUnitPrice = parseNumber(unitPrice, false);
      const parsedPackQty = parseNumber(packQty, true);
      const parsedPcsPerPack = parseNumber(pcsPerPack, true);
      if (!parsedQuantity.ok) return res.status(400).json({ message: "Invalid quantity", field: "quantity" });
      if (!parsedUnitPrice.ok) return res.status(400).json({ message: "Invalid request data", field: "unitPrice" });
      if (!parsedPackQty.ok) return res.status(400).json({ message: "Invalid request data", field: "packQty" });
      if (!parsedPcsPerPack.ok) {
        return res.status(400).json({ message: "Invalid request data", field: "pcsPerPack" });
      }
      const quantityParam = parsedQuantity.value;
      const unitPriceParam = parsedUnitPrice.value;
      const packQtyParam = parsedPackQty.value;
      const pcsPerPackParam = parsedPcsPerPack.value;

      const { rows } = await pool.query(
        `UPDATE factory_sheets_sacks
         SET type         = COALESCE($1, type),
             name         = COALESCE($2, name),
             size         = $3,
             quantity     = COALESCE($4, quantity),
             unit_price   = COALESCE($5, unit_price),
             pack_qty     = $6,
             pcs_per_pack = $7,
             row_color    = $8,
             notes        = $9
         WHERE id = $10 AND company_id = $11
         RETURNING ${SELECT_COLS}`,
        [
          type || null,
          name || null,
          size || null,
          quantityParam,
          unitPriceParam,
          packQtyParam,
          pcsPerPackParam,
          rowColor || null,
          notes || null,
          id,
          companyId,
        ]
      );
      if (rows.length === 0) return res.status(404).json({ message: "Item not found" });
      res.json(rows[0]);
    } catch (err: unknown) {
      logger.error("PATCH /api/factory/sheets-sacks/:id error:", { error: err });
      sendHttpError(res, err);
    }
  });

  // ── PATCH /api/factory/sheets-sacks/:id/restock — add stock (IN) ─────────
  app.patch("/api/factory/sheets-sacks/:id/restock", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = getFactoryCompanyId(req);
      const id = parseInt(req.params.id);
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      if (!(await hasWriteAccess(req, companyId))) return res.status(403).json({ message: "Access denied" });

      const pieces = parseInt(req.body.pieces) || 0;
      const packs = req.body.packs != null ? parseInt(req.body.packs) : null;
      if (pieces <= 0) return res.status(400).json({ message: "Pieces to add must be > 0" });

      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        // Lock row to prevent lost-update race conditions
        const { rows: existing } = await client.query(
          `SELECT quantity, pack_qty, name, type, unit_price
           FROM factory_sheets_sacks WHERE id = $1 AND company_id = $2 FOR UPDATE`,
          [id, companyId]
        );
        if (existing.length === 0) {
          await client.query("ROLLBACK");
          return res.status(404).json({ message: "Item not found" });
        }

        const currentQty = parseFloat(existing[0].quantity || "0");
        const currentPackQty = existing[0].pack_qty != null ? parseInt(existing[0].pack_qty) : null;
        const unitPrice = parseFloat(existing[0].unit_price || "0");
        const newQty = currentQty + pieces;
        const newPackQty = packs != null && currentPackQty != null ? currentPackQty + packs : currentPackQty;

        const { rows } = await client.query(
          `UPDATE factory_sheets_sacks
           SET quantity = $1, pack_qty = $2
           WHERE id = $3 AND company_id = $4
           RETURNING ${SELECT_COLS}`,
          [newQty, newPackQty, id, companyId]
        );
        await insertLog(
          client,
          companyId,
          id,
          existing[0].name,
          existing[0].type,
          "IN",
          pieces,
          packs,
          unitPrice,
          req.body.notes || null
        );
        await client.query("COMMIT");
        res.json(rows[0]);
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      } finally {
        client.release();
      }
    } catch (err: unknown) {
      logger.error("PATCH /api/factory/sheets-sacks/:id/restock error:", { error: err });
      res.status(500).json({ message: getErrorMessage(err) || "Failed to restock" });
    }
  });

  // ── PATCH /api/factory/sheets-sacks/:id/deduct — reduce stock (OUT) ──────
  app.patch("/api/factory/sheets-sacks/:id/deduct", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = getFactoryCompanyId(req);
      const id = parseInt(req.params.id);
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      if (!(await hasWriteAccess(req, companyId))) return res.status(403).json({ message: "Access denied" });

      const pieces = parseInt(req.body.pieces) || 0;
      const packs = req.body.packs != null ? parseInt(req.body.packs) : null;
      if (pieces <= 0) return res.status(400).json({ message: "Pieces to deduct must be > 0" });

      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        // Lock row to prevent lost-update race conditions
        const { rows: existing } = await client.query(
          `SELECT quantity, pack_qty, name, type, unit_price
           FROM factory_sheets_sacks WHERE id = $1 AND company_id = $2 FOR UPDATE`,
          [id, companyId]
        );
        if (existing.length === 0) {
          await client.query("ROLLBACK");
          return res.status(404).json({ message: "Item not found" });
        }

        const currentQty = parseFloat(existing[0].quantity || "0");
        const currentPackQty = existing[0].pack_qty != null ? parseInt(existing[0].pack_qty) : null;
        const unitPrice = parseFloat(existing[0].unit_price || "0");
        const newQty = Math.max(0, currentQty - pieces);
        const newPackQty =
          packs != null && currentPackQty != null ? Math.max(0, currentPackQty - packs) : currentPackQty;

        const { rows } = await client.query(
          `UPDATE factory_sheets_sacks
           SET quantity = $1, pack_qty = $2
           WHERE id = $3 AND company_id = $4
           RETURNING ${SELECT_COLS}`,
          [newQty, newPackQty, id, companyId]
        );
        await insertLog(
          client,
          companyId,
          id,
          existing[0].name,
          existing[0].type,
          "OUT",
          pieces,
          packs,
          unitPrice,
          req.body.notes || null
        );
        await client.query("COMMIT");
        res.json(rows[0]);
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      } finally {
        client.release();
      }
    } catch (err: unknown) {
      logger.error("PATCH /api/factory/sheets-sacks/:id/deduct error:", { error: err });
      res.status(500).json({ message: getErrorMessage(err) || "Failed to deduct" });
    }
  });

  // ── DELETE /api/factory/sheets-sacks/:id ─────────────────────────────────
  app.delete("/api/factory/sheets-sacks/:id", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = getFactoryCompanyId(req);
      const id = parseInt(req.params.id);
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      if (!(await hasWriteAccess(req, companyId))) return res.status(403).json({ message: "Access denied" });

      const { rowCount } = await pool.query(`DELETE FROM factory_sheets_sacks WHERE id = $1 AND company_id = $2`, [
        id,
        companyId,
      ]);
      if (!rowCount) return res.status(404).json({ message: "Item not found" });
      res.json({ success: true });
    } catch (err: unknown) {
      logger.error("DELETE /api/factory/sheets-sacks/:id error:", { error: err });
      res.status(500).json({ message: getErrorMessage(err) || "Failed to delete" });
    }
  });
}
