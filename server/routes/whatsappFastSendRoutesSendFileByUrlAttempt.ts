// Extracted from ./whatsappFastSendRoutes.ts to keep that module under the source-size cap.
import { randomBytes } from "crypto";
import type { Request } from "express";
import { getErrorMessage } from "../lib/httpHandlers";
import { logger } from "../lib/logger";
import { getGreenApiHost } from "../services/whatsappService";

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

export const fastAttachments = new Map<string, FastAttachment>();

function trimBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

export function resolvePublicBaseUrl(req: Request): string | null {
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

export function isGreenApiQuotaFailure(status: number | undefined, body: string | undefined): boolean {
  if (status === 466) return true;
  return /QUOTE_EXCEEDED|CORRESPONDENTS_QUOTE_EXCEEDED|CORRESPONDENTS_QUOTA_EXCEEDED/i.test(body || "");
}

export function formatGreenApiFailure(attempt: FastUrlAttempt, uploadError?: string): string {
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

export async function sendFileByUrlAttempt({
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
  const apiUrl = `${getGreenApiHost(settings.instanceId)}/waInstance${settings.instanceId}/sendFileByUrl/${settings.apiToken}`;
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
