import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");
const failures = [];

function requireAll(relativePath, values) {
  const contents = read(relativePath);
  for (const value of values) {
    if (!contents.includes(value)) failures.push(`${relativePath}: missing ${value}`);
  }
  return contents;
}

const attachment = requireAll("server/helpers/exportAttachmentSource.ts", [
  "ExportAttachmentSource",
  "getExportAttachmentSize",
  "toNodemailerAttachment",
  "assertExportAttachmentAvailable",
  "withSerializedExportAttachmentBuffer",
  "if (!getFileAttachment(source))",
  "const previous = materializationTail",
]);
if (attachment.includes("work(requireBufferSource(source))") === false) {
  failures.push("exportAttachmentSource.ts: ordinary Buffer path is not preserved");
}

const artifact = requireAll("server/helpers/scheduledExportArtifact.ts", [
  "createScheduledExportArtifact",
  "createTemporaryExportArchive",
  "attachment: { filePath: archive.filePath, sizeBytes: archive.bytesWritten }",
  "dispose: () => Promise<void>",
  "await releaseTemporaryExportArchive(archive.filePath)",
  "withScheduledExportArtifact",
]);
if (!artifact.includes("finally")) failures.push("scheduledExportArtifact.ts: missing deterministic finally cleanup");

const email = requireAll("server/services/emailService.ts", [
  "attachmentSource: ExportAttachmentSource",
  "assertExportAttachmentAvailable(attachmentSource)",
  "getExportAttachmentSize(attachmentSource)",
  "toNodemailerAttachment",
  "for (const recipient of recipients)",
  "transporter.close()",
]);
if (email.includes("Promise.all(recipients")) failures.push("emailService.ts: recipients are still sent concurrently");

const whatsapp = requireAll("server/services/whatsappService.ts", [
  "buffer: ExportAttachmentSource",
  "getExportAttachmentSize(buffer)",
  "withSerializedExportAttachmentBuffer(buffer",
  "const multipartBody = form.getBuffer()",
]);

const daily = requireAll("server/services/scheduler/daily-export.ts", [
  "createScheduledExportArtifact",
  "const { attachment, names, skipped, sizeBytes } = artifact",
  "sendExportEmail(attachment",
  "runDailyWhatsAppSend(attachment",
  "await artifact.dispose()",
]);
if (daily.includes("buildFullExportZip(companies, exportFromDate")) {
  failures.push("daily-export.ts: scheduled daily ZIP still uses buffered builder");
}

const manual = requireAll("server/routes/exportRoutes.ts", [
  "createScheduledExportArtifact",
  "`manual-email-${job.id}`",
  "sendExportEmail(attachment",
  "await artifact.dispose()",
]);
if (manual.includes("Email providers require complete attachment bytes")) {
  failures.push("exportRoutes.ts: manual email still documents buffered compatibility path");
}

requireAll("server/services/scheduler/whatsapp-send.ts", [
  "dailyZip: ExportAttachmentSource",
  "getExportAttachmentSize(dailyZip)",
  "sendWhatsAppFileToChatId(chatId, dailyZip",
]);

requireAll("server/services/scheduler/stock-report.ts", [
  "releaseManagedExportAttachment(pdfBuf)",
  "releaseManagedExportAttachment(xlsBuf)",
  "releaseManagedExportAttachment(zipBuf)",
]);

for (const requiredPath of [
  "scripts/verify-scheduled-attachments.mjs",
  "tests/scheduled-export-lifecycle-contract.test.ts",
]) {
  if (!fs.existsSync(path.join(root, requiredPath))) failures.push(`missing ${requiredPath}`);
}

const docs = read("docs/archive/engineering/phase10-scheduled-export-memory.md");
for (const phrase of [
  "Explicit daily export lifecycle",
  "Manual email export lifecycle",
  "Serialized WhatsApp materialization",
  "Deterministic cleanup",
  "Compatibility bridge",
  "Deferred verification",
  "Merge order",
]) {
  if (!docs.includes(phrase)) failures.push(`phase10 documentation: missing ${phrase}`);
}

if (failures.length > 0) {
  console.error("Phase 10 scheduled export lifecycle verification failed:");
  for (const failure of failures) console.error(` - ${failure}`);
  process.exit(1);
}

console.log("Phase 10 scheduled export lifecycle contracts verified.");
