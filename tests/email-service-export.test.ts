/**
 * The daily export email: Gmail settings and recipients read from
 * PostgreSQL (in a rolled-back transaction), the attachment checks, the SMTP
 * verify step and per-recipient sends. Nodemailer is stubbed.
 */
import type { PoolClient } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withRolledBackPool } from "./helpers/routedPoolClient";

const h = vi.hoisted(() => ({
  verify: vi.fn(),
  send: vi.fn(),
  close: vi.fn(),
  createTransport: vi.fn(),
}));
vi.mock("nodemailer", () => ({
  default: {
    createTransport: (options: unknown) => {
      h.createTransport(options);
      return { verify: h.verify, sendMail: h.send, close: h.close };
    },
  },
}));

import { logger } from "../server/lib/logger";
import { sendExportEmail } from "../server/services/emailService";

const ZIP = Buffer.alloc(1536 * 1024, 1);

async function configure(
  client: PoolClient,
  settings: { user?: string; password?: string } | null,
  recipients: Array<[string, boolean]>
) {
  await client.query("DELETE FROM export_settings");
  await client.query("DELETE FROM export_recipients");
  if (settings) {
    await client.query("INSERT INTO export_settings(id,gmail_user,gmail_app_password) VALUES(1,$1,$2)", [
      settings.user ?? "erp@example.test",
      settings.password ?? "app-pass",
    ]);
  }
  for (const [email, active] of recipients) {
    await client.query("INSERT INTO export_recipients(email,active) VALUES($1,$2)", [email, active]);
  }
}

