import type { Express } from "express";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { getClientDate } from "../../lib/dateUtils";
import { db } from "../../db";
import { requireAuth } from "../../auth";
import { vouchers, voucherEntries, ledgerAccounts } from "@shared/schema";
import { eq, and, sql } from "drizzle-orm";
import { generateInvoicePdf } from "../../helpers/generateInvoicePdf";
import { getErpExportVisibility } from "../../helpers/exportVisibility";
import { tempPdfStore } from "./posHelpers";

export function registerPosPrintRoutes(app: Express): void {
  // ── Serve temporarily stored PDFs (used by WhatsApp sendFileByUrl) ──────────
  // Auth-gated: even though the ID is a random unguessable key, we require an
  // authenticated session to defend against accidental URL leakage in browser
  // history, referrer headers, or chat logs.
  app.get("/api/pos/temp-pdf/:id", requireAuth, (req, res) => {
    const entry = tempPdfStore.get(req.params.id);
    if (!entry || entry.expiresAt < Date.now()) {
      return res.status(404).json({ message: "File not found or expired" });
    }
    const ct = entry.contentType ?? "application/pdf";
    const fn = entry.filename ?? "stock_report.pdf";
    res.setHeader("Content-Type", ct);
    res.setHeader("Content-Disposition", `inline; filename="${fn}"`);
    res.send(entry.buffer);
  });

  // ── Direct invoice PDF download (ERP use — no location/WA required) ──────────
  app.get("/api/pos/invoice/:voucherId/pdf", requireAuth, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const voucherId = parseInt(req.params.voucherId);
      if (isNaN(voucherId)) return res.status(400).json({ message: "Invalid voucherId" });

      // Verify the voucher belongs to this company
      const [voucherRow] = await db
        .select({ id: vouchers.id, isCreditSale: vouchers.isCreditSale, voucherDate: vouchers.voucherDate })
        .from(vouchers)
        .where(and(eq(vouchers.id, voucherId), eq(vouchers.companyId, companyId)))
        .limit(1);
      if (!voucherRow) return res.status(404).json({ message: "Voucher not found" });

      const erpVis = await getErpExportVisibility(req);
      // P/L columns (CONFIG / P/L BALE / TOTAL P/L) auto-hide inside the PDF generator
      // when no item has a configured price.  Do NOT gate on hideSalesProfitCost here —
      // the only valid reason to suppress the columns is "no configured price set".
      const hideProfitCols = erpVis.hideSelling || erpVis.hideCost;
      // Match the compact layout used by the WhatsApp POS invoice. The standard\n      // A4 layout spreads large sales over far more printed pages.\n      const pdfBuffer = await generateInvoicePdf(voucherId, companyId, req.user?.username, {\n        hideProfitCols,\n        compactMode: true,\n        whatsappMode: true,\n      });

      // Build a friendly filename
      let customerName: string | null = null;
      if (voucherRow.isCreditSale) {
        const [custEntry] = await db
          .select({ name: ledgerAccounts.name })
          .from(voucherEntries)
          .innerJoin(ledgerAccounts, eq(ledgerAccounts.id, voucherEntries.ledgerAccountId))
          .where(and(eq(voucherEntries.voucherId, voucherId), sql`${voucherEntries.debitAmount}::numeric > 0`))
          .limit(1);
        customerName = custEntry?.name || null;
      }
      const dateStr = voucherRow.voucherDate ? String(voucherRow.voucherDate).slice(0, 10) : getClientDate(req);
      const rawName = customerName ? `${customerName} Invoice ${dateStr}` : `Invoice ${dateStr}`;
      const safeName = rawName.replace(/[^\w\s.()-]/g, "_").trim();

      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `inline; filename="${safeName}.pdf"`);
      res.setHeader("Content-Length", pdfBuffer.length);
      res.send(pdfBuffer);
    } catch (error: unknown) {
      logger.error("[GET /api/pos/invoice/:voucherId/pdf]", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
