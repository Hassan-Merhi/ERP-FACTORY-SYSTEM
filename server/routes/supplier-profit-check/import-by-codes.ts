/**
 * Supplier Profit Check Excel-code import.
 *
 * Code/alias resolution uses the same one-input-to-one-stock-item rule as the
 * main analyzer, then the shared analysis core guarantees one output row per
 * stock item. A supplied supplier id may belong to the active company or its
 * explicitly linked parent company.
 */
import type { Express, Request, Response, RequestHandler } from "express";
import { pool } from "../../db";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { buildSupplierProfitRows, type ProfitSourceItem } from "./analysis-core";
import { getProfitCheckSupplierScope } from "./supplier-scope";

export function registerSupplierProfitImportRoutes(app: Express, requireAuth: RequestHandler) {
  app.post("/api/supplier-profit-check/import-by-codes", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const {
        codes,
        supplierId: rawSupplierId,
        fromDate,
        toDate,
        sellPriceSource,
        locationId: rawLocationId,
      } = req.body;
      if (!Array.isArray(codes) || codes.length === 0) {
        return res.status(400).json({ message: "codes array is required" });
      }
      if (codes.length > 5000) {
        return res.status(400).json({ message: "Too many item codes in one import" });
      }

      const normalizedCodes = codes.map((value: unknown) =>
        String(value ?? "")
          .trim()
          .toLowerCase()
      );
      const validCodes = normalizedCodes.filter(Boolean);
      if (validCodes.length === 0) return res.status(400).json({ message: "No valid codes provided" });

      let supplierId: number | null = null;
      if (rawSupplierId !== undefined && rawSupplierId !== null && rawSupplierId !== "") {
        supplierId = Number(rawSupplierId);
        if (!Number.isInteger(supplierId) || supplierId <= 0) {
          return res.status(400).json({ message: "Invalid supplierId" });
        }
        if (!(await getProfitCheckSupplierScope(supplierId, companyId))) {
          return res.status(404).json({ message: "Supplier not found" });
        }
      }

      const resolvedResult = await pool.query(
        `
        WITH input AS (
          SELECT code, ord
          FROM unnest($2::text[]) WITH ORDINALITY AS incoming(code, ord)
        )
        SELECT
          input.ord,
          input.code AS input_code,
          si.id,
          si.code,
          si.name,
          si.stock_group_id,
          sg.name AS stock_group_name,
          NULL::integer AS proforma_qty,
          NULL::numeric AS proforma_price,
          si.code AS proforma_barcode
        FROM input
        JOIN LATERAL (
          SELECT candidate.id, candidate.code, candidate.name, candidate.stock_group_id
          FROM stock_items candidate
          WHERE candidate.company_id = $1
            AND candidate.deleted_at IS NULL
            AND (
              lower(candidate.code) = input.code
              OR EXISTS (
                SELECT 1
                FROM stock_item_code_aliases alias
                WHERE alias.stock_item_id = candidate.id
                  AND alias.company_id = $1
                  AND lower(alias.alias_code) = input.code
              )
            )
          ORDER BY CASE WHEN lower(candidate.code) = input.code THEN 0 ELSE 1 END, candidate.id
          LIMIT 1
        ) si ON TRUE
        LEFT JOIN stock_groups sg ON sg.id = si.stock_group_id
        ORDER BY input.ord
      `,
        [companyId, validCodes]
      );

      const foundInputCodes = new Set(resolvedResult.rows.map((row) => String(row.input_code).toLowerCase()));
      const notFound = codes.filter((value: unknown) => {
        const normalized = String(value ?? "")
          .trim()
          .toLowerCase();
        return normalized.length > 0 && !foundInputCodes.has(normalized);
      });
      const matches = resolvedResult.rows.map((row) => ({
        inputIndex: Number(row.ord) - 1,
        inputCode: String(row.input_code),
        stockItemId: Number(row.id),
        code: String(row.code),
      }));

      const items = resolvedResult.rows.map((row): ProfitSourceItem => ({
        id: row.id,
        code: row.code,
        name: row.name,
        stock_group_id: row.stock_group_id,
        stock_group_name: row.stock_group_name,
        proforma_qty: null,
        proforma_price: null,
        proforma_barcode: row.proforma_barcode,
      }));

      if (items.length === 0) return res.json({ rows: [], notFound, matches });

      const rows = await buildSupplierProfitRows({
        companyId,
        supplierId,
        items,
        fromDate,
        toDate,
        sellPriceSource,
        locationId: rawLocationId ? Number(rawLocationId) : null,
      });

      res.json({ rows, notFound, matches });
    } catch (err: unknown) {
      logger.error("[supplier-profit-check/import-by-codes]", { error: getErrorMessage(err) });
      res.status(500).json({ message: getErrorMessage(err) });
    }
  });
}
