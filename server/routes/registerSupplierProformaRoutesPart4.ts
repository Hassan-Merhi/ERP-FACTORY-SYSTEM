// Extracted from ./registerSupplierProformaRoutesPart1.ts
import { parseId } from "../lib/parseId";
import { getErrorMessage } from "../lib/httpHandlers";
import { logAudit } from "./_helpers";
import { Express, type Request, type RequestHandler, type Response } from "express";
import { db, type DbTransaction } from "../db";
import { and, eq, sql } from "drizzle-orm";
import { buildAliasMap, resolveBarcode } from "./helpers/proformaBarcodeHelpers";
import { supplierProformaLines, supplierProformas } from "@shared/schema";
import { parseMoneyInput } from "../lib/money";
import { z } from "zod";
import { emptyQuery, stringParam, validateRequest, type RequestSchemas } from "../lib/validateRequest";

const lineValue = z.union([z.string(), z.number()]).nullable().optional();

// Ids stay strings: the handler parses them with parseId and answers its own 400s.
// Line values go through String()/parseInt()/sanitizeDecimal().
const createProformaInput = {
  params: z.strictObject({ supplierId: stringParam }),
  query: emptyQuery,
  body: z.strictObject({
    reference: z.string().nullable().optional(),
    notes: z.string().nullable().optional(),
    destinationCompanyId: z.union([z.number(), z.string()]).nullable().optional(),
    lines: z
      .array(
        z.strictObject({
          barcode: lineValue,
          itemName: lineValue,
          qty: lineValue,
          weightPerBale: lineValue,
          pricePerBale: lineValue,
        })
      )
      .nullable()
      .optional(),
  }),
} satisfies RequestSchemas;

/**
 * Parse a human-entered decimal value from Excel into a PostgreSQL-safe decimal string.
 * Accepts: optional leading sign, digit groups separated by commas (thousands), optional
 * decimal point with fractional digits, optional currency prefix/suffix, and surrounding
 * whitespace.  Everything else (text, "N/A", scientific notation, etc.) returns "0".
 */
