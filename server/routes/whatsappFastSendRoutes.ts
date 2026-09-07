import { randomBytes } from "crypto";
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
import { generateStockPdf } from "../helpers/generateStockPdf";
import { getErpExportVisibility } from "../helpers/exportVisibility";
import { getPosWaSettings, getWaSettingsById, sendWhatsAppFileByUploadPos } from "../services/whatsappService";
import {
  companies,
  factoryAccountWhatsappRules,
  ledgerAccounts,
  locations,
  posShifts,
  userCompanyRoles,
  voucherEntries,
  vouchers,
} from "@shared/schema";

const FAST_ATTACHMENT_TTL_MS = 60 * 60 * 1000;
const FAST_SEND_TIMEOUT_MS = 12_000;
const MAX_FAST_ATTACHMENTS = 100;

type FastAttachment = {
  buffer: Buffer;
  contentType: string;
  fileName: string;
  expiresAt: number;
};

type GreenApiCredentials = {
  instanceId: string;
  apiToken: string;
};

type FastUrlAttempt = { success: true } | { success: false; status?: number; body?: string; error: string };

const fastAttachments = new Map<string, FastAttachment>();

function trimBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

function resolvePublicBaseUrl(req: Request): string | null {
  const configured = process.env.WHATSAPP_PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL;
  if (configured?.trim()) return trimBaseUrl(configured);

  const forwardedProto = String(req.headers["x-forwarded-proto"] || "")
    .split(",")[0]
    .trim();
  const forwardedHost = String(req.headers["x-forwarded-host"] || "")
    .split(",")[0]
    .trim();
  const protocol = forwardedProto || req.protocol || "https";
  const host = forwardedHost || req.get("host") || "";
  if (!host) return null;

  const hostname = host.split(":")[0]?.toLowerCase();
  if (!hostname || hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1") {
    return null;
  }

  return `${protocol}://${host}`;
}

function evictExpiredFastAttachments(): void {
  const now = Date.now();
  for (const [token, entry] of fastAttachments) {
    if (entry.expiresAt <= now) fastAttachments.delete(token);
  }
  while (fastAttachments.size >= MAX_FAST_ATTACHMENTS) {
    const oldest = fastAttachments.keys().next().value as string | undefined;
    if (!oldest) break;
    fastAttachments.delete(oldest);
  }
}

function storeFastAttachment(buffer: Buffer, fileName: string, contentType: string): string {
  evictExpiredFastAttachments();
  const token = randomBytes(32).toString("hex");
  fastAttachments.set(token, {
    buffer,
    fileName,
    contentType,
    expiresAt: Date.now() + FAST_ATTACHMENT_TTL_MS,
  });
  const timer = setTimeout(() => fastAttachments.delete(token), FAST_ATTACHMENT_TTL_MS);
  timer.unref?.();
  return token;
}

function deleteFastAttachment(token: string): void {
  fastAttachments.delete(token);
}

function isGreenApiQuotaFailure(status: number | undefined, body: string | undefined): boolean {
  if (status === 466) return true;
  return /QUOTE_EXCEEDED|CORRESPONDENTS_QUOTE_EXCEEDED|CORRESPONDENTS_QUOTA_EXCEEDED/i.test(body || "");
}

function formatGreenApiFailure(attempt: FastUrlAttempt, uploadError?: string): string {
  if (!attempt.success && isGreenApiQuotaFailure(attempt.status, attempt.body)) {
    if (/correspondents|only send or receive messages/i.test(attempt.body || "")) {
      return "Green API blocked this WhatsApp group because the configured Developer plan has reached its monthly chat limit. The ERP also tried its fallback delivery path. Configure/upgrade an instance that is allowed to message this group.";
    }
    return "Green API monthly quota has been reached. The ERP also tried its fallback delivery path, but the provider still blocked the send.";
  }
  if (uploadError) return uploadError;
  if (!attempt.success) return attempt.error;
  return "";
}

async function sendFileByUrlAttempt({
  publicBaseUrl,
  settings,
  chatId,
  buffer,
  fileName,
  caption,
  contentType,
}: {
  publicBaseUrl: string;
  settings: GreenApiCredentials;
  chatId: string;
  buffer: Buffer;
  fileName: string;
  caption: string;
  contentType: string;
}): Promise<FastUrlAttempt> {
  const token = storeFastAttachment(buffer, fileName, contentType);
  const fileUrl = `${publicBaseUrl}/api/whatsapp/fast-file/${token}`;
  const apiUrl = `https://api.green-api.com/waInstance${settings.instanceId}/sendFileByUrl/${settings.apiToken}`;
  const startedAt = Date.now();

  try {
    const response = await fetch(apiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chatId, urlFile: fileUrl, fileName, caption }),
      signal: AbortSignal.timeout(FAST_SEND_TIMEOUT_MS),
    });

    if (!response.ok) {
      const body = await response.text();
      deleteFastAttachment(token);
      return {
        success: false,
        status: response.status,
        body,
        error: `Green API ${response.status}: ${body}`,
      };
    }

    logger.info("[WA fast send] Green API accepted queued URL delivery", {
      chatId,
      fileName,
      instanceId: settings.instanceId,
      size: buffer.length,
      durationMs: Date.now() - startedAt,
    });
    return { success: true };
  } catch (error: unknown) {
    deleteFastAttachment(token);
    const message = getErrorMessage(error) || "WhatsApp provider request timed out";
    logger.error("[WA fast send] URL delivery failed", {
      chatId,
      fileName,
      instanceId: settings.instanceId,
      size: buffer.length,
      durationMs: Date.now() - startedAt,
      error,
    });
    return { success: false, error: message };
  }
}

