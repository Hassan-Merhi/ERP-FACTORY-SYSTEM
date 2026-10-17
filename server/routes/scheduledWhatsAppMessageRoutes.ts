import type { Express, Request, Response } from "express";
import { requireAuth } from "../auth";
import { pool } from "../db";
import { getErrorMessage } from "../lib/httpHandlers";
import { ensureScheduledWhatsAppMessageSchema, parseWeeklyTimes } from "../services/scheduledWhatsAppMessages";

const managerRoles = new Set(["Admin", "Owner", "Developer"]);

function companyForManager(req: Request, res: Response): number | null {
  if (!managerRoles.has(req.session.currentRole || "")) {
    res.status(403).json({ message: "Only Admin, Owner or Developer can manage scheduled WhatsApp messages" });
    return null;
  }
  const id = Number(req.session.currentCompanyId);
  if (!Number.isSafeInteger(id) || id < 1) {
    res.status(400).json({ message: "Choose a company first" });
    return null;
  }
  return id;
}

function parseScheduleBody(body: unknown) {
  const input: Record<string, unknown> = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const title = String(input.title ?? "").trim();
  const message = String(input.message ?? "").trim();
  if (!title || title.length > 120) throw new Error("Title is required (maximum 120 characters)");
  if (!message || message.length > 4000) throw new Error("Message must be 1–4000 characters");
  const timezone = String(input.timezone ?? "Asia/Beirut").trim();
  if (!timezone || timezone.length > 80) throw new Error("Invalid timezone");
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
  } catch {
    throw new Error("Choose a valid timezone (e.g. Asia/Beirut)");
  }
  const weeklyTimes = parseWeeklyTimes(input.weeklyTimes);
  const startDate = input.startDate || null;
  const endDate = input.endDate || null;
  const validDate = (date: unknown): date is string | null =>
    date === null || (typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date) && !Number.isNaN(Date.parse(date)));
  if (!validDate(startDate) || !validDate(endDate) || (startDate && endDate && startDate > endDate)) {
    throw new Error("Invalid start or end date");
  }
  const rawRecipientIds = input.recipientIds;
  if (
    !Array.isArray(rawRecipientIds) ||
    rawRecipientIds.length < 1 ||
    rawRecipientIds.length > 50 ||
    rawRecipientIds.some((id: unknown) => !Number.isSafeInteger(Number(id)) || Number(id) <= 0)
  ) {
    throw new Error("Select between 1 and 50 WhatsApp groups");
  }
  const recipientIds = [...new Set<number>(rawRecipientIds.map(Number))];
  const enabled = input.enabled;
  if (typeof enabled !== "boolean") throw new Error("Enabled must be true or false");
  return { title, message, timezone, weeklyTimes, startDate, endDate, recipientIds, enabled };
}

