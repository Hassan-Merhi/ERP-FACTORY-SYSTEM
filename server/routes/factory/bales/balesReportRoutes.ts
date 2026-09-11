/**
 * factoryBalesRoutes: BalesReport endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { parseOptionalId } from "../../../lib/parseId";
import { getClientDate } from "../../../lib/dateUtils";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";
import { resultRows } from "../../../lib/queryResult";

import { factoryRawStock, factoryMixBatches, factoryBales, baleLabelPrints } from "@shared/schema";
import { eq, and, or, sql, inArray, not } from "drizzle-orm";
import path from "path";
import fs from "fs";

import { _getKpiCached, _setKpiCached } from "./_helpers";

export function registerBalesReportRoutes(app: Express) {
  // Lightweight daily summary — counts and weights by category for a single date.
  // Much faster than the full /api/factory/bales endpoint which returns up to 2000 rows.
  app.get("/api/factory/bales/daily-summary", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const { date } = req.query as Record<string, string>;
      if (!date) return res.status(400).json({ message: "date is required (YYYY-MM-DD)" });

      const rows = await db.execute(sql`
        SELECT
          LOWER(TRIM(COALESCE(category, ''))) AS "category",
          COUNT(*)::int                        AS "count",
          ROUND(COALESCE(SUM(CAST(weight_kg AS numeric)), 0), 3)::text AS "totalKg"
        FROM factory_bales
        WHERE company_id = ${companyId}
          AND stock_entry_date::text = ${date}
          AND status NOT IN ('DELETED', 'REMOVED')
        GROUP BY LOWER(TRIM(COALESCE(category, '')))
      `);

      res.json(rows.rows ?? rows);
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.get("/api/factory/bales/stock-entry-history", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const userRole = (req.session.currentRole as string) || (req.session.factoryRole as string) || "";
      const isPrivileged = ["Admin", "Owner", "Manager", "Developer"].includes(userRole);

      const {
        startDate,
        endDate,
        workerId,
        productId,
        locationId,
        categoryId,
        status,
        search,
        includeUnassigned,
        lite,
      } = req.query as Record<string, string>;

      const today = getClientDate(req);
      const effectiveStart = startDate || today;
      const effectiveEnd = endDate || today;

      // Pagination — page ≥ 1, limit 1–250 (default 100)
      const rawPage = parseInt(String(req.query.page ?? ""), 10);
      const rawLimit = parseInt(String(req.query.limit ?? ""), 10);
      const page = Number.isFinite(rawPage) && rawPage > 0 ? rawPage : 1;
      const limit = Math.min(Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : 100, 250);
      const offset = (page - 1) * limit;

      const workerFilter = workerId ? sql`AND fb.finalized_by = ${parseInt(workerId)}` : sql``;
      const productFilter = productId ? sql`AND fb.product_id = ${parseInt(productId)}` : sql``;
      const locationFilter = locationId ? sql`AND fb.erp_location_id = ${parseInt(locationId)}` : sql``;
      // categoryId may be comma-separated for multi-select; build an IN(...) clause
      const categoryIds2 = categoryId
        ? categoryId
            .split(",")
            .map((s: string) => parseInt(s, 10))
            .filter((n: number) => Number.isFinite(n) && n > 0)
        : [];
      const categoryFilter2 =
        categoryIds2.length === 1
          ? sql`AND fbp.category_id = ${categoryIds2[0]}`
          : categoryIds2.length > 1
            ? sql`AND fbp.category_id = ANY(${categoryIds2}::int[])`
            : sql``;
      const statusFilter = status ? sql`AND fb.status = ${status}` : sql``;
      const searchFilter = search
        ? sql`AND LOWER(fb.reference_number) LIKE ${"%" + search.toLowerCase() + "%"}`
        : sql``;
      const unassignedFilter = includeUnassigned === "false" ? sql`AND fb.finalized_by IS NOT NULL` : sql``;
      // Privileged users can see deleted bales when searching by ref code;
      // otherwise exclude deleted/removed bales (consistent with daily-summary)
      const deletedFilter = isPrivileged && search ? sql`` : sql`AND fb.status NOT IN ('DELETED', 'REMOVED')`;

      // Shared WHERE base reused by both the data query and the COUNT subquery.
      const whereClause = sql`
        WHERE fb.company_id = ${companyId}
          ${deletedFilter}
          AND fb.stock_entry_date IS NOT NULL
          AND fb.stock_entry_date >= ${effectiveStart}
          AND fb.stock_entry_date <= ${effectiveEnd}
          ${workerFilter}
          ${productFilter}
          ${locationFilter}
          ${categoryFilter2}
          ${statusFilter}
          ${searchFilter}
          ${unassignedFilter}`;

      const groupByClause = sql`GROUP BY fb.stock_entry_date, fb.erp_location_id, l.name, fb.finalized_by, fw.full_name, fb.product_id, fbp.name, fbp.article_code`;
      const orderByClause = sql`ORDER BY fb.stock_entry_date DESC, l.name NULLS LAST, fw.full_name NULLS LAST, fbp.name NULLS LAST`;

      const joinClause = sql`
        FROM factory_bales fb
        LEFT JOIN factory_workers fw ON fb.finalized_by = fw.id AND fw.company_id = ${companyId}
        LEFT JOIN factory_bale_products fbp ON fb.product_id = fbp.id AND fbp.company_id = ${companyId}
        LEFT JOIN locations l ON fb.erp_location_id = l.id AND l.company_id = ${companyId}`;

      // COUNT query: counts distinct groups + total bales + total weight across all matching groups.
      // Runs in parallel with the data query.
      const countQuery = sql`
        SELECT
          COUNT(*) AS total,
          COALESCE(SUM(grp_bale_count), 0) AS total_bales,
          COALESCE(SUM(grp_weight), 0) AS total_weight
        FROM (
          SELECT COUNT(fb.id) AS grp_bale_count, COALESCE(SUM(CAST(fb.weight_kg AS numeric)), 0) AS grp_weight
          ${joinClause}
          ${whereClause}
          ${groupByClause}
        ) AS grp`;

      function buildPaginatedResponse(items: any[], total: number, totalBales = 0, totalWeight = 0) {
        const totalPages = total === 0 ? 0 : Math.ceil(total / limit);
        return {
          items,
          total,
          totalBales,
          totalWeight,
          page,
          limit,
          totalPages,
          hasNextPage: page < totalPages,
          hasPreviousPage: page > 1 && totalPages > 0,
        };
      }

      // Lite mode: omit per-bale JSON_AGG — returns a summary-only payload (~95% smaller).
      // The condensed view uses this for the initial page load; bale details are fetched on demand.
      if (lite === "1") {
        const [liteResult, countResult] = await Promise.all([
          db.execute(sql`
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
              MAX(fb.finalized_at) AS "lastFinalizedAt"
            ${joinClause}
            ${whereClause}
            ${groupByClause}
            ${orderByClause}
            LIMIT ${limit} OFFSET ${offset}
          `),
          db.execute(countQuery),
        ]);
        const total = parseInt(String(countResult.rows[0]?.total ?? "0"), 10);
        const totalBales = parseInt(String(countResult.rows[0]?.total_bales ?? "0"), 10);
        const totalWeight = parseFloat(String(countResult.rows[0]?.total_weight ?? "0"));
        const items = liteResult.rows.map((r) => ({ ...r, bales: [] }));
        return res.json(buildPaginatedResponse(items, total, totalBales, totalWeight));
      }

      const [dataResult, countResult] = await Promise.all([
        db.execute(sql`
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
          ${joinClause}
          ${whereClause}
          ${groupByClause}
          ${orderByClause}
          LIMIT ${limit} OFFSET ${offset}
        `),
        db.execute(countQuery),
      ]);

      const total = parseInt(String(countResult.rows[0]?.total ?? "0"), 10);
      const totalBales = parseInt(String(countResult.rows[0]?.total_bales ?? "0"), 10);
      const totalWeight = parseFloat(String(countResult.rows[0]?.total_weight ?? "0"));
      res.json(buildPaginatedResponse(dataResult.rows, total, totalBales, totalWeight));
    } catch (error: unknown) {
      logger.error("Error fetching stock entry history:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

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
        ? sql`AND LOWER(fb.reference_number) LIKE ${"%" + search.toLowerCase() + "%"}`
        : sql``;
      const unassignedFilter = includeUnassigned === "false" ? sql`AND fb.finalized_by IS NOT NULL` : sql``;
      const deletedFilter = isPrivileged && search ? sql`` : sql`AND fb.status NOT IN ('DELETED', 'REMOVED')`;

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
          AND fb.stock_entry_date >= ${effectiveStart}
          AND fb.stock_entry_date <= ${effectiveEnd}
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
      const _LIGHT_BLUE = "#EFF3FB";
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
      doc.text(`Period: ${effectiveStart}  →  ${effectiveEnd}`, 40, subY);
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

      let _rowIdx = 0;
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

        _rowIdx++;
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

  app.get("/api/factory/bales/lookup/:barcode", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const barcode = req.params.barcode.toUpperCase();
      const batchId = req.query.batchId ? parseOptionalId(req.query.batchId) : null;
      const excludeIdsStr = req.query.excludeIds as string;
      const excludeIds = excludeIdsStr
        ? excludeIdsStr
            .split(",")
            .map(Number)
            .filter((n) => !isNaN(n))
        : [];

      let results = [];

      const baseConditions = [
        eq(factoryBales.companyId, companyId),
        or(
          eq(factoryBales.referenceNumber, barcode),
          eq(factoryBales.baleCode, barcode),
          eq(factoryBales.articleCode, barcode)
        ),
      ];
      if (batchId) {
        baseConditions.push(eq(factoryBales.pressingBatchId, batchId));
        baseConditions.push(eq(factoryBales.status, "PENDING_PRESSING"));
      } else {
        // General scan lookup — never surface deleted or removed bales
        baseConditions.push(not(inArray(factoryBales.status, ["DELETED", "REMOVED"])));
      }
      results = await db
        .select()
        .from(factoryBales)
        .where(and(...baseConditions))
        .orderBy(factoryBales.id);

      if (results.length === 0) {
        const labelResults = await db
          .select()
          .from(baleLabelPrints)
          .where(and(eq(baleLabelPrints.companyId, companyId), eq(baleLabelPrints.referenceNumber, barcode)));

        if (labelResults.length > 0 && labelResults[0].productionBaleId) {
          const labelBale = await db
            .select()
            .from(factoryBales)
            .where(eq(factoryBales.id, labelResults[0].productionBaleId));
          if (labelBale.length > 0) {
            if (!batchId || labelBale[0].pressingBatchId === batchId) {
              results = labelBale;
            }
          }
        }
      }

      if (excludeIds.length > 0) {
        results = results.filter((b) => !excludeIds.includes(b.id));
      }

      if (results.length === 0) return res.status(404).json({ message: "Bale not found" });
      res.json(results[0]);
    } catch (error: unknown) {
      logger.error("Error looking up bale:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // ───────────────────────────────────────────────
  // 11. Factory Production Summary
  // ───────────────────────────────────────────────

  app.get("/api/factory/production-summary", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const allBales = await db
        .select({
          status: factoryBales.status,
          weightKg: factoryBales.weightKg,
        })
        .from(factoryBales)
        .where(eq(factoryBales.companyId, companyId));

      const totalBales = allBales.length;
      let pendingCount = 0;
      let finalizedCount = 0;
      let pendingWeight = 0;
      let finalizedWeight = 0;

      for (const bale of allBales) {
        const weight = parseFloat(bale.weightKg) || 0;
        if (bale.status === "PENDING_PRESSING") {
          pendingCount++;
          pendingWeight += weight;
        } else if (bale.status === "IN_STOCK") {
          finalizedCount++;
          finalizedWeight += weight;
        }
      }

      const mixBatches = await db
        .select({
          totalWeightKg: factoryMixBatches.totalWeightKg,
          usedKg: factoryMixBatches.usedKg,
        })
        .from(factoryMixBatches)
        .where(eq(factoryMixBatches.companyId, companyId));

      let totalMixWeight = 0;
      let totalMixUsed = 0;
      for (const mb of mixBatches) {
        totalMixWeight += parseFloat(mb.totalWeightKg) || 0;
        totalMixUsed += parseFloat(mb.usedKg) || 0;
      }

      res.json({
        totalBales,
        pendingCount,
        finalizedCount,
        pendingWeight: pendingWeight.toFixed(3),
        finalizedWeight: finalizedWeight.toFixed(3),
        totalWeight: (pendingWeight + finalizedWeight).toFixed(3),
        mixBatchUtilization: {
          totalWeightKg: totalMixWeight.toFixed(3),
          usedKg: totalMixUsed.toFixed(3),
          remainingKg: (totalMixWeight - totalMixUsed).toFixed(3),
          utilizationPercent: totalMixWeight > 0 ? ((totalMixUsed / totalMixWeight) * 100).toFixed(1) : "0.0",
        },
      });
    } catch (error: unknown) {
      logger.error("Error fetching production summary:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // ───────────────────────────────────────────────
  // Factory Dashboard KPIs
  // ───────────────────────────────────────────────

  app.get("/api/factory/dashboard-kpis", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);

      const _kpiKey = `factory-kpis:${companyId}:${todayStart.toDateString()}`;
      const _kpiHit = _getKpiCached(_kpiKey);
      if (_kpiHit) return res.json(_kpiHit);

      // Fire all three independent DB queries in parallel
      const [rawStockTotals, todayMixBatches, todayBales] = await Promise.all([
        db
          .select({
            totalReceived: sql<string>`COALESCE(SUM(${factoryRawStock.receivedKg}), 0)`,
            totalUsed: sql<string>`COALESCE(SUM(${factoryRawStock.usedKg}), 0)`,
          })
          .from(factoryRawStock)
          .where(eq(factoryRawStock.companyId, companyId)),

        db
          .select({ totalWeightKg: factoryMixBatches.totalWeightKg })
          .from(factoryMixBatches)
          .where(and(eq(factoryMixBatches.companyId, companyId), sql`${factoryMixBatches.createdAt} >= ${todayStart}`)),

        db
          .select({
            id: factoryBales.id,
            baleCode: factoryBales.baleCode,
            productName: factoryBales.productName,
            category: factoryBales.category,
            weightKg: factoryBales.weightKg,
            pressedAt: factoryBales.pressedAt,
            status: factoryBales.status,
          })
          .from(factoryBales)
          .where(and(eq(factoryBales.companyId, companyId), sql`${factoryBales.pressedAt} >= ${todayStart}`)),
      ]);

      const totalReceived = parseFloat(rawStockTotals[0]?.totalReceived || "0");
      const totalUsed = parseFloat(rawStockTotals[0]?.totalUsed || "0");
      const closingStockKg = totalReceived - totalUsed;

      const kgsUsedToday = todayMixBatches.reduce((sum, mb) => sum + (parseFloat(mb.totalWeightKg as string) || 0), 0);
      const openingStockKg = closingStockKg + kgsUsedToday;

      const balesPressedToday = todayBales.length;
      const totalBaleWeightToday = todayBales.reduce((sum, b) => sum + (parseFloat(b.weightKg as string) || 0), 0);

      const categoryMap: Record<string, { count: number; totalKg: number }> = {};
      for (const bale of todayBales) {
        const name = bale.productName || bale.category || "Unknown";
        if (!categoryMap[name]) categoryMap[name] = { count: 0, totalKg: 0 };
        categoryMap[name].count++;
        categoryMap[name].totalKg += parseFloat(bale.weightKg as string) || 0;
      }
      const categories = Object.entries(categoryMap)
        .map(([name, data]) => ({ name, count: data.count, totalKg: parseFloat(data.totalKg.toFixed(3)) }))
        .sort((a, b) => b.count - a.count);

      const _kpiResult = {
        openingStockKg: openingStockKg.toFixed(3),
        closingStockKg: closingStockKg.toFixed(3),
        balesPressedToday,
        kgsUsedToday: kgsUsedToday.toFixed(3),
        totalBaleWeightToday: totalBaleWeightToday.toFixed(3),
        categories,
        balesDetail: todayBales.map((b) => ({ ...b, quantity: 1 })),
      };
      _setKpiCached(_kpiKey, _kpiResult);
      res.json(_kpiResult);
    } catch (error: unknown) {
      logger.error("Error fetching factory dashboard KPIs:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