async function sendBufferFast(
  req: Request,
  chatId: string,
  buffer: Buffer,
  fileName: string,
  caption: string,
  contentType = "application/pdf"
): Promise<{ success: boolean; error?: string; mode: "url" | "upload" }> {
  const publicBaseUrl = resolvePublicBaseUrl(req);
  const settings = await getPosWaSettings();
  if (!settings?.instanceId || !settings?.apiToken) {
    return { success: false, error: "WhatsApp credentials not configured", mode: "upload" };
  }
  if (!settings.enabled) {
    return { success: false, error: "WhatsApp sending is disabled", mode: "upload" };
  }

  // Prefer multipart upload because Green API receives the actual file bytes in
  // the same request. The URL fast path only means "queued" and may fetch the
  // temporary file much later, which previously produced false-success results
  // when the capability URL had already expired.
  const uploadPrimary = await sendWhatsAppFileByUploadPos(chatId, buffer, fileName, caption, contentType);
  if (uploadPrimary.success) {
    logger.info("[WA fast send] Green API accepted direct upload", {
      chatId,
      fileName,
      instanceId: settings.instanceId,
      size: buffer.length,
    });
    return { success: true, mode: "upload" };
  }

  logger.warn("[WA fast send] Direct upload failed; trying URL fallback", {
    chatId,
    fileName,
    instanceId: settings.instanceId,
    uploadError: uploadPrimary.error,
  });

  if (!publicBaseUrl) {
    return {
      success: false,
      error: uploadPrimary.error || "WhatsApp direct upload failed and no public fallback URL is available",
      mode: "upload",
    };
  }

  const primaryAttempt = await sendFileByUrlAttempt({
    publicBaseUrl,
    settings,
    chatId,
    buffer,
    fileName,
    caption,
    contentType,
  });
  if (primaryAttempt.success) return { success: true, mode: "url" };

  logger.warn("[WA fast send] URL fallback rejected", {
    chatId,
    fileName,
    instanceId: settings.instanceId,
    status: primaryAttempt.status,
    quotaFailure: isGreenApiQuotaFailure(primaryAttempt.status, primaryAttempt.body),
  });

  // Green API's Developer plan can return HTTP 466 when the active instance has
  // exhausted its allowed correspondents. If a second ERP WhatsApp instance is
  // configured, try it immediately before giving up.
  if (isGreenApiQuotaFailure(primaryAttempt.status, primaryAttempt.body)) {
    const [mainSettings, posSettings] = await Promise.all([getWaSettingsById(1), getWaSettingsById(2)]);
    const alternate = [mainSettings, posSettings].find(
      (candidate) =>
        !!candidate?.instanceId &&
        !!candidate?.apiToken &&
        candidate.instanceId !== settings.instanceId &&
        candidate.apiToken !== settings.apiToken
    );

    if (alternate?.instanceId && alternate.apiToken) {
      const alternateAttempt = await sendFileByUrlAttempt({
        publicBaseUrl,
        settings: alternate,
        chatId,
        buffer,
        fileName,
        caption,
        contentType,
      });
      if (alternateAttempt.success) {
        logger.warn("[WA fast send] Queued URL fallback through alternate WhatsApp instance", {
          chatId,
          fileName,
          primaryInstanceId: settings.instanceId,
          alternateInstanceId: alternate.instanceId,
        });
        return { success: true, mode: "url" };
      }
    }
  }

  return {
    success: false,
    error: formatGreenApiFailure(primaryAttempt, uploadPrimary.error),
    mode: "url",
  };
}

function serveFastAttachment(req: Request, res: Response): void {
  const entry = fastAttachments.get(req.params.token);
  if (!entry || entry.expiresAt <= Date.now()) {
    if (entry) fastAttachments.delete(req.params.token);
    logger.warn("[WA fast send] Provider requested an expired or missing attachment", {
      method: req.method,
      tokenPrefix: req.params.token?.slice(0, 8),
    });
    res.status(404).end();
    return;
  }

  res.setHeader("Content-Type", entry.contentType);
  res.setHeader("Content-Length", String(entry.buffer.length));
  res.setHeader("Content-Disposition", `inline; filename="${entry.fileName.replace(/[\r\n"]/g, "_")}"`);
  res.setHeader("Cache-Control", "private, no-store, max-age=0");
  res.setHeader("X-Content-Type-Options", "nosniff");
  logger.info("[WA fast send] Provider fetched queued attachment", {
    method: req.method,
    fileName: entry.fileName,
    size: entry.buffer.length,
    tokenPrefix: req.params.token?.slice(0, 8),
  });
  if (req.method === "HEAD") {
    res.status(200).end();
    return;
  }
  res.status(200).send(entry.buffer);
}

