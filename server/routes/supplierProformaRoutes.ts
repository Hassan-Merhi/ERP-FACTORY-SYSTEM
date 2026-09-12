import { parseId } from "../lib/parseId";
import { getErrorMessage } from "../lib/httpHandlers";
import { logger } from "../lib/logger";
import { logAudit } from "./_helpers";
import { Express } from "express";
import type { Request, Response, RequestHandler } from "express";
import { db } from "../db";
import { eq, and, ne, sql } from "drizzle-orm";
import ExcelJS from "exceljs";
import { buildAliasMap, resolveBarcode } from "./helpers/proformaBarcodeHelpers";
import { registerContainerLoadedItemsRoutes } from "./container-loaded-items";
import { importSupplierProformaLines } from "./helpers/supplierProformaImport";
import { supplierProformas, supplierProformaLines, suppliers } from "@shared/schema";

/**
 * Parse a human-entered decimal value from Excel into a PostgreSQL-safe decimal string.
 * Accepts: optional leading sign, digit groups separated by commas (thousands), optional
 * decimal point with fractional digits, optional currency prefix/suffix, and surrounding
 * whitespace.  Everything else (text, "N/A", scientific notation, etc.) returns "0".
 */
function sanitizeDecimal(v: unknown): string {
  const raw = String(v ?? "").trim();
  // Strip leading/trailing currency symbols and whitespace
  const stripped = raw.replace(/^[^0-9\-(]+/, "").replace(/[^0-9.]+$/, "");
  // Remove thousands commas: only valid when pattern is NNN,NNN,...
  const noCommas = stripped.replace(/,(?=\d{3}(?:[,.]|$))/g, "");
  // Must match: optional minus, digits, optional .digits — nothing else
  if (!/^-?\d+(\.\d+)?$/.test(noCommas)) return "0";
  const n = parseFloat(noCommas);
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
  }[]
) {
  // Each row has 6 columns → 6 params; PostgreSQL limit is 65535.
  // 200 rows × 6 = 1200 params — well within limits.
  const CHUNK = 200;
  await db.transaction(async (tx) => {
    for (let i = 0; i < rows.length; i += CHUNK) {
      await tx.insert(supplierProformaLines).values(rows.slice(i, i + CHUNK));
    }
  });
}

