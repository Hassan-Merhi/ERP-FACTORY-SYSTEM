import type { Express, Request, Response } from "express";
import { and, eq, sql } from "drizzle-orm";
import { format, startOfMonth, endOfMonth } from "date-fns";

import { requireAuth } from "../auth";
import { db } from "../db";
import { getClientDate } from "../lib/dateUtils";
import { getErrorMessage } from "../lib/httpHandlers";
import { logger } from "../lib/logger";
import { parseId } from "../lib/parseId";
import { generateAccountStatementPdf } from "../lib/accountStatementPdfGenerator";
import { enforcePosCapabilityScope } from "../middleware/posCapabilityScope";
import { enforcePosOperationalPermissionScope } from "../middleware/posOperationalPermissionScope";
import { generateInvoicePdfMeta } from "../helpers/generateInvoicePdf";
import { getErpExportVisibility } from "../helpers/exportVisibility";
import {
  factoryAccountWhatsappRules,
  ledgerAccounts,
  locations,
  posShifts,
  voucherEntries,
  vouchers,
} from "@shared/schema";
import { sendBufferFast, serveFastAttachment } from "./whatsappFastSendRoutesSendBufferFast";
import { sendPosStockFast } from "./whatsappFastSendRoutesSendPosStockFast";
import { sendUploadedPdfFast } from "./whatsappFastSendRoutesSendUploadedPdfFast";

async function sendPosInvoiceFast(req: Request, res: Response): Promise<void> {
  const startedAt = Date.now();
  try {
    const companyId = req.session.currentCompanyId;
    if (!companyId) {
      res.status(400).json({ message: "No company selected" });
      return;
    }

    const voucherId = Number(req.body?.voucherId);
    if (!Number.isInteger(voucherId) || voucherId <= 0) {
      res.status(400).json({ message: "Invalid voucherId" });
      return;
    }

    const [voucher] = await db
      .select({
        id: vouchers.id,
        shiftId: vouchers.shiftId,
        locationId: vouchers.locationId,
        isCreditSale: vouchers.isCreditSale,
        voucherDate: vouchers.voucherDate,
      })
      .from(vouchers)
      .where(and(eq(vouchers.id, voucherId), eq(vouchers.companyId, companyId)))
      .limit(1);

    if (!voucher) {
      res.status(404).json({ message: "Voucher not found" });
      return;
    }

    if (req.user?.role === "POS" && voucher.shiftId) {
      const [shift] = await db
        .select({ userId: posShifts.userId })
        .from(posShifts)
        .where(eq(posShifts.id, voucher.shiftId))
        .limit(1);
      if (!shift || shift.userId !== req.user.id) {
        res.status(403).json({ message: "Access denied" });
        return;
      }
    }

    const requestedLocationId = Number(req.body?.locationId);
    const locationId =
      Number.isInteger(requestedLocationId) && requestedLocationId > 0 ? requestedLocationId : voucher.locationId;
    if (!locationId) {
      res.status(400).json({ message: "Voucher has no location" });
      return;
    }

    const [location] = await db
      .select({ id: locations.id, name: locations.name, whatsappGroupChatId: locations.whatsappGroupChatId })
      .from(locations)
      .where(and(eq(locations.id, locationId), eq(locations.companyId, companyId)))
      .limit(1);
    if (!location) {
      res.status(404).json({ message: "Location not found" });
      return;
    }
    if (!req.body?.dryRun && !location.whatsappGroupChatId) {
      res.status(400).json({ message: "No WhatsApp group configured for this location" });
      return;
    }

    const erpVis = await getErpExportVisibility(req);
    const hideProfitCols = erpVis.hideSelling || erpVis.hideCost;
    const compactMode = true;
    const whatsappMode = true;
    const {
      buffer: pdfBuffer,
      pageCount,
      itemCount,
    } = await generateInvoicePdfMeta(voucherId, companyId, req.user?.username, {
      hideProfitCols,
      compactMode,
      whatsappMode,
    });

    const pdfSize = pdfBuffer?.length ?? 0;
    const validHeader = pdfBuffer && pdfBuffer.slice(0, 4).toString("ascii") === "%PDF";
    const maxReasonablePages = Math.ceil(itemCount / 20) + 4;
    if (!pdfBuffer || pdfSize < 1000 || !validHeader) {
      res.status(500).json({ message: "PDF generation failed: invalid or empty PDF" });
      return;
    }
    if (pageCount > maxReasonablePages) {
      res.status(500).json({
        message: `PDF page count (${pageCount}) is excessive for ${itemCount} items — aborting WhatsApp send`,
      });
      return;
    }

    const dateStr = (voucher.voucherDate ?? getClientDate(req)).replace(/[^0-9-]/g, "");
    let customerName: string | null = null;
    if (voucher.isCreditSale) {
      const [customerEntry] = await db
        .select({ name: ledgerAccounts.name })
        .from(voucherEntries)
        .innerJoin(ledgerAccounts, eq(ledgerAccounts.id, voucherEntries.ledgerAccountId))
        .where(and(eq(voucherEntries.voucherId, voucherId), sql`${voucherEntries.debitAmount}::numeric > 0`))
        .limit(1);
      customerName = customerEntry?.name || null;
    }

    const rawName = customerName
      ? `${customerName} Invoice ${location.name} ${dateStr}`
      : `${location.name} Invoice ${dateStr}`;
    const fileName = `${rawName.replace(/[^\w\s.()-]/g, "_").trim()}.pdf`;

    if (req.body?.dryRun) {
      res.json({
        success: true,
        dryRun: true,
        pdfSize,
        pageCount,
        itemCount,
        filename: fileName,
        compactMode,
        whatsappMode,
      });
      return;
    }

    const result = await sendBufferFast(req, location.whatsappGroupChatId!, pdfBuffer, fileName, "", "application/pdf");
    if (!result.success) {
      res.status(502).json({ message: result.error ?? "WhatsApp send failed" });
      return;
    }

    logger.info("POS invoice WhatsApp send accepted", {
      module: "whatsappFastSend",
      action: "sendInvoice",
      companyId,
      voucherId,
      locationId,
      mode: result.mode,
      durationMs: Date.now() - startedAt,
    });
    res.json({ success: true, deliveryMode: result.mode, deliveryStatus: "accepted" });
  } catch (error: unknown) {
    logger.error("[WA fast invoice] failed", { error });
    res.status(500).json({ message: getErrorMessage(error) });
  }
}

