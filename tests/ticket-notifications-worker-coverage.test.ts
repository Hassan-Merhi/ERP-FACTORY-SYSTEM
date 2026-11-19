/**
 * Ticket notification worker (server/services/ticketNotifications.ts) against
 * the real database: outbox materialisation, in-app delivery, and the
 * at-most-once email / WhatsApp sends with their refusal paths (feature flag
 * off, no consent, channel not configured, provider failure, stale claims).
 * The SMTP transport and the WhatsApp provider are mocked at the module
 * boundary; no network call is made.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const providers = vi.hoisted(() => ({
  sendMail: vi.fn(async () => ({ messageId: "m-1" })),
  close: vi.fn(),
  sendWhatsAppTextToChatId: vi.fn(async () => ({ success: true }) as { success: boolean; error?: string }),
  failNextQuery: false,
}));

vi.mock("nodemailer", () => ({
  default: { createTransport: () => ({ sendMail: providers.sendMail, close: providers.close }) },
}));
vi.mock("../server/services/whatsappService", () => ({
  sendWhatsAppTextToChatId: providers.sendWhatsAppTextToChatId,
}));

// The real pool, except that one query can be made to fail on demand.
vi.mock("../server/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../server/db")>();
  const pool = new Proxy(actual.pool, {
    get(target, property) {
      if (property === "query" && providers.failNextQuery) {
        providers.failNextQuery = false;
        return async () => {
          throw new Error("db offline");
        };
      }
      return Reflect.get(target, property);
    },
  });
  return { ...actual, pool };
});

import { pool } from "../server/db";
import { enqueueTicketOverdueReminders, runTicketNotificationTick } from "../server/services/ticketNotifications";

const TAG = `tnc${Date.now().toString(36)}`;
const ENV_KEYS = [
  "TICKET_NOTIFICATIONS_ENABLED",
  "TICKET_SMTP_HOST",
  "TICKET_SMTP_USER",
  "TICKET_SMTP_PASS",
  "TICKET_SMTP_FROM",
  "TICKET_APP_BASE_URL",
] as const;
const savedEnv: Record<string, string | undefined> = {};
let savedWa: { enabled: boolean; instance_id: string; api_token: string } | null = null;

let companyId = 0;
const users: Record<string, string> = {};
let ticketSeq = 0;

async function addUser(key: string, role: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    "INSERT INTO users(username,password) VALUES($1,'x') RETURNING id",
    [`${TAG}_${key}`]
  );
  await pool.query("INSERT INTO user_company_roles(user_id,company_id,role) VALUES($1,$2,$3)", [
    rows[0].id,
    companyId,
    role,
  ]);
  users[key] = rows[0].id;
  return rows[0].id;
}

async function addTicket(opts: { status?: string; dueAt?: string; assignee?: string } = {}): Promise<number> {
  ticketSeq += 1;
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO support_tickets(company_id,ticket_number,title,description,category,created_by,assigned_to,
       source_mode,status,due_at)
     VALUES($1,$2,'t','d','general',$3,$4,'erp',$5,COALESCE($6::timestamptz, now()+interval '1 day')) RETURNING id`,
    [
      companyId,
      `${TAG}-${ticketSeq}`,
      users.creator,
      opts.assignee ?? users.assignee,
      opts.status ?? "open",
      opts.dueAt ?? null,
    ]
  );
  return Number(rows[0].id);
}

async function addEvent(ticketId: number, eventType: string, actorId: string | null): Promise<number> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO support_ticket_outbox(company_id,ticket_id,event_key,event_type,payload)
     VALUES($1,$2,$3,$4,$5::jsonb) RETURNING id`,
    [companyId, ticketId, `${TAG}:${ticketId}:${eventType}:${Math.random()}`, eventType, JSON.stringify({ actorId })]
  );
  return Number(rows[0].id);
}

async function notifications(ticketId: number) {
  const { rows } = await pool.query<{
    recipient_user_id: string;
    channel: string;
    delivery_status: string;
    error: string | null;
  }>(
    "SELECT recipient_user_id,channel,delivery_status,error FROM support_ticket_notifications WHERE ticket_id=$1 ORDER BY id",
    [ticketId]
  );
  return rows;
}

async function tick(times = 1) {
  for (let i = 0; i < times; i += 1) await runTicketNotificationTick();
}

async function cleanup() {
  if (!companyId) return;
  await pool.query("DELETE FROM notifications WHERE company_id=$1", [companyId]);
  await pool.query("DELETE FROM support_ticket_notifications WHERE company_id=$1", [companyId]);
  await pool.query("DELETE FROM support_ticket_outbox WHERE company_id=$1", [companyId]);
  await pool.query("DELETE FROM support_ticket_participants WHERE company_id=$1", [companyId]);
  await pool.query("DELETE FROM support_ticket_notification_contacts WHERE company_id=$1", [companyId]);
  await pool.query("DELETE FROM support_tickets WHERE company_id=$1", [companyId]);
  await pool.query("DELETE FROM role_feature_permissions WHERE company_id=$1", [companyId]);
  await pool.query("DELETE FROM user_company_roles WHERE company_id=$1", [companyId]);
  await pool.query("DELETE FROM users WHERE username LIKE $1", [`${TAG}_%`]);
  await pool.query("DELETE FROM companies WHERE id=$1", [companyId]);
}

beforeAll(async () => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  const wa = await pool.query("SELECT enabled,instance_id,api_token FROM whatsapp_settings WHERE id=1");
  savedWa = wa.rows[0] ?? null;
  const { rows } = await pool.query<{ id: number }>("INSERT INTO companies(code,name) VALUES($1,$2) RETURNING id", [
    TAG.toUpperCase().slice(0, 20),
    `${TAG}_Company`,
  ]);
  companyId = rows[0].id;
  await addUser("creator", "Admin");
  await addUser("assignee", "Manager");
  await addUser("participant", "Normal User");
  await addUser("owner", "Owner");
  await addUser("outsider", "Normal User");
  await pool.query(
    "INSERT INTO role_feature_permissions(company_id,role,feature_key,enabled) VALUES($1,'Normal User','page_ticket_management',true)",
    [companyId]
  );
  await pool.query(
    `INSERT INTO support_ticket_notification_contacts(company_id,user_id,email,email_enabled,whatsapp_chat_id,whatsapp_enabled)
     VALUES($1,$2,'assignee@example.test',true,'243810000001@c.us',true),
           ($1,$3,'creator@example.test',false,NULL,false)`,
    [companyId, users.assignee, users.creator]
  );
});

afterAll(async () => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  if (savedWa) {
    await pool.query("UPDATE whatsapp_settings SET enabled=$1,instance_id=$2,api_token=$3 WHERE id=1", [
      savedWa.enabled,
      savedWa.instance_id,
      savedWa.api_token,
    ]);
  }
  await cleanup();
});

beforeEach(() => {
  process.env.TICKET_NOTIFICATIONS_ENABLED = "true";
  process.env.TICKET_SMTP_HOST = "smtp.example.test";
  process.env.TICKET_SMTP_USER = "u";
  process.env.TICKET_SMTP_PASS = "p";
  process.env.TICKET_SMTP_FROM = "erp@example.test";
  process.env.TICKET_APP_BASE_URL = "https://erp.example.test";
  providers.sendMail.mockReset().mockResolvedValue({ messageId: "m-1" });
  providers.sendWhatsAppTextToChatId.mockReset().mockResolvedValue({ success: true });
});

async function setWhatsApp(enabled: boolean) {
  await pool.query("UPDATE whatsapp_settings SET enabled=$1,instance_id=$2,api_token=$3 WHERE id=1", [
    enabled,
    enabled ? "1101" : "",
    enabled ? "tok" : "",
  ]);
}

describe("ticket notification worker", () => {
  it("does nothing while the feature flag is off", async () => {
    process.env.TICKET_NOTIFICATIONS_ENABLED = "false";
    const ticketId = await addTicket();
    const eventId = await addEvent(ticketId, "ticket_created", users.creator);
    await tick();
    const { rows } = await pool.query("SELECT processed_at FROM support_ticket_outbox WHERE id=$1", [eventId]);
    expect(rows[0].processed_at).toBeNull();
    expect(await notifications(ticketId)).toHaveLength(0);
    process.env.TICKET_NOTIFICATIONS_ENABLED = "true";
    await tick();
  });

  it("delivers in-app, emails and WhatsApps the assignee of a new ticket", async () => {
    await setWhatsApp(true);
    const ticketId = await addTicket();
    await addEvent(ticketId, "ticket_created", users.creator);
    await tick();
    const rows = await notifications(ticketId);
    expect(rows.map((r) => [r.recipient_user_id, r.channel, r.delivery_status])).toEqual([
      [users.assignee, "in_app", "delivered"],
      [users.assignee, "email", "sent"],
      [users.assignee, "whatsapp", "sent"],
    ]);
    const inbox = await pool.query("SELECT title,event_type FROM notifications WHERE entity_id=$1 AND company_id=$2", [
      ticketId,
      companyId,
    ]);
    expect(inbox.rows[0]).toMatchObject({ event_type: "TICKET_CREATED" });
    expect(providers.sendMail).toHaveBeenCalledTimes(1);
    const [chatId, text] = providers.sendWhatsAppTextToChatId.mock.calls[0] as unknown as [string, string];
    expect(chatId).toBe("243810000001@c.us");
    expect(text).toContain("assigned to you");
    // Current behaviour: support_tickets.id is a bigint that node-postgres returns as a
    // string, so ticketDestinationUrl's Number.isSafeInteger check rejects it and the
    // TICKET_APP_BASE_URL deep link is never appended (reported as a bug).
    expect(text).not.toContain("https://erp.example.test");
  });

  it("marks provider failures uncertain and never resends them", async () => {
    await setWhatsApp(true);
    providers.sendMail.mockRejectedValue(new Error("socket hang up"));
    providers.sendWhatsAppTextToChatId.mockResolvedValue({ success: false, error: "rejected" });
    const ticketId = await addTicket();
    await addEvent(ticketId, "ticket_reopen", users.creator);
    await tick(2);
    const rows = await notifications(ticketId);
    expect(rows.find((r) => r.channel === "email")).toMatchObject({ delivery_status: "uncertain" });
    expect(rows.find((r) => r.channel === "whatsapp")).toMatchObject({ delivery_status: "uncertain" });
    expect(providers.sendMail).toHaveBeenCalledTimes(1);
    expect(providers.sendWhatsAppTextToChatId).toHaveBeenCalledTimes(1);
  });

  it("uses a generic error when WhatsApp reports failure without a reason", async () => {
    await setWhatsApp(true);
    providers.sendWhatsAppTextToChatId.mockResolvedValue({ success: false });
    const ticketId = await addTicket();
    await addEvent(ticketId, "ticket_created", users.creator);
    await tick();
    const row = (await notifications(ticketId)).find((r) => r.channel === "whatsapp");
    expect(row?.delivery_status).toBe("uncertain");
    expect(row?.error).toContain("manual review");
  });

  it("defers external channels that are not configured", async () => {
    await setWhatsApp(false);
    delete process.env.TICKET_SMTP_HOST;
    const ticketId = await addTicket();
    await addEvent(ticketId, "ticket_created", users.creator);
    await tick();
    const rows = await notifications(ticketId);
    expect(rows.find((r) => r.channel === "email")).toMatchObject({
      delivery_status: "pending",
      error: "Channel not configured",
    });
    expect(rows.find((r) => r.channel === "whatsapp")).toMatchObject({
      delivery_status: "pending",
      error: "Channel not configured",
    });
    expect(providers.sendMail).not.toHaveBeenCalled();
    await pool.query("UPDATE support_ticket_notifications SET delivery_status='suppressed' WHERE ticket_id=$1", [
      ticketId,
    ]);
  });

  it("suppresses external sends once consent is withdrawn", async () => {
    await setWhatsApp(true);
    const ticketId = await addTicket();
    const eventId = await addEvent(ticketId, "ticket_comment", users.assignee);
    // Comment by the assignee notifies the creator, who has no consented channel.
    await pool.query(
      `INSERT INTO support_ticket_notifications(company_id,ticket_id,outbox_id,recipient_user_id,channel)
       VALUES($1,$2,$3,$4,'email'),($1,$2,$3,$4,'whatsapp')`,
      [companyId, ticketId, eventId, users.creator]
    );
    await tick();
    const rows = (await notifications(ticketId)).filter((r) => r.channel !== "in_app");
    expect(rows.every((r) => r.delivery_status === "suppressed")).toBe(true);
    expect(providers.sendMail).not.toHaveBeenCalled();
    expect(providers.sendWhatsAppTextToChatId).not.toHaveBeenCalled();
  });

  it("notifies comment participants only when they may open the ticket page", async () => {
    const ticketId = await addTicket();
    await pool.query(
      "INSERT INTO support_ticket_participants(company_id,ticket_id,user_id,added_by) VALUES($1,$2,$3,$4)",
      [companyId, ticketId, users.participant, users.creator]
    );
    await addEvent(ticketId, "ticket_attachment", users.creator);
    await tick();
    const inApp = (await notifications(ticketId)).filter((r) => r.channel === "in_app");
    expect(inApp.map((r) => r.recipient_user_id).sort()).toEqual([users.assignee, users.participant].sort());
    expect(inApp.every((r) => r.delivery_status === "delivered")).toBe(true);
  });

  it("suppresses an in-app notification for a user who cannot see the ticket", async () => {
    const ticketId = await addTicket();
    const eventId = await addEvent(ticketId, "ticket_seen", users.assignee);
    await pool.query("UPDATE support_ticket_outbox SET processed_at=now() WHERE id=$1", [eventId]);
    await pool.query(
      `INSERT INTO support_ticket_notifications(company_id,ticket_id,outbox_id,recipient_user_id,channel)
       VALUES($1,$2,$3,$4,'in_app')`,
      [companyId, ticketId, eventId, users.outsider]
    );
    await tick();
    expect(await notifications(ticketId)).toEqual([
      expect.objectContaining({ recipient_user_id: users.outsider, delivery_status: "suppressed" }),
    ]);
  });

  it("creates one overdue reminder per elapsed day and reaches supervisors", async () => {
    await setWhatsApp(false);
    const ticketId = await addTicket({ dueAt: new Date(Date.now() - 26 * 3600_000).toISOString() });
    const now = new Date();
    expect(await enqueueTicketOverdueReminders(now)).toBeGreaterThanOrEqual(1);
    const again = await pool.query("SELECT count(*)::int AS n FROM support_ticket_outbox WHERE ticket_id=$1", [
      ticketId,
    ]);
    expect(again.rows[0].n).toBe(1);
    await tick();
    const outbox = await pool.query("SELECT count(*)::int AS n FROM support_ticket_outbox WHERE ticket_id=$1", [
      ticketId,
    ]);
    expect(outbox.rows[0].n).toBe(1);
    const inApp = (await notifications(ticketId)).filter((r) => r.channel === "in_app");
    expect(inApp.map((r) => r.recipient_user_id).sort()).toEqual([users.assignee, users.creator, users.owner].sort());
    await pool.query(
      "UPDATE support_ticket_notifications SET delivery_status='suppressed' WHERE ticket_id=$1 AND delivery_status='pending'",
      [ticketId]
    );
  });

  it("drops an overdue event for a ticket that was finalized meanwhile", async () => {
    const ticketId = await addTicket({ status: "finalized" });
    const eventId = await addEvent(ticketId, "ticket_overdue", null);
    await tick();
    const { rows } = await pool.query("SELECT processed_at FROM support_ticket_outbox WHERE id=$1", [eventId]);
    expect(rows[0].processed_at).not.toBeNull();
    expect(await notifications(ticketId)).toHaveLength(0);
  });

  it("suppresses a queued overdue delivery once the ticket is finalized", async () => {
    await setWhatsApp(true);
    const ticketId = await addTicket({ status: "finalized" });
    const eventId = await addEvent(ticketId, "ticket_overdue", null);
    await pool.query("UPDATE support_ticket_outbox SET processed_at=now() WHERE id=$1", [eventId]);
    await pool.query(
      `INSERT INTO support_ticket_notifications(company_id,ticket_id,outbox_id,recipient_user_id,channel)
       VALUES($1,$2,$3,$4,'in_app'),($1,$2,$3,$4,'whatsapp')`,
      [companyId, ticketId, eventId, users.assignee]
    );
    await tick();
    expect((await notifications(ticketId)).every((r) => r.delivery_status === "suppressed")).toBe(true);
    expect(providers.sendWhatsAppTextToChatId).not.toHaveBeenCalled();
  });

  it("turns a send left in progress across a restart into an uncertain delivery", async () => {
    const ticketId = await addTicket();
    const eventId = await addEvent(ticketId, "ticket_start", users.assignee);
    await pool.query("UPDATE support_ticket_outbox SET processed_at=now() WHERE id=$1", [eventId]);
    await pool.query(
      `INSERT INTO support_ticket_notifications(company_id,ticket_id,outbox_id,recipient_user_id,channel,
         delivery_status,last_attempt_at) VALUES($1,$2,$3,$4,'email','sending',now()-interval '10 minutes')`,
      [companyId, ticketId, eventId, users.creator]
    );
    await tick();
    expect(await notifications(ticketId)).toEqual([
      expect.objectContaining({ delivery_status: "uncertain", error: "Worker restarted before provider confirmation" }),
    ]);
  });

  it("logs and rethrows a failed tick", async () => {
    providers.failNextQuery = true;
    await expect(runTicketNotificationTick()).rejects.toThrow("db offline");
  });
});