beforeEach(() => {
  h.verify.mockReset().mockResolvedValue(true);
  h.send.mockReset().mockResolvedValue({ messageId: "m" });
  h.close.mockReset();
  h.createTransport.mockReset();
  vi.spyOn(logger, "warn").mockImplementation(() => logger);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("sendExportEmail", () => {
  it("verifies Gmail and sends the ZIP to each active recipient in order", async () => {
    await withRolledBackPool(async (client) => {
      await configure(client, {}, [
        ["first@example.test", true],
        ["off@example.test", false],
        ["second@example.test", true],
      ]);
      await expect(sendExportEmail(ZIP, "2026-10-20", ["Acme", "Beta"])).resolves.toEqual({ success: true });
      expect(h.createTransport).toHaveBeenCalledWith({
        host: "smtp.gmail.com",
        port: 587,
        secure: false,
        auth: { user: "erp@example.test", pass: "app-pass" },
        tls: { rejectUnauthorized: true },
        connectionTimeout: 30_000,
        greetingTimeout: 30_000,
        socketTimeout: 120_000,
      });
      expect(h.send.mock.calls.map(([mail]) => mail.to)).toEqual(["first@example.test", "second@example.test"]);
      const mail = h.send.mock.calls[0][0];
      expect(mail).toMatchObject({
        from: '"ERP Daily Export" <erp@example.test>',
        subject: "[ERP Export] Daily Data Export — 2026-10-20",
        attachments: [{ filename: "DailyExport_2026-10-20.zip", contentType: "application/zip", content: ZIP }],
      });
      expect(mail.text).toContain("daily full data export for 2026-10-20 (1.5 MB)");
      expect(mail.text).toContain("Companies included:\n  - Acme\n  - Beta\n");
      expect(h.close).toHaveBeenCalledTimes(1);
      expect(logger.warn).not.toHaveBeenCalled();
    });
  });

  it("needs complete Gmail credentials and at least one active recipient", async () => {
    await withRolledBackPool(async (client) => {
      const notConfigured = { success: false, error: "Email not configured — no Gmail credentials found." };
      await configure(client, null, [["a@example.test", true]]);
      await expect(sendExportEmail(ZIP, "d", [])).resolves.toEqual(notConfigured);
      await configure(client, { user: "" }, [["a@example.test", true]]);
      await expect(sendExportEmail(ZIP, "d", [])).resolves.toEqual(notConfigured);
      await configure(client, { password: "" }, [["a@example.test", true]]);
      await expect(sendExportEmail(ZIP, "d", [])).resolves.toEqual(notConfigured);
      await configure(client, {}, [["off@example.test", false]]);
      await expect(sendExportEmail(ZIP, "d", [])).resolves.toEqual({
        success: false,
        error: "No email recipients configured.",
      });
      expect(h.createTransport).not.toHaveBeenCalled();
    });
  });

  it("treats unreadable settings or recipients as not configured", async () => {
    await withRolledBackPool(async (client) => {
      await configure(client, {}, [["a@example.test", true]]);
      // DDL is transactional: each hidden table comes back with the rollback.
      await client.query("SAVEPOINT hide");
      await client.query("ALTER TABLE export_settings RENAME TO export_settings_hidden");
      await expect(sendExportEmail(ZIP, "d", [])).resolves.toMatchObject({
        error: "Email not configured — no Gmail credentials found.",
      });
      await client.query("ROLLBACK TO SAVEPOINT hide");
      await client.query("ALTER TABLE export_recipients RENAME TO export_recipients_hidden");
      await expect(sendExportEmail(ZIP, "d", [])).resolves.toMatchObject({ error: "No email recipients configured." });
    });
  });

  it("refuses an empty or missing attachment and one over Gmail's limit before connecting", async () => {
    await withRolledBackPool(async (client) => {
      await configure(client, {}, [["a@example.test", true]]);
      await expect(sendExportEmail(Buffer.alloc(0), "d", [])).resolves.toEqual({
        success: false,
        error: "Export attachment is empty",
      });
      // A file source must be a managed export file.
      const missing = await sendExportEmail({ filePath: "/nonexistent/export.zip", sizeBytes: 10 }, "d", []);
      expect(missing).toEqual({ success: false, error: "EXPORT_PATH_ERR" });

      await expect(sendExportEmail(Buffer.alloc(24 * 1024 * 1024, 1), "d", [])).resolves.toEqual({ success: true });
      const big = await sendExportEmail(Buffer.alloc(24 * 1024 * 1024 + 1, 1), "d", []);
      expect(big).toEqual({
        success: false,
        error:
          "ZIP file is 24.0 MB — exceeds Gmail's 25 MB attachment limit. Split the export by date range or contact your admin.",
      });
      expect(h.createTransport).toHaveBeenCalledTimes(1);
    });
  });

  it("reports a failed Gmail login and closes the connection", async () => {
    await withRolledBackPool(async (client) => {
      await configure(client, {}, [["a@example.test", true]]);
      h.verify.mockRejectedValueOnce(new Error("Invalid login"));
      await expect(sendExportEmail(ZIP, "d", [])).resolves.toEqual({
        success: false,
        error: "Gmail authentication failed: Invalid login. Check your Gmail address and App Password in settings.",
      });
      expect(h.send).not.toHaveBeenCalled();
      expect(h.close).toHaveBeenCalledTimes(1);
    });
  });

  it("succeeds when some recipients get the email and fails only when none do", async () => {
    await withRolledBackPool(async (client) => {
      await configure(client, {}, [
        ["a@example.test", true],
        ["b@example.test", true],
      ]);
      h.send.mockRejectedValueOnce(new Error("Mailbox full"));
      await expect(sendExportEmail(ZIP, "d", [])).resolves.toEqual({ success: true });
      expect(logger.warn).toHaveBeenCalledWith("[EmailService] Export email failed for a@example.test: Mailbox full");
      expect(logger.warn).toHaveBeenCalledWith("[EmailService] 1/2 emails failed to deliver.");

      h.send.mockRejectedValueOnce(new Error("Rate limited")).mockRejectedValueOnce("");
      await expect(sendExportEmail(ZIP, "d", [])).resolves.toEqual({
        success: false,
        error: "a@example.test: Rate limited",
      });
      expect(logger.warn).toHaveBeenCalledWith(
        "[EmailService] Export email failed for b@example.test: Unexpected server error"
      );
      expect(h.close).toHaveBeenCalledTimes(2);
    });
  });
});