async function sendAccountStatementFast(req: Request, res: Response): Promise<void> {
  const startedAt = Date.now();
  try {
    const accountId = parseId(req.params.accountId);
    if (accountId === null) {
      res.status(400).json({ message: "Invalid id" });
      return;
    }
    const companyId = req.session.currentCompanyId;
    if (!companyId) {
      res.status(400).json({ message: "No company selected" });
      return;
    }

    const [[account], [rule]] = await Promise.all([
      db
        .select({ id: ledgerAccounts.id, name: ledgerAccounts.name })
        .from(ledgerAccounts)
        .where(and(eq(ledgerAccounts.id, accountId), eq(ledgerAccounts.companyId, companyId))),
      db
        .select({ whatsappChatId: factoryAccountWhatsappRules.whatsappChatId })
        .from(factoryAccountWhatsappRules)
        .where(
          and(
            eq(factoryAccountWhatsappRules.companyId, companyId),
            eq(factoryAccountWhatsappRules.ledgerAccountId, accountId)
          )
        ),
    ]);

    if (!account) {
      res.status(404).json({ message: "Account not found" });
      return;
    }
    if (!rule?.whatsappChatId) {
      res.status(400).json({ message: "No WhatsApp target configured for this account" });
      return;
    }

    const month = typeof req.body?.month === "string" ? req.body.month : undefined;
    const base = month ? new Date(`${month}-01T00:00:00`) : new Date();
    const startDate = format(startOfMonth(base), "yyyy-MM-dd");
    const endDate = format(endOfMonth(base), "yyyy-MM-dd");
    const monthLabel = month ?? format(base, "yyyy-MM");
    const safeName = account.name.replace(/[^\w\s.()-]/g, "_");
    const fileName = `${safeName} Statement ${monthLabel}.pdf`;
    const caption = `${account.name} — Statement ${monthLabel}`;

    const pdfBuffer = await generateAccountStatementPdf({
      accountType: "ledger",
      accountId,
      companyId,
      startDate,
      endDate,
      lang: "en",
    });

    const result = await sendBufferFast(req, rule.whatsappChatId, pdfBuffer, fileName, caption);
    if (!result.success) {
      res.status(502).json({ message: result.error ?? "WhatsApp send failed" });
      return;
    }

    logger.info("Account statement WhatsApp send accepted", {
      module: "whatsappFastSend",
      action: "sendAccountStatement",
      companyId,
      accountId,
      mode: result.mode,
      durationMs: Date.now() - startedAt,
    });
    res.json({ success: true, fileName, deliveryMode: result.mode, deliveryStatus: "accepted" });
  } catch (error: unknown) {
    logger.error("[WA fast account statement] failed", { error });
    res.status(500).json({ message: getErrorMessage(error) });
  }
}

export function registerWhatsAppFastSendRoutes(app: Express): void {
  // Capability-token URL used only by Green API to fetch a just-generated file.
  // Tokens are 256-bit random values and expire automatically after one hour.
  app.get("/api/whatsapp/fast-file/:token", serveFastAttachment);
  app.head("/api/whatsapp/fast-file/:token", serveFastAttachment);

  // These handlers intentionally register before the legacy routes. Direct
  // upload is now the reliable primary path; sendFileByUrl remains a fallback
  // for provider failures and keeps a longer-lived capability URL.
  for (const route of ["/api/pos/send-stock-pdf-backend", "/api/pos/send-stock-pdf"]) {
    app.post(route, requireAuth, enforcePosOperationalPermissionScope, enforcePosCapabilityScope, sendPosStockFast);
  }
  for (const route of ["/api/pos/send-invoice-pdf-backend", "/api/pos/send-invoice-whatsapp"]) {
    app.post(route, requireAuth, enforcePosOperationalPermissionScope, enforcePosCapabilityScope, sendPosInvoiceFast);
  }
  app.post(
    "/api/pos/send-whatsapp-pdf-upload",
    requireAuth,
    enforcePosOperationalPermissionScope,
    enforcePosCapabilityScope,
    sendUploadedPdfFast
  );

  app.post("/api/accounts/:accountId/send-statement-whatsapp", requireAuth, sendAccountStatementFast);
  app.post("/api/factory/accounts/:accountId/send-statement-whatsapp", requireAuth, sendAccountStatementFast);
}
