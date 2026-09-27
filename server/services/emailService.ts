import nodemailer from "nodemailer";
import { getErrorMessage } from "../lib/httpHandlers";
import { logger } from "../lib/logger";
import { pool } from "../db";
import {
  assertExportAttachmentAvailable,
  getExportAttachmentSize,
  toNodemailerAttachment,
  type ExportAttachmentSource,
} from "../helpers/exportAttachmentSource";

export interface EmailSettings {
  gmailUser: string;
  gmailAppPassword: string;
}

async function getSettings(): Promise<EmailSettings | null> {
  try {
    const res = await pool.query(`SELECT gmail_user, gmail_app_password FROM export_settings WHERE id = 1`);
    if (!res.rows || res.rows.length === 0) return null;
    const row = res.rows[0];
    if (!row.gmail_user || !row.gmail_app_password) return null;
    return { gmailUser: row.gmail_user, gmailAppPassword: row.gmail_app_password };
  } catch {
    return null;
  }
}

async function getRecipients(): Promise<string[]> {
  try {
    const res = await pool.query(`SELECT email FROM export_recipients WHERE active = true ORDER BY id`);
    return (res.rows || []).map((r) => r.email).filter(Boolean);
  } catch {
    return [];
  }
}

export async function sendExportEmail(
  attachmentSource: ExportAttachmentSource,
  dateLabel: string,
  companyNames: string[]
): Promise<{ success: boolean; error?: string }> {
  const settings = await getSettings();
  if (!settings) return { success: false, error: "Email not configured — no Gmail credentials found." };

  const recipients = await getRecipients();
  if (recipients.length === 0) return { success: false, error: "No email recipients configured." };

  try {
    await assertExportAttachmentAvailable(attachmentSource);
  } catch (error: unknown) {
    return { success: false, error: getErrorMessage(error) || "Export attachment is unavailable." };
  }

  // Gmail attachment limit is 25MB — reject before opening an SMTP connection.
  const sizeBytes = getExportAttachmentSize(attachmentSource);
  const sizeMB = sizeBytes / 1024 / 1024;
  if (sizeMB > 24) {
    return {
      success: false,
      error: `ZIP file is ${sizeMB.toFixed(1)} MB — exceeds Gmail's 25 MB attachment limit. Split the export by date range or contact your admin.`,
    };
  }

  const transporter = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 587,
    secure: false,
    auth: { user: settings.gmailUser, pass: settings.gmailAppPassword },
    tls: { rejectUnauthorized: true },
    // Scheduled exports must never hold their cron guard forever when Gmail or
    // the network stops responding. These timeouts bound connect, greeting,
    // and in-flight SMTP socket waits while still allowing large attachments.
    connectionTimeout: 30_000,
    greetingTimeout: 30_000,
    socketTimeout: 120_000,
  });

  // Verify the connection before sending.
  try {
    await transporter.verify();
  } catch (verifyErr: unknown) {
    transporter.close();
    return {
      success: false,
      error: `Gmail authentication failed: ${getErrorMessage(verifyErr)}. Check your Gmail address and App Password in settings.`,
    };
  }

  const companiesList = companyNames.map((n) => `  - ${n}`).join("\n");
  const subject = `[ERP Export] Daily Data Export — ${dateLabel}`;
  const text = `Hello,

Please find the attached daily full data export for ${dateLabel} (${sizeMB.toFixed(1)} MB).

Companies included:
${companiesList}

This export contains all accounts, transactions, inventory, payroll, containers, factory operations, and all other operational data for each company.

Note: If you did not receive the attachment, it may have been filtered by your email provider or caught by a spam filter — please check your spam/junk folder.

Generated automatically at ${new Date().toUTCString()}.

— ERP System`;

  const attachment = toNodemailerAttachment(attachmentSource, `DailyExport_${dateLabel}.zip`, "application/zip");

  let sent = 0;
  const errors: string[] = [];

  try {
    // Send sequentially. Parallel sends caused Nodemailer to retain multiple MIME
    // encodings of the same large attachment at once. A file-path source is read
    // as a stream for each recipient and a Buffer source is reused without copies.
    for (const recipient of recipients) {
      try {
        await transporter.sendMail({
          from: `"ERP Daily Export" <${settings.gmailUser}>`,
          to: recipient,
          subject,
          text,
          attachments: [attachment],
        });
        sent += 1;
      } catch (error: unknown) {
        const message = getErrorMessage(error) || String(error);
        errors.push(`${recipient}: ${message}`);
        logger.warn(`[EmailService] Export email failed for ${recipient}: ${message}`);
      }
    }

    if (sent === 0) {
      return { success: false, error: errors[0] || "All emails failed to send." };
    }

    if (errors.length > 0) {
      logger.warn(`[EmailService] ${errors.length}/${recipients.length} emails failed to deliver.`);
    }

    return { success: true };
  } finally {
    transporter.close();
  }
}
