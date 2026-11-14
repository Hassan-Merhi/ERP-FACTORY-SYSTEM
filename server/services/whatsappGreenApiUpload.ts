/** Green API multipart upload with serialized artifact materialization. */
import FormDataLib from "form-data";
import { getErrorMessage } from "../lib/httpHandlers";
import { logger } from "../lib/logger";
import {
  getExportAttachmentSize,
  withSerializedExportAttachmentBuffer,
  type ExportAttachmentSource,
} from "../helpers/exportAttachmentSource";
import {
  uploadGreenApiWithAuthFallback,
  type WaSettings,
  type WhatsAppSendResult,
} from "./whatsappGreenApiCore";

export async function sendGreenApiFileUpload({
  settings,
  chatId,
  buffer,
  fileName,
  caption,
  mimeType,
}: {
  settings: WaSettings;
  chatId: string;
  buffer: ExportAttachmentSource;
  fileName: string;
  caption: string;
  mimeType: string;
}): Promise<WhatsAppSendResult> {
  const sizeBytes = getExportAttachmentSize(buffer);

  return withSerializedExportAttachmentBuffer(buffer, async (materializedBuffer) => {
    // Green API still requires form-data#getBuffer(). Only the active upload
    // materializes the file-backed export; queued retries keep the reusable
    // source on disk and cannot create several multipart bodies concurrently.
    const form = new FormDataLib();
    form.append("chatId", chatId);
    if (caption) form.append("caption", caption);
    form.append("file", materializedBuffer, { filename: fileName, contentType: mimeType });

    const multipartBody = form.getBuffer();
    let response: Response;
    try {
      response = await uploadGreenApiWithAuthFallback(settings, multipartBody, form.getHeaders());
    } catch (error) {
      const message = getErrorMessage(error) || "Green API request outcome is uncertain";
      logger.error("[WA upload] Green API request outcome uncertain", {
        error: message,
        chatId,
        fileName,
        size: sizeBytes,
      });
      return { success: false, error: message, deliveryOutcome: "uncertain" };
    }

    if (!response.ok) {
      const body = await response.text();
      logger.error("[WA upload] Green API error", {
        status: response.status,
        body,
        chatId,
        fileName,
        size: sizeBytes,
      });
      return { success: false, error: `Green API ${response.status}: ${body}`, deliveryOutcome: "failed" };
    }

    const json = (await response.json().catch(() => ({}))) as unknown;
    logger.info("[WA upload] Green API response", {
      response: json,
      chatId,
      fileName,
      size: sizeBytes,
    });
    return { success: true, deliveryOutcome: "sent" };
  });
}

// ─── Send file ────────────────────────────────────────────────────────────────