export function registerSupplierProformaRoutes(app: Express, requireAuth: RequestHandler) {
  app.get("/api/suppliers/:supplierId/proformas", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const supplierId = parseId(req.params.supplierId);
      if (supplierId === null) return res.status(400).json({ message: "Invalid id" });
      const proformas = await db
        .select()
        .from(supplierProformas)
        .where(and(eq(supplierProformas.companyId, companyId), eq(supplierProformas.supplierId, supplierId)));
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
        .where(and(eq(supplierProformas.id, proformaId), eq(supplierProformas.companyId, companyId)));
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
      const { reference, notes, lines } = req.body;

      // The insert took supplierId straight from the URL, so an unknown
      // supplier failed the foreign key and surfaced as a 500 rather than a
      // 404 for the missing parent. Scoped to the active company because
      // suppliers.company_id is NOT NULL and backfilled to the owning company
      // by 20260728_001_supplier_company_scope; raw SQL because that column is
      // not part of the drizzle suppliers table.
      const supplierCheck = await db.execute(
        sql`SELECT id FROM suppliers WHERE id = ${supplierId} AND company_id = ${companyId} LIMIT 1`
      );
      if (supplierCheck.rows.length === 0) return res.status(404).json({ message: "Supplier not found" });

      const [proforma] = await db
        .insert(supplierProformas)
        .values({
          companyId,
          supplierId,
          reference: reference || "Untitled",
          notes: notes || null,
        })
        .returning();
      if (lines && Array.isArray(lines) && lines.length > 0) {
        // Resolve alias codes to primary stock-item codes so that proforma lines
        // are always stored with the canonical code regardless of what code the
        // supplier's packing-list used.
        const { map: aliasMap } = await buildAliasMap(companyId);
        const lineValues = lines.map((l) => ({
          proformaId: proforma.id,
          barcode: resolveBarcode(String(l.barcode || "").trim(), aliasMap),
          itemName: String(l.itemName || "").trim(),
          qty: parseInt(l.qty) || 0,
          weightPerBale: sanitizeDecimal(l.weightPerBale),
          pricePerBale: sanitizeDecimal(l.pricePerBale),
        }));
        await batchInsertProformaLines(lineValues);
      }
      const allLines = await db
        .select()
        .from(supplierProformaLines)
        .where(eq(supplierProformaLines.proformaId, proforma.id));
      await logAudit({
        userId: req.session.userId!,
        username: req.session.username || "unknown",
        companyId,
        action: "create",
        tableName: "supplier_proformas",
        recordId: proforma.id,
        recordIdentifier: proforma.reference || `Proforma#${proforma.id}`,
        changes: { supplierId: { old: null, new: supplierId }, reference: { old: null, new: proforma.reference } },
      });
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
      const { reference, notes } = req.body;
      const updates: Partial<typeof supplierProformas.$inferInsert> = { updatedAt: new Date() };
      if (reference !== undefined) updates.reference = reference;
      if (notes !== undefined) updates.notes = notes;
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
      await db.delete(supplierProformaLines).where(eq(supplierProformaLines.proformaId, proformaId));
      await db
        .delete(supplierProformas)
        .where(and(eq(supplierProformas.id, proformaId), eq(supplierProformas.companyId, companyId)));
      await logAudit({
        userId: req.session.userId!,
        username: req.session.username || "unknown",
        companyId,
        action: "delete",
        tableName: "supplier_proformas",
        recordId: proformaId,
        recordIdentifier: `Proforma#${proformaId}`,
        changes: { deleted: { old: false, new: true } },
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

  // ── Pretty Excel export for a single proforma ──────────────────────────────
  app.get(
    "/api/suppliers/:supplierId/proformas/:proformaId/export-excel",
    requireAuth,
    async (req: Request, res: Response) => {
      try {
        const companyId = req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });
        const proformaId = parseId(req.params.proformaId);
        const sid = parseId(req.params.supplierId);
        if (!proformaId || !sid) return res.status(400).json({ message: "Invalid id" });

        const [proforma] = await db
          .select()
          .from(supplierProformas)
          .where(and(eq(supplierProformas.id, proformaId), eq(supplierProformas.companyId, companyId)));
        if (!proforma) return res.status(404).json({ message: "Proforma not found" });

        const lines = await db
          .select()
          .from(supplierProformaLines)
          .where(eq(supplierProformaLines.proformaId, proformaId));
        const [supplier] = await db.select().from(suppliers).where(eq(suppliers.id, sid));

        // ── Workbook ───────────────────────────────────────────────────────────
        const wb = new ExcelJS.Workbook();
        wb.creator = "HMD ERP";
        wb.created = new Date();

        const ws = wb.addWorksheet("Proforma", {
          pageSetup: { paperSize: 9, orientation: "portrait", fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
        });

        // 8 columns: #, Barcode, Item Name, Qty, Weight/Bale, Price/Bale, Total Weight, Total Value
        const NUM_COLS = 8;
        ws.columns = [
          { width: 5 }, // #
          { width: 16 }, // Barcode
          { width: 34 }, // Item Name
          { width: 10 }, // Qty
          { width: 14 }, // Weight/Bale (kg)
          { width: 14 }, // Price/Bale
          { width: 16 }, // Total Weight
          { width: 16 }, // Total Value
        ];

        // Colour palette
        const C = {
          navy: "FF0D1F3C",
          blue: "FF1A4A8A",
          blueMid: "FF2563B0",
          headerText: "FFFFFFFF",
          altRow: "FFD6E4F7",
          whiteRow: "FFFFFFFF",
          totalBg: "FF0F3422",
          totalText: "FFFFFFFF",
          subtleBg: "FFEEF4FC",
          notesBg: "FFFFF8E6",
          colLabel: "FFBBCFE8",
          borderCol: "FFB0C4DE",
        };

        const thin = (c = C.borderCol) => ({ style: "thin" as const, color: { argb: c } });
        const medium = (c = C.navy) => ({ style: "medium" as const, color: { argb: c } });
        const allBorder = (t = thin(), m?: ReturnType<typeof thin>) => ({
          top: m ?? t,
          bottom: m ?? t,
          left: t,
          right: t,
        });

        // ── Row 1 — title banner ───────────────────────────────────────────────
        ws.mergeCells(1, 1, 1, NUM_COLS);
        const r1 = ws.getRow(1);
        r1.height = 40;
        const t1 = ws.getCell("A1");
        t1.value = "SUPPLIER PROFORMA";
        t1.font = { bold: true, size: 18, color: { argb: C.headerText }, name: "Calibri" };
        t1.fill = { type: "pattern", pattern: "solid", fgColor: { argb: C.navy } };
        t1.alignment = { horizontal: "center", vertical: "middle" };

        // ── Row 2 — supplier | reference ──────────────────────────────────────
        ws.mergeCells(2, 1, 2, 4);
        ws.mergeCells(2, 5, 2, NUM_COLS);
        ws.getRow(2).height = 24;
        const suppCell = ws.getCell(2, 1);
        suppCell.value = `Supplier: ${supplier?.legalName || `#${sid}`}`;
        suppCell.font = { bold: true, size: 11, color: { argb: C.navy } };
        suppCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: C.subtleBg } };
        suppCell.alignment = { vertical: "middle", indent: 1 };
        const refCell = ws.getCell(2, 5);
        refCell.value = `Reference: ${proforma.reference}`;
        refCell.font = { bold: true, size: 11, color: { argb: C.navy } };
        refCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: C.subtleBg } };
        refCell.alignment = { horizontal: "right", vertical: "middle", indent: 1 };

        // ── Row 3 — date | item count ─────────────────────────────────────────
        ws.mergeCells(3, 1, 3, 4);
        ws.mergeCells(3, 5, 3, NUM_COLS);
        ws.getRow(3).height = 18;
        const dateStr = new Date(proforma.createdAt).toLocaleDateString("en-GB", {
          day: "2-digit",
          month: "long",
          year: "numeric",
        });
        const dateCell = ws.getCell(3, 1);
        dateCell.value = `Date: ${dateStr}`;
        dateCell.font = { size: 9, italic: true, color: { argb: "FF555566" } };
        dateCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF4F8FE" } };
        dateCell.alignment = { vertical: "middle", indent: 1 };
        const cntCell = ws.getCell(3, 5);
        cntCell.value = `${lines.length} line items`;
        cntCell.font = { size: 9, italic: true, color: { argb: "FF555566" } };
        cntCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF4F8FE" } };
        cntCell.alignment = { horizontal: "right", vertical: "middle", indent: 1 };

        // ── Row 4 — notes (optional) ──────────────────────────────────────────
        let nextRowIdx = 4;
        if (proforma.notes) {
          ws.mergeCells(4, 1, 4, NUM_COLS);
          ws.getRow(4).height = 18;
          const nc = ws.getCell(4, 1);
          nc.value = `Notes: ${proforma.notes}`;
          nc.font = { size: 9, italic: true, color: { argb: "FF444444" } };
          nc.fill = { type: "pattern", pattern: "solid", fgColor: { argb: C.notesBg } };
          nc.alignment = { vertical: "middle", indent: 1, wrapText: true };
          nextRowIdx = 5;
        }

        // ── Blank spacer ──────────────────────────────────────────────────────
        ws.getRow(nextRowIdx).height = 8;
        nextRowIdx++;

        // ── Column header row ─────────────────────────────────────────────────
        const hdrRowNum = nextRowIdx;
        const headers = [
          "#",
          "Barcode",
          "Item Name",
          "Qty",
          "Wt / Bale (kg)",
          "Price / Bale",
          "Total Weight",
          "Total Value",
        ];
        const hdrRow = ws.getRow(hdrRowNum);
        hdrRow.values = headers;
        hdrRow.height = 30;
        hdrRow.eachCell((cell, col: number) => {
          cell.font = { bold: true, size: 10, color: { argb: C.headerText } };
          cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: C.blueMid } };
          cell.alignment = {
            horizontal: col <= 3 ? "left" : "right",
            vertical: "middle",
            indent: col === 1 ? 0 : 1,
          };
          cell.border = {
            top: medium(),
            bottom: medium(),
            left: thin(),
            right: thin(),
          };
        });
        nextRowIdx++;

        // ── Data rows ─────────────────────────────────────────────────────────
        let totQty = 0,
          totWeightKg = 0,
          totValue = 0;

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          const qty = Number(line.qty) || 0;
          const wt = parseFloat(line.weightPerBale || "0");
          const price = parseFloat(line.pricePerBale || "0");
          const lineWt = qty * wt;
          const lineVal = qty * price;
          totQty += qty;
          totWeightKg += lineWt;
          totValue += lineVal;

          const row = ws.getRow(nextRowIdx);
          row.values = [i + 1, line.barcode, line.itemName, qty, wt, price, lineWt, lineVal];
          row.height = 20;

          const isAlt = i % 2 === 1;
          const rowBg = isAlt ? C.altRow : C.whiteRow;

          row.eachCell((cell, col: number) => {
            cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: rowBg } };
            cell.border = allBorder();
            cell.alignment = {
              horizontal: col <= 3 ? "left" : "right",
              vertical: "middle",
              indent: col === 1 ? 0 : 1,
            };
            if (col === 1) {
              cell.font = { size: 9, color: { argb: "FF8899AA" } };
              cell.alignment = { horizontal: "center", vertical: "middle" };
            }
            if (col === 2) {
              cell.font = { name: "Courier New", size: 9 };
            }
            if (col === 4) cell.numFmt = "#,##0";
            if (col === 5) cell.numFmt = "#,##0.##";
            if (col === 6) cell.numFmt = "#,##0.00";
            if (col === 7) cell.numFmt = "#,##0.##";
            if (col === 8) cell.numFmt = "#,##0.00";
          });

          nextRowIdx++;
        }

        // ── Total row ─────────────────────────────────────────────────────────
        const totalRow = ws.getRow(nextRowIdx);
        totalRow.values = ["", "", "TOTAL", totQty, "", "", totWeightKg, totValue];
        totalRow.height = 28;
        totalRow.eachCell((cell, col: number) => {
          cell.font = { bold: true, size: 11, color: { argb: C.totalText } };
          cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: C.totalBg } };
          cell.border = { top: medium(), bottom: medium(), left: thin(), right: thin() };
          cell.alignment = {
            horizontal: col <= 3 ? (col === 3 ? "left" : "center") : "right",
            vertical: "middle",
            indent: col === 3 ? 1 : 0,
          };
          if (col === 4) cell.numFmt = "#,##0";
          if (col === 7) cell.numFmt = "#,##0.##";
          if (col === 8) cell.numFmt = "#,##0.00";
        });

        // ── Autofilter + freeze ────────────────────────────────────────────────
        ws.autoFilter = { from: { row: hdrRowNum, column: 1 }, to: { row: hdrRowNum, column: NUM_COLS } };
        ws.views = [{ state: "frozen", xSplit: 0, ySplit: hdrRowNum }];

        // ── Send ──────────────────────────────────────────────────────────────
        const safeRef = (proforma.reference || "proforma").replace(/[^a-zA-Z0-9 \-_]/g, "").trim();
        res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
        res.setHeader("Content-Disposition", `attachment; filename="${safeRef}.xlsx"`);
        const buf = Buffer.from(await wb.xlsx.writeBuffer());
        res.end(buf);
      } catch (error: unknown) {
        logger.error("Proforma export error:", { error: error });
        res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );

  // ── Star / unstar a proforma ──────────────────────────────────────────────
  // PATCH /api/suppliers/:supplierId/proformas/:proformaId/star
  // Toggles the starred state. Only one proforma per supplier+company can be
  // starred at a time — starring a new one automatically unstarches the old one.
  app.patch(
    "/api/suppliers/:supplierId/proformas/:proformaId/star",
    requireAuth,
    async (req: Request, res: Response) => {
      try {
        const companyId = req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });
        const supplierId = parseId(req.params.supplierId);
        const proformaId = parseId(req.params.proformaId);
        if (supplierId === null || proformaId === null) return res.status(400).json({ message: "Invalid id" });

        const [current] = await db
          .select({ id: supplierProformas.id, isStarred: supplierProformas.isStarred })
          .from(supplierProformas)
          .where(and(eq(supplierProformas.id, proformaId), eq(supplierProformas.companyId, companyId)));
        if (!current) return res.status(404).json({ message: "Proforma not found" });

        const newStarred = !current.isStarred;

        if (newStarred) {
          // Unstar all other proformas for this supplier+company first
          await db
            .update(supplierProformas)
            .set({ isStarred: false })
            .where(
              and(
                eq(supplierProformas.companyId, companyId),
                eq(supplierProformas.supplierId, supplierId),
                ne(supplierProformas.id, proformaId)
              )
            );
        }

        const [updated] = await db
          .update(supplierProformas)
          .set({ isStarred: newStarred })
          .where(eq(supplierProformas.id, proformaId))
          .returning();

        res.json(updated);
      } catch (error: unknown) {
        res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );
}
