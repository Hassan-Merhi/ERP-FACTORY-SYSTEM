/**
 * Supplier Profit Check proforma persistence.
 *
 * All writes are transactional and every resolvable incoming item is normalized
 * to the active company's canonical stock item before lines are replaced.
 * Duplicate codes/aliases collapse to one line with summed quantity. Unresolved
 * supplier codes are preserved as raw proforma lines instead of being dropped or
 * blocking autosave, so Profit Check can keep the source quantity intact.
 */
import type { Express, Request, Response, RequestHandler } from "express";
import type { PoolClient } from "pg";
import { pool } from "../../db";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { getProfitCheckSupplierScope } from "./supplier-scope";

class ProfitCheckInputError extends Error {
  constructor(
    message: string,
    readonly status = 400
  ) {
    super(message);
  }
}

interface IncomingProformaItem {
  barcode?: unknown;
  code?: unknown;
  name?: unknown;
  itemName?: unknown;
  qty?: unknown;
  supplierPrice?: unknown;
  weight?: unknown;
}

interface ConsolidatedLine {
  stockItemId: number | null;
  barcode: string;
  itemName: string;
  qty: number;
  weightPerBale: number;
  pricePerBale: number;
}

function optionalNonNegativeNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

async function resolveAndConsolidateItems(
  client: PoolClient,
  companyId: number,
  supplierId: number,
  rawItems: IncomingProformaItem[]
): Promise<ConsolidatedLine[]> {
  const positiveItems = rawItems
    .map((item) => {
      const code = String(item.barcode ?? item.code ?? "").trim();
      const qty = Math.round(Number(item.qty) || 0);
      return { item, code, qty };
    })
    .filter(({ qty }) => qty > 0);

  if (positiveItems.length === 0) return [];
  if (positiveItems.some(({ code }) => !code)) throw new ProfitCheckInputError("Every proforma item requires a code");

  const requestedCodes = positiveItems.map(({ code }) => code.toLowerCase());
  const resolvedResult = await client.query(
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
      si.name
    FROM input
    JOIN LATERAL (
      SELECT candidate.id, candidate.code, candidate.name
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
    ORDER BY input.ord
  `,
    [companyId, requestedCodes]
  );

  const resolvedByIndex = new Map<number, { id: number; code: string; name: string }>();
  for (const row of resolvedResult.rows) {
    resolvedByIndex.set(Number(row.ord) - 1, { id: Number(row.id), code: row.code, name: row.name });
  }

  const grouped = new Map<
    string,
    {
      stockItemId: number | null;
      barcode: string;
      itemName: string;
      qty: number;
      pricedQty: number;
      weightedPrice: number;
      weightedWeight: number;
    }
  >();

  positiveItems.forEach(({ item, code, qty }, index) => {
    const resolved = resolvedByIndex.get(index);
    const stockItemId = resolved?.id ?? null;
    const barcode = resolved?.code ?? code;
    const rawItemName = String(item.itemName ?? item.name ?? "").trim();
    const itemName = resolved?.name ?? (rawItemName || code);
    const groupKey = stockItemId != null ? `stock:${stockItemId}` : `raw:${code.toLowerCase()}`;
    const suppliedPrice = optionalNonNegativeNumber(item.supplierPrice);
    const weight = optionalNonNegativeNumber(item.weight) ?? 0;
    const current = grouped.get(groupKey) ?? {
      stockItemId,
      barcode,
      itemName,
      qty: 0,
      pricedQty: 0,
      weightedPrice: 0,
      weightedWeight: 0,
    };
    current.qty += qty;
    current.weightedWeight += qty * weight;
    if (suppliedPrice !== null) {
      current.pricedQty += qty;
      current.weightedPrice += qty * suppliedPrice;
    }
    grouped.set(groupKey, current);
  });

  const stockItemIds = [...grouped.values()]
    .map((line) => line.stockItemId)
    .filter((stockItemId): stockItemId is number => stockItemId != null);
  const overrideResult =
    stockItemIds.length > 0
      ? await client.query(
          `
          SELECT spo.stock_item_id, spo.po_price::numeric AS po_price
          FROM supplier_profit_po_overrides spo
          JOIN stock_items si ON si.id = spo.stock_item_id
          WHERE spo.supplier_id = $1
            AND si.company_id = $2
            AND si.deleted_at IS NULL
            AND spo.stock_item_id = ANY($3::int[])
        `,
          [supplierId, companyId, stockItemIds]
        )
      : { rows: [] };
  const overrideMap = new Map<number, number>();
  for (const row of overrideResult.rows) {
    const price = Number(row.po_price);
    if (Number.isFinite(price) && price > 0) overrideMap.set(Number(row.stock_item_id), price);
  }

  return [...grouped.values()].map((line) => ({
    stockItemId: line.stockItemId,
    barcode: line.barcode,
    itemName: line.itemName,
    qty: line.qty,
    weightPerBale: line.qty > 0 ? line.weightedWeight / line.qty : 0,
    pricePerBale:
      (line.stockItemId != null ? overrideMap.get(line.stockItemId) : undefined) ??
      (line.pricedQty > 0 ? line.weightedPrice / line.pricedQty : 0),
  }));
}

async function insertLines(client: PoolClient, proformaId: number, lines: ConsolidatedLine[]) {
  if (lines.length === 0) return;

  const values: unknown[] = [];
  const placeholders: string[] = [];
  let parameter = 1;
  for (const line of lines) {
    values.push(
      proformaId,
      line.barcode,
      line.itemName,
      line.qty,
      String(line.weightPerBale),
      String(line.pricePerBale.toFixed(2))
    );
    placeholders.push(
      `($${parameter},$${parameter + 1},$${parameter + 2},$${parameter + 3},$${parameter + 4},$${parameter + 5})`
    );
    parameter += 6;
  }

  await client.query(
    `
    INSERT INTO supplier_proforma_lines
      (proforma_id, barcode, item_name, qty, weight_per_bale, price_per_bale)
    VALUES ${placeholders.join(",")}
  `,
    values
  );
}

export function registerSupplierProfitProformaRoutes(app: Express, requireAuth: RequestHandler) {
  app.post("/api/supplier-profit-check/save-proforma", requireAuth, async (req: Request, res: Response) => {
    const companyId = req.session.currentCompanyId;
    if (!companyId) return res.status(400).json({ message: "No company selected" });

    const { supplierId: rawSupplierId, reference, notes, items } = req.body;
    const supplierId = Number(rawSupplierId);
    if (!Number.isInteger(supplierId) || supplierId <= 0 || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ message: "supplierId and items required" });
    }
    if (!(await getProfitCheckSupplierScope(supplierId, companyId))) {
      return res.status(404).json({ message: "Supplier not found" });
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const lines = await resolveAndConsolidateItems(client, companyId, supplierId, items);
      if (lines.length === 0) throw new ProfitCheckInputError("Enter qty for at least one item");

      const proformaRef =
        String(reference ?? "").trim() ||
        `PC-${new Date().toISOString().slice(0, 10)}-${Date.now().toString().slice(-4)}`;
      const proformaResult = await client.query(
        `
        INSERT INTO supplier_proformas (company_id, supplier_id, reference, notes, created_at, updated_at)
        VALUES ($1, $2, $3, $4, now(), now())
        RETURNING id, reference
      `,
        [companyId, supplierId, proformaRef, String(notes ?? "").trim() || null]
      );
      const proforma = proformaResult.rows[0];
      await insertLines(client, Number(proforma.id), lines);
      await client.query("COMMIT");
      res.json({ id: proforma.id, reference: proforma.reference });
    } catch (err: unknown) {
      await client.query("ROLLBACK").catch(() => undefined);
      const status = err instanceof ProfitCheckInputError ? err.status : 500;
      if (status === 500) logger.error("[supplier-profit-check/save-proforma]", { error: getErrorMessage(err) });
      res.status(status).json({ message: getErrorMessage(err) });
    } finally {
      client.release();
    }
  });

  app.put("/api/supplier-profit-check/proforma/:id/update-items", requireAuth, async (req: Request, res: Response) => {
    const companyId = req.session.currentCompanyId;
    if (!companyId) return res.status(400).json({ message: "No company selected" });
    const proformaId = Number(req.params.id);
    if (!Number.isInteger(proformaId) || proformaId <= 0) {
      return res.status(400).json({ message: "Invalid proforma ID" });
    }
    const { items } = req.body;
    if (!Array.isArray(items)) return res.status(400).json({ message: "items array required" });

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const proformaResult = await client.query(
        `
        SELECT id, supplier_id
        FROM supplier_proformas
        WHERE id = $1 AND company_id = $2
        FOR UPDATE
      `,
        [proformaId, companyId]
      );
      if (proformaResult.rows.length === 0) throw new ProfitCheckInputError("Proforma not found", 404);

      const supplierId = Number(proformaResult.rows[0].supplier_id);
      if (!(await getProfitCheckSupplierScope(supplierId, companyId))) {
        throw new ProfitCheckInputError("Supplier not found", 404);
      }

      const lines = await resolveAndConsolidateItems(client, companyId, supplierId, items);
      await client.query(`DELETE FROM supplier_proforma_lines WHERE proforma_id = $1`, [proformaId]);
      await insertLines(client, proformaId, lines);
      await client.query(`UPDATE supplier_proformas SET updated_at = now() WHERE id = $1 AND company_id = $2`, [
        proformaId,
        companyId,
      ]);
      await client.query("COMMIT");
      res.json({ ok: true });
    } catch (err: unknown) {
      await client.query("ROLLBACK").catch(() => undefined);
      const status = err instanceof ProfitCheckInputError ? err.status : 500;
      if (status === 500) logger.error("[supplier-profit-check/update-items]", { error: getErrorMessage(err) });
      res.status(status).json({ message: getErrorMessage(err) });
    } finally {
      client.release();
    }
  });
}