export function registerScheduledWhatsAppMessageRoutes(app: Express): void {
  app.get("/api/whatsapp/message-schedules", requireAuth, async (req, res) => {
    const companyId = companyForManager(req, res);
    if (!companyId) return;
    try {
      await ensureScheduledWhatsAppMessageSchema();
      const result = await pool.query(
        "SELECT s.id::text, s.title, s.message, s.timezone, s.weekly_times, " +
          "s.start_date::text, s.end_date::text, s.enabled, s.created_at, s.updated_at, " +
          "COALESCE(array_agg(sr.recipient_id) FILTER (WHERE sr.recipient_id IS NOT NULL), ARRAY[]::integer[]) AS recipient_ids " +
          "FROM whatsapp_message_schedules s " +
          "LEFT JOIN whatsapp_message_schedule_recipients sr ON sr.schedule_id = s.id " +
          "WHERE s.company_id = $1 GROUP BY s.id ORDER BY s.updated_at DESC",
        [companyId]
      );
      res.json(
        result.rows.map((r) => ({
          id: r.id,
          title: r.title,
          message: r.message,
          timezone: r.timezone,
          weeklyTimes: r.weekly_times,
          startDate: r.start_date,
          endDate: r.end_date,
          enabled: r.enabled,
          recipientIds: r.recipient_ids,
          updatedAt: r.updated_at,
        }))
      );
    } catch (err) {
      res.status(500).json({ message: getErrorMessage(err) });
    }
  });

  app.get("/api/whatsapp/message-schedules/history", requireAuth, async (req, res) => {
    const companyId = companyForManager(req, res);
    if (!companyId) return;
    try {
      await ensureScheduledWhatsAppMessageSchema();
      const result = await pool.query(
        "SELECT d.id::text, s.title, d.recipient_name, d.local_date::text, " +
          "d.status, d.error, d.sent_at, d.created_at " +
          "FROM whatsapp_message_schedule_deliveries d " +
          "JOIN whatsapp_message_schedules s ON s.id = d.schedule_id " +
          "WHERE s.company_id = $1 ORDER BY d.created_at DESC LIMIT 100",
        [companyId]
      );
      res.json(
        result.rows.map((r) => ({
          id: r.id,
          title: r.title,
          recipientName: r.recipient_name,
          localDate: r.local_date,
          status: r.status,
          error: r.error,
          sentAt: r.sent_at,
          createdAt: r.created_at,
        }))
      );
    } catch (err) {
      res.status(500).json({ message: getErrorMessage(err) });
    }
  });

  async function save(req: Request, res: Response, id?: number) {
    const companyId = companyForManager(req, res);
    if (!companyId) return;
    let form: ReturnType<typeof parseScheduleBody>;
    try {
      form = parseScheduleBody(req.body);
    } catch (err) {
      return res.status(400).json({ message: getErrorMessage(err) });
    }
    let client;
    try {
      await ensureScheduledWhatsAppMessageSchema();
      client = await pool.connect();
      await client.query("BEGIN");
      const validRecipients = await client.query(
        "SELECT id FROM whatsapp_recipients WHERE company_id = $1 AND active = true " +
          "AND is_group = true AND id = ANY($2::integer[])",
        [companyId, form.recipientIds]
      );
      if (validRecipients.rows.length !== form.recipientIds.length) {
        await client.query("ROLLBACK");
        return res.status(400).json({ message: "One or more selected groups are not active in this company" });
      }
      const values = [
        companyId,
        form.title,
        form.message,
        form.timezone,
        JSON.stringify(form.weeklyTimes),
        form.startDate,
        form.endDate,
        form.enabled,
      ];
      const schedule =
        id === undefined
          ? await client.query(
              "INSERT INTO whatsapp_message_schedules " +
                "(company_id, title, message, timezone, weekly_times, start_date, end_date, enabled) " +
                "VALUES ($1,$2,$3,$4,$5::jsonb,$6::date,$7::date,$8) RETURNING id",
              values
            )
          : await client.query(
              "UPDATE whatsapp_message_schedules SET title=$2, message=$3, timezone=$4, " +
                "weekly_times=$5::jsonb, start_date=$6::date, end_date=$7::date, enabled=$8, updated_at=now() " +
                "WHERE id=$9 AND company_id=$1 RETURNING id",
              [...values, id]
            );
      if (!schedule.rowCount) {
        await client.query("ROLLBACK");
        return res.status(404).json({ message: "Schedule not found for this company" });
      }
      const scheduleId = schedule.rows[0].id;
      await client.query("DELETE FROM whatsapp_message_schedule_recipients WHERE schedule_id = $1", [scheduleId]);
      for (const recipientId of form.recipientIds) {
        await client.query(
          "INSERT INTO whatsapp_message_schedule_recipients (schedule_id, recipient_id) VALUES ($1, $2)",
          [scheduleId, recipientId]
        );
      }
      await client.query("COMMIT");
      res.json({ id: String(scheduleId), message: id === undefined ? "Schedule created" : "Schedule updated" });
    } catch (err) {
      if (client) await client.query("ROLLBACK").catch(() => undefined);
      res.status(500).json({ message: getErrorMessage(err) });
    } finally {
      client?.release();
    }
  }

  app.post("/api/whatsapp/message-schedules", requireAuth, async (req, res) => {
    await save(req, res);
  });
  app.put("/api/whatsapp/message-schedules/:id", requireAuth, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id <= 0) return res.status(400).json({ message: "Invalid schedule" });
    await save(req, res, id);
  });
  app.delete("/api/whatsapp/message-schedules/:id", requireAuth, async (req, res) => {
    const companyId = companyForManager(req, res);
    if (!companyId) return;
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id <= 0) return res.status(400).json({ message: "Invalid schedule" });
    try {
      await ensureScheduledWhatsAppMessageSchema();
      const deleted = await pool.query(
        "DELETE FROM whatsapp_message_schedules WHERE id=$1 AND company_id=$2 RETURNING id",
        [id, companyId]
      );
      if (!deleted.rowCount) return res.status(404).json({ message: "Schedule not found" });
      res.json({ message: "Schedule removed" });
    } catch (err) {
      res.status(500).json({ message: getErrorMessage(err) });
    }
  });
}
