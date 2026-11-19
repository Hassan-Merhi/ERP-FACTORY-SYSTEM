// Extracted from ./registerBalesReportRoutesPart2.ts
import { normalizeSearchText } from "@shared/searchNormalization";
import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { getClientDate } from "../../../lib/dateUtils";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";
import { resultRows } from "../../../lib/queryResult";
import { sql } from "drizzle-orm";
import path from "path";
import fs from "fs";

export function registerBalesReportRoutesPart3(app: Express) {
  // ── Stock Entry History: PDF Export ──────────────────────────────────────
  app.get("/api/factory/bales/stock-entry-history/export-pdf", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const userRole = (req.session.currentRole as string) || (req.session.factoryRole as string) || "";
      const isPrivileged = ["Admin", "Owner", "Manager", "Developer"].includes(userRole);

      const { startDate, endDate, workerId, productId, locationId, status, search, includeUnassigned } =
        req.query as Record<string, string>;

      const today = getClientDate(req);
      const effectiveStart = startDate || today;
      const effectiveEnd = endDate || today;

      const workerFilter = workerId ? sql`AND fb.finalized_by = ${parseInt(workerId)}` : sql``;
      const productFilter = productId ? sql`AND fb.product_id = ${parseInt(productId)}` : sql``;
      const locationFilter = locationId ? sql`AND fb.erp_location_id = ${parseInt(locationId)}` : sql``;
      const statusFilter = status ? sql`AND fb.status = ${status}` : sql``;
      const searchFilter = search
        ? sql`AND (
            LOWER(fb.reference_number) LIKE ${"%" + String(search).toLowerCase() + "%"}
            OR regexp_replace(lower(coalesce(fb.reference_number, '')), '[^[:alnum:]]+', '', 'g') LIKE ${"%" + normalizeSearchText(search) + "%"}
          )`
        : sql``;
      const unassignedFilter = includeUnassigned === "false" ? sql`AND fb.finalized_by IS NOT NULL` : sql``;
      const deletedFilter = isPrivileged && search ? sql`` : sql`AND fb.status NOT IN ('DELETED', 'REMOVED')`;
      // Explicit date ranges always constrain reference searches; legacy search
      // without date parameters may still find historical references globally.
      const dateFilter =
        search && !startDate && !endDate
          ? sql``
          : sql`AND fb.stock_entry_date >= ${effectiveStart} AND fb.stock_entry_date <= ${effectiveEnd}`;

      const rows = await db.execute(sql`
        SELECT
          fb.stock_entry_date::text AS "stockEntryDate",
          fb.erp_location_id AS "erpLocationId",
          COALESCE(l.name, 'Unknown') AS "locationName",
          fb.finalized_by AS "workerId",
          fw.full_name AS "workerName",
          fb.product_id AS "productId",
          fbp.name AS "productName",
          fbp.article_code AS "articleCode",
          COUNT(*)::int AS "baleCount",
          ROUND(SUM(CAST(fb.weight_kg AS numeric)), 3) AS "totalWeight",
          ROUND(AVG(CAST(fb.weight_kg AS numeric)), 3) AS "avgWeight",
          MIN(fb.finalized_at) AS "firstFinalizedAt",
          MAX(fb.finalized_at) AS "lastFinalizedAt",
          JSON_AGG(JSON_BUILD_OBJECT(
            'id', fb.id,
            'referenceNumber', fb.reference_number,
            'weightKg', fb.weight_kg,
            'status', fb.status,
            'finalizedAt', fb.finalized_at,
            'stockEntryDate', fb.stock_entry_date::text,
            'locationName', COALESCE(l.name, 'Unknown'),
            'workerName', fw.full_name,
            'productName', fbp.name,
            'articleCode', fbp.article_code
          ) ORDER BY fb.finalized_at ASC) AS "bales"
        FROM factory_bales fb
        LEFT JOIN factory_workers fw ON fb.finalized_by = fw.id AND fw.company_id = ${companyId}
        LEFT JOIN factory_bale_products fbp ON fb.product_id = fbp.id AND fbp.company_id = ${companyId}
        LEFT JOIN locations l ON fb.erp_location_id = l.id AND l.company_id = ${companyId}
        WHERE fb.company_id = ${companyId}
          ${deletedFilter}
          AND fb.stock_entry_date IS NOT NULL
          ${dateFilter}
          ${workerFilter}
          ${productFilter}
          ${locationFilter}
          ${statusFilter}
          ${searchFilter}
          ${unassignedFilter}
        GROUP BY fb.stock_entry_date, fb.erp_location_id, l.name, fb.finalized_by, fw.full_name, fb.product_id, fbp.name, fbp.article_code
        ORDER BY fb.stock_entry_date DESC, l.name NULLS LAST, fw.full_name NULLS LAST, fbp.name NULLS LAST
      `);

      type StockEntryHistoryBaleRow = {
        id: number;
        referenceNumber: string | null;
        weightKg: string | number;
        status: string;
        finalizedAt: string | null;
        stockEntryDate: string | null;
        locationName: string;
        workerName: string | null;
        productName: string | null;
        articleCode: string | null;
      };

      type StockEntryHistoryGroupRow = {
        stockEntryDate: string;
        erpLocationId: number | null;
        locationName: string;
        workerId: number | null;
        workerName: string | null;
        productId: number | null;
        productName: string | null;
        articleCode: string | null;
        baleCount: number;
        totalWeight: string | number;
        avgWeight: string | number;
        firstFinalizedAt: string | Date | null;
        lastFinalizedAt: string | Date | null;
        bales: StockEntryHistoryBaleRow[] | null;
      };

      const groups: StockEntryHistoryGroupRow[] = resultRows<StockEntryHistoryGroupRow>(rows);
      const totalBales = groups.reduce((s: number, g) => s + (g.baleCount || 0), 0);
      const totalWeight = groups.reduce((s: number, g) => s + Number(g.totalWeight || 0), 0);

      const PDFDocument = (await import("pdfkit")).default;
      const doc = new PDFDocument({ margin: 40, size: "A4" });
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="stock-entry-history-${effectiveStart}-to-${effectiveEnd}.pdf"`
      );
      doc.pipe(res);

      const fmtN = (v: string | number | null | undefined, dec = 3) =>
        Number(v || 0).toLocaleString("en-US", { minimumFractionDigits: dec, maximumFractionDigits: dec });
      const NAVY = "#1F3864";
      const STRIPE = "#F8F8F8";
      const GROUP_BG = "#E8ECF4";
      const pageW = 515; // usable width with 40px margin each side

      // ── Logo above header ────────────────────────────────────────────────
      const sehLogoPath = path.join(process.cwd(), "server", "hmd-logo.png");
      if (fs.existsSync(sehLogoPath)) {
        try {
          doc.image(sehLogoPath, (doc.page.width - 200) / 2, 10, { width: 200 });
        } catch {
          // Failure here is non-fatal and the surrounding flow continues deliberately.
        }
      }

      // ── Header bar ──────────────────────────────────────────────────────
      doc.rect(40, 100, pageW, 44).fill(NAVY);
      doc.fillColor("#FFFFFF").font("Helvetica-Bold").fontSize(13).text("Stock Entry History", 44, 105, { width: 340 });
      doc.font("Helvetica").fontSize(8).text("Factory Bales Report", 44, 120, { width: 300 });
      const generatedStr = `Generated: ${new Date().toLocaleDateString("en-GB")}`;
      doc.fontSize(8).text(generatedStr, 400, 120, { width: 155, align: "right" });

      // ── Sub-header: period & summary ─────────────────────────────────────
      const subY = 154;
      doc.fillColor("#000000").font("Helvetica").fontSize(9);
      doc.text(
        search ? "Period: All dates (reference search)" : `Period: ${effectiveStart}  →  ${effectiveEnd}`,
        40,
        subY
      );
      doc
        .font("Helvetica-Bold")
        .text(
          `${groups.length} groups   |   ${totalBales} bales   |   ${fmtN(totalWeight, 2)} kg total`,
          40,
          subY + 13
        );
      if (search)
        doc
          .font("Helvetica")
          .fontSize(8)
          .fillColor("#555555")
          .text(`Search filter: "${search}"`, 40, subY + 26);
      doc.fillColor("#000000");

      // ── Column layout ────────────────────────────────────────────────────
      // Date | Location | Worker | Product | Bales | Total KG | Avg KG
      const colX = [40, 118, 218, 318, 420, 458, 500];
      const colW = [78, 100, 100, 102, 38, 42, 55];
      const colHdr = ["Date", "Location", "Worker", "Product", "Bales", "Total KG", "Avg KG"];
      const colAln: Array<"left" | "right"> = ["left", "left", "left", "left", "right", "right", "right"];

      const tableTop = subY + (search ? 44 : 32);

      // header row
      doc.rect(40, tableTop, pageW, 14).fill(NAVY);
      doc.fillColor("#FFFFFF").font("Helvetica-Bold").fontSize(7.5);
      colHdr.forEach((h, i) => {
        doc.text(h, colX[i] + 2, tableTop + 3, { width: colW[i] - 4, align: colAln[i] });
      });

      doc.fillColor("#000000");
      let y = tableTop + 16;

      for (const g of groups) {
        // page break check — need room for group row + at least one bale row
        if (y > 780) {
          doc.addPage();
          y = 40;
        }

        // group summary row
        doc.rect(40, y, pageW, 14).fill(GROUP_BG);
        doc.fillColor("#000000").font("Helvetica-Bold").fontSize(7.5);
        doc.text(g.stockEntryDate || "—", colX[0] + 2, y + 3, { width: colW[0] - 4 });
        doc.text(g.locationName || "—", colX[1] + 2, y + 3, { width: colW[1] - 4 });
        doc.text(g.workerName || "Unassigned", colX[2] + 2, y + 3, { width: colW[2] - 4 });
        const prodLabel = [g.productName, g.articleCode ? `(${g.articleCode})` : ""].filter(Boolean).join(" ");
        doc.text(prodLabel || "—", colX[3] + 2, y + 3, { width: colW[3] - 4 });
        doc.text(String(g.baleCount || 0), colX[4] + 2, y + 3, { width: colW[4] - 4, align: "right" });
        doc.text(fmtN(g.totalWeight, 3), colX[5] + 2, y + 3, { width: colW[5] - 4, align: "right" });
        doc.text(fmtN(g.avgWeight, 3), colX[6] + 2, y + 3, { width: colW[6] - 4, align: "right" });
        y += 14;

        // bale detail rows
        const bales: StockEntryHistoryBaleRow[] = g.bales || [];
        for (let bi = 0; bi < bales.length; bi++) {
          if (y > 790) {
            doc.addPage();
            y = 40;
          }
          const b = bales[bi];
          if (bi % 2 === 1) {
            doc.rect(40, y, pageW, 12).fill(STRIPE);
            doc.fillColor("#000000");
          }

          // indent indicator stripe on left
          doc.rect(40, y, 3, 12).fill("#9CB2D8");

          doc.font("Helvetica").fontSize(7);
          doc.fillColor("#333333");
          // Reference number in mono-style slot (Date col)
          doc.text(b.referenceNumber || "—", colX[0] + 5, y + 3, { width: colW[0] - 7 });
          // Location (same as group, skip repeat)
          doc.text("", colX[1] + 2, y + 3, { width: colW[1] - 4 });
          // Worker (same as group)
          doc.text("", colX[2] + 2, y + 3, { width: colW[2] - 4 });
          // Status
          doc.text(b.status || "—", colX[3] + 2, y + 3, { width: colW[3] - 4 });
          doc.text("1", colX[4] + 2, y + 3, { width: colW[4] - 4, align: "right" });
          doc.text(fmtN(b.weightKg, 3), colX[5] + 2, y + 3, { width: colW[5] - 4, align: "right" });
          doc.fillColor("#000000");
          y += 12;
        }
      }

      // ── Totals footer ─────────────────────────────────────────────────────
      if (y > 770) {
        doc.addPage();
        y = 40;
      }
      y += 4;
      doc.moveTo(40, y).lineTo(555, y).lineWidth(0.5).strokeColor("#888888").stroke();
      y += 5;
      doc.rect(40, y, pageW, 16).fill(NAVY);
      doc.fillColor("#FFFFFF").font("Helvetica-Bold").fontSize(8);
      doc.text("TOTAL", colX[0] + 2, y + 4, { width: 200 });
      doc.text(String(totalBales), colX[4] + 2, y + 4, { width: colW[4] - 4, align: "right" });
      doc.text(fmtN(totalWeight, 3), colX[5] + 2, y + 4, { width: colW[5] - 4, align: "right" });

      doc.end();
    } catch (error: unknown) {
      logger.error("Error exporting stock entry history PDF:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
