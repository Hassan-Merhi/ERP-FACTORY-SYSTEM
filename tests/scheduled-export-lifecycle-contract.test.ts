import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("Phase 10 scheduled export lifecycle", () => {
  it("builds the daily scheduled export once on disk and disposes it", () => {
    const daily = source("server/services/scheduler/daily-export.ts");

    expect(daily).toContain("createScheduledExportArtifact");
    expect(daily).toContain("const { attachment, names, skipped, sizeBytes } = artifact");
    expect(daily).toContain("sendExportEmail(attachment");
    expect(daily).toContain("runDailyWhatsAppSend(attachment");
    expect(daily).toContain("await artifact.dispose()");
    expect(daily).not.toContain("buildFullExportZip(companies, exportFromDate");
  });

  it("uses a file-backed lifecycle for manual email exports", () => {
    const routes = source("server/routes/exportRoutes.ts");

    expect(routes).toContain("createScheduledExportArtifact");
    expect(routes).toContain("`manual-email-${job.id}`");
    expect(routes).toContain("sendExportEmail(attachment");
    expect(routes).toContain("await artifact.dispose()");
    expect(routes).not.toContain("Email providers require complete attachment bytes");
  });

  it("materializes only file-backed WhatsApp exports through one queue", () => {
    const attachment = source("server/helpers/exportAttachmentSource.ts");
    const whatsapp = source("server/services/whatsappService.ts");
    const scheduledSend = source("server/services/scheduler/whatsapp-send.ts");

    expect(attachment).toContain("withSerializedExportAttachmentBuffer");
    expect(attachment).toContain("if (!getFileAttachment(source))");
    expect(attachment).toContain("const previous = materializationTail");
    expect(whatsapp).toContain("buffer: ExportAttachmentSource");
    expect(whatsapp).toContain("withSerializedExportAttachmentBuffer(buffer");
    expect(whatsapp).toContain("const multipartBody = form.getBuffer()");
    expect(scheduledSend).toContain("dailyZip: ExportAttachmentSource");
    expect(scheduledSend).toContain("getExportAttachmentSize(dailyZip)");
  });

  it("releases scheduled PDF, workbook and net-position archive markers", () => {
    const stock = source("server/services/scheduler/stock-report.ts");

    expect(stock).toContain("releaseManagedExportAttachment(pdfBuf)");
    expect(stock).toContain("releaseManagedExportAttachment(xlsBuf)");
    expect(stock).toContain("releaseManagedExportAttachment(zipBuf)");
  });

  it("keeps sequential email delivery and file-path Nodemailer attachments", () => {
    const email = source("server/services/emailService.ts");
    const attachment = source("server/helpers/exportAttachmentSource.ts");

    expect(email).toContain("for (const recipient of recipients)");
    expect(email).toContain("toNodemailerAttachment");
    expect(email).toContain("transporter.close()");
    expect(attachment).toContain("return { filename, contentType, path: file.filePath }");
  });
});