async function resolvePosLocationId(req: Request, companyId: number): Promise<number | null> {
  const requested = Number(req.body?.locationId);
  if (Number.isInteger(requested) && requested > 0) return requested;

  const userId = req.session.userId;
  if (!userId) return null;
  const [role] = await db
    .select({ assignedLocationId: userCompanyRoles.assignedLocationId })
    .from(userCompanyRoles)
    .where(and(eq(userCompanyRoles.userId, userId), eq(userCompanyRoles.companyId, companyId)))
    .limit(1);
  return role?.assignedLocationId ?? null;
}

async function sendPosStockFast(req: Request, res: Response): Promise<void> {
  const startedAt = Date.now();
  try {
    const companyId = req.session.currentCompanyId;
    if (!companyId) {
      res.status(400).json({ message: "No company selected" });
      return;
    }

    const locationId = await resolvePosLocationId(req, companyId);
    if (!locationId) {
      res.status(400).json({ message: "No location found for this user" });
      return;
    }

    const [location, company] = await Promise.all([
      db
        .select({ id: locations.id, name: locations.name, whatsappGroupChatId: locations.whatsappGroupChatId })
        .from(locations)
        .where(and(eq(locations.id, locationId), eq(locations.companyId, companyId)))
        .limit(1)
        .then((rows) => rows[0]),
      db
        .select({ name: companies.name })
        .from(companies)
        .where(eq(companies.id, companyId))
        .limit(1)
        .then((rows) => rows[0]),
    ]);

    if (!location) {
      res.status(404).json({ message: "Location not found" });
      return;
    }
    if (!location.whatsappGroupChatId) {
      res.status(400).json({ message: "No WhatsApp group configured for this location" });
      return;
    }

    const companyName = company?.name || "Company";
    const {
      buffer: pdfBuffer,
      pageCount,
      rowCount,
    } = await generateStockPdf(companyId, companyName, locationId, location.name);

    const maxAllowedPages = Math.ceil(rowCount / 20) + 5;
    if (pageCount > maxAllowedPages) {
      res.status(500).json({
        message: `PDF pagination error detected: ${pageCount} pages generated for ${rowCount} stock items (expected ≤${maxAllowedPages}). Report not sent to WhatsApp.`,
      });
      return;
    }

    const dateStr = getClientDate(req);
    const safeName = `${location.name} STK ${companyName} ${dateStr}`.replace(/[^\w\s.()-]/g, "_").trim();
    const caption = `Stock Report — ${location.name}`;
    const result = await sendBufferFast(
      req,
      location.whatsappGroupChatId,
      pdfBuffer,
      `${safeName}.pdf`,
      caption,
      "application/pdf"
    );

    if (!result.success) {
      res.status(502).json({ message: result.error ?? "WhatsApp send failed" });
      return;
    }

    logger.info("POS stock WhatsApp send accepted", {
      module: "whatsappFastSend",
      action: "sendStock",
      companyId,
      locationId,
      mode: result.mode,
      durationMs: Date.now() - startedAt,
    });
    res.json({ success: true, deliveryMode: result.mode, deliveryStatus: "accepted" });
  } catch (error: unknown) {
    logger.error("[WA fast stock] failed", { error });
    res.status(500).json({ message: getErrorMessage(error) });
  }
}

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

async function sendUploadedPdfFast(req: Request, res: Response): Promise<void> {
  try {
    const companyId = req.session.currentCompanyId;
    if (!companyId) {
      res.status(400).json({ message: "No company selected" });
      return;
    }

    const pdfBase64 = String(req.body?.pdfBase64 || "");
    const locationId = Number(req.body?.locationId);
    if (!pdfBase64) {
      res.status(400).json({ message: "pdfBase64 is required" });
      return;
    }
    if (!Number.isInteger(locationId) || locationId <= 0) {
      res.status(400).json({ message: "locationId is required" });
      return;
    }

    const [location] = await db
      .select({ whatsappGroupChatId: locations.whatsappGroupChatId })
      .from(locations)
      .where(and(eq(locations.id, locationId), eq(locations.companyId, companyId)))
      .limit(1);
    if (!location) {
      res.status(404).json({ message: "Location not found" });
      return;
    }
    if (!location.whatsappGroupChatId) {
      res.status(400).json({ message: "No WhatsApp group configured for this location" });
      return;
    }

    const buffer = Buffer.from(pdfBase64, "base64");
    const fileName = String(req.body?.filename || "report.pdf").replace(/[^\w\s.()-]/g, "_");
    const caption = String(req.body?.caption || fileName);
    const result = await sendBufferFast(req, location.whatsappGroupChatId, buffer, fileName, caption);
    if (!result.success) {
      res.status(502).json({ message: result.error ?? "WhatsApp send failed" });
      return;
    }
    res.json({ success: true, deliveryMode: result.mode, deliveryStatus: "accepted" });
  } catch (error: unknown) {
    logger.error("[WA fast uploaded PDF] failed", { error });
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
