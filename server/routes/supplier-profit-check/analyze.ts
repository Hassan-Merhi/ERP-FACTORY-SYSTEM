/**
 * Supplier Profit Check analysis endpoint.
 *
 * Source rows are resolved to one canonical stock item and aggregated before
 * profitability is calculated. This prevents duplicate proforma/container
 * lines from multiplying quantities, landing costs, or profit in the client.
 * Legacy/imported proforma rows that no longer resolve are retained with a
 * synthetic negative id so their quantity is never silently dropped.
 */
import type { Express, Request, Response, RequestHandler } from "express";
import { pool } from "../../db";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { buildSupplierProfitRows, type ProfitSourceItem } from "./analysis-core";
import { getProfitCheckSupplierScope } from "./supplier-scope";

const VALID_SOURCE_TYPES = new Set(["all", "proforma", "otw_containers"]);

export function registerSupplierProfitAnalyzeRoutes(app: Express, requireAuth: RequestHandler) {
  app.post("/api/supplier-profit-check/analyze", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const {
        supplierId: rawSupplierId,
        fromDate,
        toDate,
        sourceType = "all",
        proformaId: rawProformaId,
        containerIds,
        sellPriceSource,
        locationId: rawLocationId,
      } = req.body;
      const supplierId = Number(rawSupplierId);
      if (!Number.isInteger(supplierId) || supplierId <= 0) {
        return res.status(400).json({ message: "supplierId required" });
      }
      if (!VALID_SOURCE_TYPES.has(sourceType)) {
        return res.status(400).json({ message: "Invalid sourceType" });
      }

      const supplierScope = await getProfitCheckSupplierScope(supplierId, companyId);
      if (!supplierScope) {
        return res.status(404).json({ message: "Supplier not found" });
      }

      let items: ProfitSourceItem[] = [];

      if (sourceType === "proforma") {
        const proformaId = Number(rawProformaId);
        if (!Number.isInteger(proformaId) || proformaId <= 0) {
          return res.status(400).json({ message: "proformaId required" });
        }

        const itemsResult = await pool.query(
          `
          WITH source_rows AS (
            SELECT
              spl.id AS source_line_id,
              spl.barcode AS source_barcode,
              spl.item_name AS source_item_name,
              spl.qty::numeric AS qty,
              spl.price_per_bale::numeric AS price_per_bale,
              si.id AS stock_item_id,
              si.code,
              si.name,
              si.stock_group_id,
              sg.name AS stock_group_name,
              CASE
                WHEN si.id IS NOT NULL THEN 'stock:' || si.id::text
                ELSE 'raw:' || lower(spl.barcode)
              END AS group_key
            FROM supplier_proforma_lines spl
            JOIN supplier_proformas sp ON sp.id = spl.proforma_id
            LEFT JOIN LATERAL (
              SELECT candidate.id, candidate.code, candidate.name, candidate.stock_group_id
              FROM stock_items candidate
              WHERE candidate.company_id = $2
                AND candidate.deleted_at IS NULL
                AND (
                  lower(candidate.code) = lower(spl.barcode)
                  OR EXISTS (
                    SELECT 1
                    FROM stock_item_code_aliases alias
                    WHERE alias.stock_item_id = candidate.id
                      AND alias.company_id = $2
                      AND lower(alias.alias_code) = lower(spl.barcode)
                  )
                )
              ORDER BY
                CASE WHEN lower(candidate.code) = lower(spl.barcode) THEN 0 ELSE 1 END,
                candidate.id
              LIMIT 1
            ) si ON TRUE
            LEFT JOIN stock_groups sg ON sg.id = si.stock_group_id
            WHERE sp.id = $1
              AND sp.company_id = $2
              AND sp.supplier_id = $3
          )
          SELECT
            CASE
              WHEN MAX(source_rows.stock_item_id) IS NOT NULL THEN MAX(source_rows.stock_item_id)
              ELSE -MIN(source_rows.source_line_id)
            END AS id,
            COALESCE(MAX(source_rows.code), MIN(source_rows.source_barcode)) AS code,
            COALESCE(MAX(source_rows.name), MIN(source_rows.source_item_name), MIN(source_rows.source_barcode)) AS name,
            MAX(source_rows.stock_group_id) AS stock_group_id,
            MAX(source_rows.stock_group_name) AS stock_group_name,
            SUM(source_rows.qty)::numeric AS proforma_qty,
            MAX(source_rows.price_per_bale)::numeric AS proforma_price,
            MIN(source_rows.source_barcode) AS proforma_barcode,
            (MAX(source_rows.stock_item_id) IS NULL) AS unresolved
          FROM source_rows
          GROUP BY source_rows.group_key
          ORDER BY code, id
        `,
          [proformaId, companyId, supplierId]
        );
        items = itemsResult.rows as ProfitSourceItem[];
      } else if (sourceType === "otw_containers") {
        const requestedContainerIds = Array.isArray(containerIds)
          ? [
              ...new Set(
                containerIds.map((value) => Number(value)).filter((value) => Number.isInteger(value) && value > 0)
              ),
            ]
          : [];
        if (requestedContainerIds.length === 0) {
          return res.status(400).json({ message: "Select at least one OTW container" });
        }

        const scopedContainers = await pool.query(
          `
          SELECT id
          FROM containers
          WHERE id = ANY($1::int[])
            AND company_id = $2
            AND supplier_id = $3
            AND status = 'OTW'
        `,
          [requestedContainerIds, companyId, supplierId]
        );
        if (scopedContainers.rows.length !== requestedContainerIds.length) {
          return res
            .status(400)
            .json({ message: "One or more selected containers are invalid for this supplier/company" });
        }

        const itemsResult = await pool.query(
          `
          WITH resolved AS (
            SELECT
              si.id,
              si.code,
              si.name,
              si.stock_group_id,
              sg.name AS stock_group_name,
              scli.qty::numeric AS qty,
              scli.price_per_bale::numeric AS price_per_bale
            FROM supplier_container_loaded_items scli
            JOIN containers c ON c.id = scli.container_id
            JOIN LATERAL (
              SELECT candidate.id, candidate.code, candidate.name, candidate.stock_group_id
              FROM stock_items candidate
              WHERE candidate.company_id = $2
                AND candidate.deleted_at IS NULL
                AND (
                  lower(candidate.code) = lower(scli.barcode)
                  OR EXISTS (
                    SELECT 1
                    FROM stock_item_code_aliases alias
                    WHERE alias.stock_item_id = candidate.id
                      AND alias.company_id = $2
                      AND lower(alias.alias_code) = lower(scli.barcode)
                  )
                )
              ORDER BY
                CASE WHEN lower(candidate.code) = lower(scli.barcode) THEN 0 ELSE 1 END,
                candidate.id
              LIMIT 1
            ) si ON TRUE
            LEFT JOIN stock_groups sg ON sg.id = si.stock_group_id
            WHERE c.id = ANY($1::int[])
              AND c.company_id = $2
              AND c.supplier_id = $3
              AND c.status = 'OTW'
          )
          SELECT
            resolved.id,
            resolved.code,
            resolved.name,
            resolved.stock_group_id,
            resolved.stock_group_name,
            SUM(resolved.qty)::numeric AS proforma_qty,
            MAX(resolved.price_per_bale)::numeric AS proforma_price,
            resolved.code AS proforma_barcode
          FROM resolved
          GROUP BY
            resolved.id,
            resolved.code,
            resolved.name,
            resolved.stock_group_id,
            resolved.stock_group_name
          ORDER BY resolved.code, resolved.id
        `,
          [requestedContainerIds, companyId, supplierId]
        );
        items = itemsResult.rows as ProfitSourceItem[];
      } else {
        let linkedStockGroupId = supplierScope.stockGroupId;

        // Parent-owned suppliers can carry a stock-group id from the parent
        // tenant. Map that group to the active company by stable group code;
        // if no corresponding group exists, use the active company's full item
        // catalog rather than returning an empty Profit Check.
        if (linkedStockGroupId && supplierScope.ownerCompanyId !== companyId) {
          const mappedGroup = await pool.query(
            `
            SELECT child.id
            FROM stock_groups parent
            JOIN stock_groups child
              ON child.company_id = $1
             AND lower(child.code) = lower(parent.code)
            WHERE parent.id = $2
              AND parent.company_id = $3
            LIMIT 1
          `,
            [companyId, linkedStockGroupId, supplierScope.ownerCompanyId]
          );
          linkedStockGroupId = mappedGroup.rows[0]?.id ? Number(mappedGroup.rows[0].id) : null;
        }

        const itemsResult = linkedStockGroupId
          ? await pool.query(
              `
              SELECT
                si.id,
                si.code,
                si.name,
                si.stock_group_id,
                sg.name AS stock_group_name,
                NULL::integer AS proforma_qty,
                NULL::numeric AS proforma_price,
                si.code AS proforma_barcode
              FROM stock_items si
              LEFT JOIN stock_groups sg ON sg.id = si.stock_group_id
              WHERE si.company_id = $1
                AND si.deleted_at IS NULL
                AND si.stock_group_id = $2
              ORDER BY si.code, si.id
            `,
              [companyId, linkedStockGroupId]
            )
          : await pool.query(
              `
              SELECT
                si.id,
                si.code,
                si.name,
                si.stock_group_id,
                sg.name AS stock_group_name,
                NULL::integer AS proforma_qty,
                NULL::numeric AS proforma_price,
                si.code AS proforma_barcode
              FROM stock_items si
              LEFT JOIN stock_groups sg ON sg.id = si.stock_group_id
              WHERE si.company_id = $1
                AND si.deleted_at IS NULL
              ORDER BY si.code, si.id
            `,
              [companyId]
            );
        items = itemsResult.rows as ProfitSourceItem[];
      }

      if (items.length === 0) return res.json([]);

      const rows = await buildSupplierProfitRows({
        companyId,
        supplierId,
        items,
        fromDate,
        toDate,
        sellPriceSource,
        locationId: rawLocationId ? Number(rawLocationId) : null,
      });
      res.json(rows);
    } catch (err: unknown) {
      logger.error("[supplier-profit-check/analyze]", { error: getErrorMessage(err) });
      res.status(500).json({ message: getErrorMessage(err) });
    }
  });
}
