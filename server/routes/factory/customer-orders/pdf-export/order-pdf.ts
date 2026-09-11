/**
 * orderPdfExportRoutes: OrderPdf endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response } from "express";
import { logAudit } from "../../../helpers/auditHelpers";
import { getErrorMessage } from "../../../../lib/httpHandlers";
import { logger } from "../../../../lib/logger";
import { contentDisposition } from "../../../../lib/contentDisposition";
import { parseId } from "../../../../lib/parseId";
import { getExportPriceVisibility } from "../../../../helpers/exportVisibility";
import { db } from "../../../../db";
import { requireAuth } from "../../../../auth";
import {
  factoryBaleProducts,
  customerOrders,
  customerOrderLines,
  customerOrderCharges,
  customers,
} from "@shared/schema";
import { eq, and, inArray } from "drizzle-orm";
import path from "path";
import fs from "fs";

import { buildExportFilename } from "../orderHelpers";

export function registerOrderPdfRoutes(app: Express) {
  app.get("/api/factory/customer-orders/:id/export-pdf", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const orderId = parseId(req.params.id);

      if (orderId === null) return res.status(400).json({ message: "Invalid id" });
      const { hideSelling: hideSellingPdf } = await getExportPriceVisibility(req);
      const noChargesPdf = req.query.noCharges === "1";

      const [order] = await db
        .select({
          id: customerOrders.id,
          invoiceNumber: customerOrders.invoiceNumber,
          orderDate: customerOrders.orderDate,
          status: customerOrders.status,
          subtotalBales: customerOrders.subtotalBales,
          freightAmount: customerOrders.freightAmount,
          otherChargesTotal: customerOrders.otherChargesTotal,
          grandTotal: customerOrders.grandTotal,
          totalQtyBales: customerOrders.totalQtyBales,
          containerNumber: customerOrders.containerNumber,
          destination: customerOrders.destination,
          customerName: customers.legalName,
          customerCode: customers.code,
        })
        .from(customerOrders)
        .leftJoin(customers, eq(customerOrders.customerId, customers.id))
        .where(and(eq(customerOrders.id, orderId), eq(customerOrders.companyId, companyId)));

      if (!order) return res.status(404).json({ message: "Order not found" });

      const lines = await db.select().from(customerOrderLines).where(eq(customerOrderLines.orderId, orderId));
      const charges = await db.select().from(customerOrderCharges).where(eq(customerOrderCharges.orderId, orderId));

      const invArticleCodes = [...new Set(lines.map((l) => l.articleCode).filter(Boolean))];
      const invNameMap = new Map<string, string>();
      if (invArticleCodes.length > 0) {
        const invProds = await db
          .select({ articleCode: factoryBaleProducts.articleCode, name: factoryBaleProducts.name })
          .from(factoryBaleProducts)
          .where(
            and(eq(factoryBaleProducts.companyId, companyId), inArray(factoryBaleProducts.articleCode, invArticleCodes))
          );
        for (const p of invProds) {
          if (p.articleCode) invNameMap.set(p.articleCode, p.name);
        }
      }
      const sortedLines = lines.sort((a, b) => {
        const na = invNameMap.get(a.articleCode) || a.baleName || "";
        const nb = invNameMap.get(b.articleCode) || b.baleName || "";
        return na.localeCompare(nb);
      });

      const invoiceLabel = order.invoiceNumber || `INV-${String(orderId).padStart(6, "0")}`;

      // ── PDFKit setup ──────────────────────────────────────────────────────────
      const PDFDocument = (await import("pdfkit")).default;
      const doc = new PDFDocument({ margin: 40, size: "A4" });
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        contentDisposition(buildExportFilename([order.containerNumber, order.customerName, order.destination], "pdf"))
      );
      doc.pipe(res);

      const PAGE_W = doc.page.width; // 595
      const L = 40,
        R = PAGE_W - 40; // left / right margin x
      const USABLE = R - L; // 515

      const fmtN = (val: unknown) => {
        const n = parseFloat(String(val));
        if (isNaN(n)) return val == null ? "" : String(val);
        return n % 1 === 0 ? n.toLocaleString("en-US") : n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
      };
      const fmtM = (val: unknown) => `$${fmtN(val)}`;

      // ── Logo (centred, fixed height so title lands below it) ─────────────────
      const logoPath = path.join(process.cwd(), "server", "hmd-logo.png");
      const LOGO_W = 200;
      const LOGO_H = 87; // ≈ 200 × (96/220) — matches actual HMD logo aspect ratio
      const LOGO_TOP = 30;
      if (fs.existsSync(logoPath)) {
        try {
          doc.image(logoPath, (PAGE_W - LOGO_W) / 2, LOGO_TOP, {
            width: LOGO_W,
            height: LOGO_H,
            fit: [LOGO_W, LOGO_H],
          });
        } catch {
          // Failure here is non-fatal and the surrounding flow continues deliberately.
        }
      }
      const afterLogo = LOGO_TOP + LOGO_H + 10;

      // ── Title ─────────────────────────────────────────────────────────────────
      doc
        .fontSize(14)
        .font("Helvetica-Bold")
        .fillColor("#000000")
        .text("INVOICE", L, afterLogo, { width: USABLE, align: "center" });

      // ── Divider ───────────────────────────────────────────────────────────────
      const divY = doc.y + 6;
      doc.moveTo(L, divY).lineTo(R, divY).lineWidth(0.5).strokeColor("#cccccc").stroke();
      doc.lineWidth(1).strokeColor("#000000");

      // ── Meta block ───────────────────────────────────────────────────────────
      const metaY = divY + 12;
      const dateStr = order.orderDate
        ? new Date(order.orderDate + "T00:00:00").toLocaleDateString("en-GB", {
            day: "2-digit",
            month: "short",
            year: "numeric",
          })
        : "-";
      const metaItems: [string, string][] = [
        ["Invoice No.", invoiceLabel],
        ["Customer", order.customerName || "-"],
        ["Date", dateStr],
        ...(order.containerNumber ? [["Container", order.containerNumber] as [string, string]] : []),
      ];
      let mY = metaY;
      doc.font("Helvetica").fontSize(9).fillColor("#000000");
      for (const [label, value] of metaItems) {
        doc.font("Helvetica-Bold").text(`${label}  `, L, mY, { continued: true }).font("Helvetica").text(value);
        mY = doc.y + 2;
      }

      doc.moveDown(0.8);

      // ── Column layout ─────────────────────────────────────────────────────────
      let colX: number[], colW: number[], colHdr: string[], colAlign: Array<"left" | "right" | "center">;
      if (hideSellingPdf) {
        colX = [40, 62, 132, 382, 428, 476];
        colW = [22, 70, 250, 46, 48, 79];
        colHdr = ["#", "Code", "Product", "Qty", "Wt/Bale", "Total Wt"];
        colAlign = ["center", "center", "left", "center", "center", "center"];
      } else {
        colX = [40, 62, 132, 310, 356, 402, 450, 503];
        colW = [22, 70, 178, 46, 46, 48, 53, 52];
        colHdr = ["#", "Code", "Product", "Qty", "Wt/Bale", "Total Wt", "Price/Bale", "Total"];
        colAlign = ["center", "center", "left", "center", "center", "center", "center", "center"];
      }

      // ── Table header row ──────────────────────────────────────────────────────
      const tblTop = doc.y + 4;
      const HDR_H = 16;
      doc.rect(L, tblTop, USABLE, HDR_H).fill("#1F3864");
      doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(8);
      colHdr.forEach((h, i) => {
        doc.text(h, colX[i] + 2, tblTop + 4, { width: colW[i] - 4, align: colAlign[i] });
      });
      doc.fillColor("#000000").font("Helvetica").fontSize(8);

      // ── Table rows ────────────────────────────────────────────────────────────
      const ROW_H = 14;
      let y = tblTop + HDR_H;
      let totalQty = 0,
        totalWt = 0,
        totalAmt = 0;

      for (let idx = 0; idx < sortedLines.length; idx++) {
        const line = sortedLines[idx] as unknown as {
          qty: string;
          weightPerBale: string;
          totalWeight: string;
          pricePerBale: string;
          totalPrice: string;
          articleCode: string;
          baleName: string;
        };
        const qty = parseFloat(line.qty || "0");
        const wtBale = parseFloat(line.weightPerBale || "0");
        const totWt = parseFloat(line.totalWeight || "0") || qty * wtBale;
        const price = parseFloat(line.pricePerBale || "0");
        const totPrice = parseFloat(line.totalPrice || "0") || qty * price;
        totalQty += qty;
        totalWt += totWt;
        totalAmt += totPrice;

        if (y + ROW_H > doc.page.height - 60) {
          doc.addPage();
          y = 40;
        }
        if (idx % 2 === 1) {
          doc.rect(L, y, USABLE, ROW_H).fill("#F4F7FB");
          doc.fillColor("#000000");
        }
        const productName = invNameMap.get(line.articleCode) || line.baleName || "";
        const vals: string[] = hideSellingPdf
          ? [String(idx + 1), line.articleCode || "", productName, fmtN(qty), fmtN(wtBale), fmtN(totWt)]
          : [
              String(idx + 1),
              line.articleCode || "",
              productName,
              fmtN(qty),
              fmtN(wtBale),
              fmtN(totWt),
              fmtM(price),
              fmtM(totPrice),
            ];
        vals.forEach((v, i) => {
          doc.text(v, colX[i] + 2, y + 3, { width: colW[i] - 4, align: colAlign[i], lineBreak: false });
        });
        y += ROW_H;
      }

      // ── Totals row ────────────────────────────────────────────────────────────
      y += 2;
      doc.moveTo(L, y).lineTo(R, y).lineWidth(0.5).strokeColor("#888888").stroke();
      doc.lineWidth(1).strokeColor("#000000");
      y += 4;
      doc.rect(L, y, USABLE, 16).fill("#EEF2F9");
      doc.fillColor("#000000").font("Helvetica-Bold").fontSize(8);
      const totVals = hideSellingPdf
        ? ["", "", "TOTALS", fmtN(totalQty), "", fmtN(totalWt)]
        : ["", "", "TOTALS", fmtN(totalQty), "", fmtN(totalWt), "", fmtM(totalAmt)];
      totVals.forEach((v, i) => {
        if (v) doc.text(v, colX[i] + 2, y + 4, { width: colW[i] - 4, align: colAlign[i], lineBreak: false });
      });
      y += 20;

      // ── Charges & grand-total summary (omit when hiding prices or noCharges) ──
      if (!hideSellingPdf && !noChargesPdf) {
        const freightCharges = charges.filter((ch) => ch.chargeType === "FREIGHT");
        const otherCharges = charges.filter((ch) => ch.chargeType !== "FREIGHT");
        const hasCharges = freightCharges.length > 0 || otherCharges.length > 0;

        if (hasCharges) {
          y += 8;
          doc.font("Helvetica-Bold").fontSize(9).fillColor("#000000").text("Freight & Charges", L, y);
          y = doc.y + 4;
          doc.font("Helvetica").fontSize(8);
          for (const ch of [...freightCharges, ...otherCharges]) {
            doc
              .text(ch.name || ch.chargeType, L + 10, y, { continued: true })
              .text(fmtM(ch.amount), { align: "right", width: USABLE - 10 });
            y = doc.y + 2;
          }
          y += 4;
        }

        // Summary box
        const summaryRows: [string, string, boolean][] = [["Subtotal (Bales)", fmtM(order.subtotalBales), false]];
        const freight = parseFloat(order.freightAmount || "0");
        if (freight > 0) summaryRows.push(["Freight", fmtM(freight), false]);
        const otherTotal = parseFloat(order.otherChargesTotal || "0");
        if (otherCharges.length > 0) {
          for (const ch of otherCharges) summaryRows.push([ch.name || "Other", fmtM(ch.amount), false]);
        } else if (otherTotal > 0) {
          summaryRows.push(["Other Charges", fmtM(otherTotal), false]);
        }
        summaryRows.push(["Grand Total", fmtM(order.grandTotal), true]);

        const BOX_W = 220;
        const boxX = R - BOX_W;
        doc.font("Helvetica").fontSize(9);
        for (const [label, value, isGrand] of summaryRows) {
          if (y + 18 > doc.page.height - 40) {
            doc.addPage();
            y = 40;
          }
          if (isGrand) {
            doc.rect(boxX, y, BOX_W, 18).fill("#1F3864");
            doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(10);
            doc.text(label, boxX + 8, y + 4, { continued: true }).text(value, { align: "right", width: BOX_W - 16 });
            doc.fillColor("#000000").font("Helvetica").fontSize(9);
          } else {
            doc
              .moveTo(boxX, y + 16)
              .lineTo(R, y + 16)
              .lineWidth(0.3)
              .strokeColor("#cccccc")
              .stroke();
            doc.lineWidth(1).strokeColor("#000000");
            doc.text(label, boxX + 8, y + 4, { continued: true }).text(value, { align: "right", width: BOX_W - 16 });
          }
          y += 18;
        }
      }

      // Non-fatal: audit write must not break PDF delivery
      try {
        await logAudit({
          userId: req.session.userId!,
          username: req.session.username || req.session.userId!,
          companyId,
          action: "export",
          tableName: "factory_customer_orders",
          recordId: orderId,
          recordIdentifier: `Customer Order #${order.invoiceNumber || orderId} PDF`,
          changes: { format: { old: null, new: "pdf" }, orderId: { old: null, new: orderId } },
        });
      } catch (auditErr) {
        logger.error("[PdfExport] audit write failed:", { error: auditErr });
      }
      doc.end();
    } catch (error: unknown) {
      logger.error("Error exporting order to PDF:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // ─────── LOADING STATUS EXCEL EXPORT ───────
}
