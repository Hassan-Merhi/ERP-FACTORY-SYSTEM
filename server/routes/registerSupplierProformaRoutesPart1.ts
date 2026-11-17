// Extracted from ./supplierProformaRoutes.ts to keep that module under the source-size cap.
import { parseId } from "../lib/parseId";
import { getErrorMessage } from "../lib/httpHandlers";
import { logAudit } from "./_helpers";
import { Express, type Request, type RequestHandler, type Response } from "express";
import { db, type DbTransaction } from "../db";
import { and, eq, sql } from "drizzle-orm";
import { buildAliasMap, resolveBarcode } from "./helpers/proformaBarcodeHelpers";
import { registerContainerLoadedItemsRoutes } from "./container-loaded-items";
import { importSupplierProformaLines } from "./helpers/supplierProformaImport";
import { supplierProformaLines, supplierProformas } from "@shared/schema";
import { parseMoneyInput } from "../lib/money";

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

export function registerSupplierProformaRoutesPart1(app: Express, requireAuth: RequestHandler) {
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

  app.post("/api/suppliers/:supplierId/proformas", requireAuth, async (req: Request, res: Response) => {
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
      const aliasMap = lines && Array.isArray(lines) && lines.length > 0 ? (await buildAliasMap(companyId)).map : null;
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
  });

  app.patch("/api/suppliers/:supplierId/proformas/:proformaId", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const proformaId = parseId(req.params.proformaId);
      if (proformaId === null) return res.status(400).json({ message: "Invalid id" });
      const { reference, notes, destinationCompanyId } = req.body;
      if (destinationCompanyId !== undefined) {
        const destinationId = parseId(String(destinationCompanyId));
        if (destinationId === null) return res.status(400).json({ message: "Invalid destination company" });
        const allowed = await db.execute(
          sql`SELECT 1 FROM companies WHERE id = ${destinationId} AND (id = ${companyId} OR parent_company_id = ${companyId}) LIMIT 1`
        );
        if (!allowed.rows.length) return res.status(403).json({ message: "Destination not linked to company" });
        const [existing] = await db
          .select()
          .from(supplierProformas)
          .where(and(eq(supplierProformas.id, proformaId), eq(supplierProformas.companyId, companyId)));
        if (existing?.isStarred && (existing.destinationCompanyId ?? companyId) !== destinationId)
          return res.status(409).json({ message: "Unstar this proforma before changing its destination" });
      }
      const updates: Partial<typeof supplierProformas.$inferInsert> = { updatedAt: new Date() };
      if (reference !== undefined) updates.reference = reference;
      if (notes !== undefined) updates.notes = notes;
      if (destinationCompanyId !== undefined) updates.destinationCompanyId = Number(destinationCompanyId);
      const [updated] = await db
        .update(supplierProformas)
        .set(updates)
        .where(and(eq(supplierProformas.id, proformaId), eq(supplierProformas.companyId, companyId)))
        .returning();
      if (!updated) return res.status(404).json({ message: "Proforma not found" });
      res.json(updated);
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.delete("/api/suppliers/:supplierId/proformas/:proformaId", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const proformaId = parseId(req.params.proformaId);
      if (proformaId === null) return res.status(400).json({ message: "Invalid id" });
      // Lines are removed only once the proforma is confirmed to belong to the
      // company; they used to be deleted first, for any proforma id.
      const [owned] = await db
        .select({ id: supplierProformas.id })
        .from(supplierProformas)
        .where(and(eq(supplierProformas.id, proformaId), eq(supplierProformas.companyId, companyId)));
      if (!owned) return res.status(404).json({ message: "Proforma not found" });
      // Phase 21 (B): the delete and its audit commit together.
      await db.transaction(async (tx) => {
        await tx.delete(supplierProformaLines).where(eq(supplierProformaLines.proformaId, proformaId));
        await tx
          .delete(supplierProformas)
          .where(and(eq(supplierProformas.id, proformaId), eq(supplierProformas.companyId, companyId)));
        await logAudit(
          {
            userId: req.session.userId!,
            username: req.session.username || "unknown",
            companyId,
            action: "delete",
            tableName: "supplier_proformas",
            recordId: proformaId,
            recordIdentifier: `Proforma#${proformaId}`,
            changes: { deleted: { old: false, new: true } },
          },
          tx
        );
      });
      res.json({ success: true });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.post(
    "/api/suppliers/:supplierId/proformas/:proformaId/lines",
    requireAuth,
    async (req: Request, res: Response) => {
      try {
        const companyId = req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });
        const proformaId = parseId(req.params.proformaId);
        if (proformaId === null) return res.status(400).json({ message: "Invalid id" });
        const [proforma] = await db
          .select()
          .from(supplierProformas)
          .where(and(eq(supplierProformas.id, proformaId), eq(supplierProformas.companyId, companyId)));
        if (!proforma) return res.status(403).json({ message: "Access denied" });
        const { barcode, itemName, qty, weightPerBale, pricePerBale } = req.body;
        const [line] = await db
          .insert(supplierProformaLines)
          .values({
            proformaId,
            barcode: barcode || "",
            itemName: itemName || "",
            qty: parseInt(qty) || 0,
            weightPerBale: weightPerBale || "0",
            pricePerBale: pricePerBale || "0",
          })
          .returning();
        await db.update(supplierProformas).set({ updatedAt: new Date() }).where(eq(supplierProformas.id, proformaId));
        res.json(line);
      } catch (error: unknown) {
        res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );

  app.patch("/api/supplier-proforma-lines/:lineId", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const lineId = parseId(req.params.lineId);
      if (lineId === null) return res.status(400).json({ message: "Invalid id" });
      const [line] = await db.select().from(supplierProformaLines).where(eq(supplierProformaLines.id, lineId));
      if (!line) return res.status(404).json({ message: "Line not found" });
      const [proforma] = await db
        .select()
        .from(supplierProformas)
        .where(and(eq(supplierProformas.id, line.proformaId), eq(supplierProformas.companyId, companyId)));
      if (!proforma) return res.status(403).json({ message: "Access denied" });
      const updates: Partial<typeof supplierProformaLines.$inferInsert> = {};
      if (req.body.barcode !== undefined) updates.barcode = req.body.barcode;
      if (req.body.itemName !== undefined) updates.itemName = req.body.itemName;
      if (req.body.qty !== undefined) updates.qty = parseInt(req.body.qty) || 0;
      if (req.body.weightPerBale !== undefined) updates.weightPerBale = req.body.weightPerBale;
      if (req.body.pricePerBale !== undefined) updates.pricePerBale = req.body.pricePerBale;
      const [updated] = await db
        .update(supplierProformaLines)
        .set(updates)
        .where(eq(supplierProformaLines.id, lineId))
        .returning();
      await db.update(supplierProformas).set({ updatedAt: new Date() }).where(eq(supplierProformas.id, proforma.id));
      res.json(updated);
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.delete("/api/supplier-proforma-lines/:lineId", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const lineId = parseId(req.params.lineId);
      if (lineId === null) return res.status(400).json({ message: "Invalid id" });
      const [line] = await db.select().from(supplierProformaLines).where(eq(supplierProformaLines.id, lineId));
      if (!line) return res.status(404).json({ message: "Line not found" });
      const [proforma] = await db
        .select()
        .from(supplierProformas)
        .where(and(eq(supplierProformas.id, line.proformaId), eq(supplierProformas.companyId, companyId)));
      if (!proforma) return res.status(403).json({ message: "Access denied" });
      await db.delete(supplierProformaLines).where(eq(supplierProformaLines.id, lineId));
      await db.update(supplierProformas).set({ updatedAt: new Date() }).where(eq(supplierProformas.id, proforma.id));
      res.json({ success: true });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.post(
    "/api/suppliers/:supplierId/proformas/:proformaId/import-lines",
    requireAuth,
    async (req: Request, res: Response) => {
      await importSupplierProformaLines(req, res);
    }
  );

  registerContainerLoadedItemsRoutes(app, requireAuth);
}