function sanitizeDecimal(v: unknown): string {
  const raw = String(v ?? "").trim();
  // Strip leading/trailing currency symbols and whitespace
  const leading = raw.replace(/^[^0-9\-(]+/, "");
  // Trailing currency text is trimmed with a scan, not an end-anchored regex,
  // so a long non-numeric tail cannot make the match quadratic.
  let end = leading.length;
  while (end > 0 && !/[0-9.]/.test(leading[end - 1])) end -= 1;
  const stripped = leading.slice(0, end);
  // Remove thousands commas: only valid when pattern is NNN,NNN,...
  const noCommas = stripped.replace(/,(?=\d{3}(?:[,.]|$))/g, "");
  // Must match: optional minus, digits, optional .digits — nothing else
  if (!/^-?\d+(\.\d+)?$/.test(noCommas)) return "0";
  const n = parseMoneyInput(noCommas)?.toNumber() ?? NaN;
  if (!isFinite(n)) return "0";
  return n.toFixed(6).replace(/\.?0+$/, "") || "0";
}

/**
 * Insert proforma lines in chunks inside a single transaction so partial imports
 * never leave orphan rows when a later chunk fails.
 */
async function batchInsertProformaLines(
  rows: {
    proformaId: number;
    barcode: string;
    itemName: string;
    qty: number;
    weightPerBale: string;
    pricePerBale: string;
  }[],
  tx: DbTransaction
) {
  // Each row has 6 columns → 6 params; PostgreSQL limit is 65535.
  // 200 rows × 6 = 1200 params — well within limits.
  const CHUNK = 200;
  for (let i = 0; i < rows.length; i += CHUNK) {
    await tx.insert(supplierProformaLines).values(rows.slice(i, i + CHUNK));
  }
}

export function registerSupplierProformaRoutesPart4(app: Express, requireAuth: RequestHandler) {
  app.get("/api/suppliers/:supplierId/proformas", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const supplierId = parseId(req.params.supplierId);
      if (supplierId === null) return res.status(400).json({ message: "Invalid id" });
      const proformas = await db
        .select()
        .from(supplierProformas)
        .where(
          and(
            eq(supplierProformas.supplierId, supplierId),
            sql`(${supplierProformas.companyId} = ${companyId} OR (${supplierProformas.destinationCompanyId} = ${companyId} AND EXISTS (SELECT 1 FROM companies child WHERE child.id = ${companyId} AND child.parent_company_id = ${supplierProformas.companyId})))`
          )
        );
      res.json(proformas);
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.get("/api/suppliers/:supplierId/proformas/:proformaId", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const proformaId = parseId(req.params.proformaId);
      if (proformaId === null) return res.status(400).json({ message: "Invalid id" });
      const [proforma] = await db
        .select()
        .from(supplierProformas)
        .where(
          and(
            eq(supplierProformas.id, proformaId),
            sql`(${supplierProformas.companyId} = ${companyId} OR (${supplierProformas.destinationCompanyId} = ${companyId} AND EXISTS (SELECT 1 FROM companies child WHERE child.id = ${companyId} AND child.parent_company_id = ${supplierProformas.companyId})))`
          )
        );
      if (!proforma) return res.status(404).json({ message: "Proforma not found" });
      const lines = await db
        .select()
        .from(supplierProformaLines)
        .where(eq(supplierProformaLines.proformaId, proformaId));
      res.json({ ...proforma, lines });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.post(
    "/api/suppliers/:supplierId/proformas",
    requireAuth,
    validateRequest(createProformaInput),
    async (req: Request, res: Response) => {
      try {
        const companyId = req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });
        const supplierId = parseId(req.params.supplierId);
        if (supplierId === null) return res.status(400).json({ message: "Invalid id" });
        const { reference, notes, lines, destinationCompanyId } = req.body;
        const destinationId = destinationCompanyId == null ? companyId : parseId(String(destinationCompanyId));
        if (destinationId === null) return res.status(400).json({ message: "Invalid destination company" });
        const destinationAllowed = await db.execute(sql`
        SELECT 1 FROM companies destination JOIN companies owner ON owner.id = ${companyId}
        WHERE destination.id = ${destinationId}
          AND (destination.id = owner.id OR destination.parent_company_id = owner.id)
        LIMIT 1
      `);
        if (!destinationAllowed.rows.length)
          return res.status(403).json({ message: "Destination must be this company or its linked child company" });
        // The proforma record belongs to the active company, but a child company
        // may create one for a supplier master owned by its explicitly linked
        // parent. Keep the boundary strict: active company + parent_company_id
        // only, never the legacy/global parent setting or an unrelated company.
        const supplierCheck = await db.execute(sql`
        SELECT s.id
        FROM suppliers s
        JOIN companies active_company ON active_company.id = ${companyId}
        WHERE s.id = ${supplierId}
          AND s.deleted_at IS NULL
          AND (
            s.company_id = ${companyId}
            OR s.company_id = active_company.parent_company_id
          )
        LIMIT 1
      `);
        if (supplierCheck.rows.length === 0) return res.status(404).json({ message: "Supplier not found" });

        // Resolve alias codes to primary stock-item codes so that proforma lines
        // are always stored with the canonical code regardless of what code the
        // supplier's packing-list used.
        const aliasMap =
          lines && Array.isArray(lines) && lines.length > 0 ? (await buildAliasMap(companyId)).map : null;
        // Phase 21 (B): the proforma, its lines and the create audit commit together.
        const proforma = await db.transaction(async (tx) => {
          const [created] = await tx
            .insert(supplierProformas)
            .values({
              companyId,
              supplierId,
              destinationCompanyId: destinationId,
              reference: reference || "Untitled",
              notes: notes || null,
            })
            .returning();
          if (aliasMap && Array.isArray(lines)) {
            const lineValues = lines.map((l) => ({
              proformaId: created.id,
              barcode: resolveBarcode(String(l.barcode || "").trim(), aliasMap),
              itemName: String(l.itemName || "").trim(),
              qty: parseInt(l.qty) || 0,
              weightPerBale: sanitizeDecimal(l.weightPerBale),
              pricePerBale: sanitizeDecimal(l.pricePerBale),
            }));
            await batchInsertProformaLines(lineValues, tx);
          }
          await logAudit(
            {
              userId: req.session.userId!,
              username: req.session.username || "unknown",
              companyId,
              action: "create",
              tableName: "supplier_proformas",
              recordId: created.id,
              recordIdentifier: created.reference || `Proforma#${created.id}`,
              changes: { supplierId: { old: null, new: supplierId }, reference: { old: null, new: created.reference } },
            },
            tx
          );
          return created;
        });
        const allLines = await db
          .select()
          .from(supplierProformaLines)
          .where(eq(supplierProformaLines.proformaId, proforma.id));
        res.json({ ...proforma, lines: allLines });
      } catch (error: unknown) {
        res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );
}
