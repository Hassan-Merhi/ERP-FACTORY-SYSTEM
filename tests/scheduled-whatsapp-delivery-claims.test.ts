import { beforeEach, describe, expect, it, vi } from "vitest";

type Occurrence = {
  id: number;
  job_type: string;
  company_id: number | null;
  recipient_key: string;
  recipient_chat_id: string;
  scheduled_local_date: string;
  scheduled_local_hour: number;
  occurrence_key: string;
  status: "claimed" | "delivering" | "partial" | "failed" | "sent";
  claim_token: string | null;
  delivery_started_at: Date | null;
  claimExpired: boolean;
};

type Attachment = {
  occurrence_id: number;
  attachment_key: string;
  status: "pending" | "sending" | "failed" | "sent";
  attempt_count: number;
  last_error: string | null;
  sent_at: Date | null;
};

const db = vi.hoisted(() => ({
  occurrences: [] as Occurrence[],
  attachments: [] as Attachment[],
  nextId: 1,
  connect: vi.fn(),
}));

function rowFor(occurrence: Occurrence) {
  return {
    id: occurrence.id,
    occurrence_key: occurrence.occurrence_key,
    status: occurrence.status,
    recipient_chat_id: occurrence.recipient_chat_id,
    scheduled_local_date: occurrence.scheduled_local_date,
    scheduled_local_hour: occurrence.scheduled_local_hour,
    claim_token: occurrence.claim_token,
  };
}

function createClient() {
  return {
    query: vi.fn(async (statement: string, params: unknown[] = []) => {
      const sql = String(statement).replace(/\s+/g, " ").trim();

      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
        return { rows: [], rowCount: 0 };
      }

      if (
        sql.includes("FROM scheduled_whatsapp_occurrences") &&
        sql.includes("WHERE occurrence_key = $1") &&
        sql.includes("FOR UPDATE") &&
        !sql.includes("INSERT INTO")
      ) {
        const found = db.occurrences.find((occurrence) => occurrence.occurrence_key === params[0]);
        return { rows: found ? [rowFor(found)] : [], rowCount: found ? 1 : 0 };
      }

      if (sql.startsWith("INSERT INTO scheduled_whatsapp_occurrences")) {
        const occurrenceKey = String(params[6]);
        if (db.occurrences.some((occurrence) => occurrence.occurrence_key === occurrenceKey)) {
          return { rows: [], rowCount: 0 };
        }

        const occurrence: Occurrence = {
          id: db.nextId++,
          job_type: String(params[0]),
          company_id: params[1] == null ? null : Number(params[1]),
          recipient_key: String(params[2]),
          recipient_chat_id: String(params[3]),
          scheduled_local_date: String(params[4]),
          scheduled_local_hour: Number(params[5]),
          occurrence_key: occurrenceKey,
          status: "claimed",
          claim_token: String(params[7]),
          delivery_started_at: null,
          claimExpired: false,
        };
        db.occurrences.push(occurrence);
        return { rows: [rowFor(occurrence)], rowCount: 1 };
      }

      if (sql.startsWith("INSERT INTO scheduled_whatsapp_attachments")) {
        const occurrenceId = Number(params[0]);
        const attachmentKey = String(params[1]);
        if (
          !db.attachments.some(
            (attachment) => attachment.occurrence_id === occurrenceId && attachment.attachment_key === attachmentKey
          )
        ) {
          db.attachments.push({
            occurrence_id: occurrenceId,
            attachment_key: attachmentKey,
            status: "pending",
            attempt_count: 0,
            last_error: null,
            sent_at: null,
          });
        }
        return { rows: [], rowCount: 1 };
      }

      if (
        sql.includes("SELECT attachment_key, status, attempt_count, last_error, sent_at") &&
        sql.includes("FROM scheduled_whatsapp_attachments")
      ) {
        const occurrenceId = Number(params[0]);
        const rows = db.attachments
          .filter((attachment) => attachment.occurrence_id === occurrenceId)
          .map((attachment) => ({
            attachment_key: attachment.attachment_key,
            status: attachment.status,
            attempt_count: attachment.attempt_count,
            last_error: attachment.last_error,
            sent_at: attachment.sent_at,
          }));
        return { rows, rowCount: rows.length };
      }

      if (sql.startsWith("UPDATE scheduled_whatsapp_occurrences o") && sql.includes("SET claim_token = $2")) {
        const occurrence = db.occurrences.find((entry) => entry.id === Number(params[0]));
        if (!occurrence) return { rows: [], rowCount: 0 };
        const hasSending = db.attachments.some(
          (attachment) => attachment.occurrence_id === occurrence.id && attachment.status === "sending"
        );
        const retryable =
          occurrence.status === "partial" ||
          occurrence.status === "failed" ||
          (occurrence.status === "claimed" && occurrence.delivery_started_at === null && occurrence.claimExpired);
        if (!retryable || hasSending) return { rows: [], rowCount: 0 };

        occurrence.claim_token = String(params[1]);
        occurrence.status = "claimed";
        occurrence.claimExpired = false;
        return { rows: [{ id: occurrence.id }], rowCount: 1 };
      }

      if (
        sql.includes("FROM scheduled_whatsapp_occurrences o") &&
        sql.includes("FOR UPDATE SKIP LOCKED") &&
        sql.includes("o.job_type = $1")
      ) {
        const [jobType, companyId, recipientKey, chatId] = params;
        const occurrence = db.occurrences.find((entry) => {
          const hasSending = db.attachments.some(
            (attachment) => attachment.occurrence_id === entry.id && attachment.status === "sending"
          );
          const retryable =
            entry.status === "partial" ||
            entry.status === "failed" ||
            (entry.status === "claimed" && entry.delivery_started_at === null && entry.claimExpired);
          return (
            entry.job_type === jobType &&
            entry.company_id === (companyId == null ? null : Number(companyId)) &&
            entry.recipient_key === recipientKey &&
            entry.recipient_chat_id === chatId &&
            retryable &&
            !hasSending
          );
        });
        return { rows: occurrence ? [rowFor(occurrence)] : [], rowCount: occurrence ? 1 : 0 };
      }

      throw new Error(`Unhandled test SQL: ${sql}`);
    }),
    release: vi.fn(),
  };
}

vi.mock("../server/db", () => ({
  pool: {
    connect: db.connect,
    query: vi.fn(),
  },
}));

vi.mock("../server/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  buildScheduledWhatsAppOccurrenceKey,
  claimRetryableScheduledWhatsAppOccurrence,
  claimScheduledWhatsAppOccurrence,
} from "../server/services/scheduler/scheduledWhatsAppDelivery";

describe("durable scheduled WhatsApp occurrence claims", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.occurrences.length = 0;
    db.attachments.length = 0;
    db.nextId = 1;
    db.connect.mockImplementation(async () => createClient());
  });

  it("allows only one of two concurrent scheduler instances to claim an occurrence", async () => {
    const input = {
      jobType: "stock_report",
      companyId: 7,
      recipientKey: "recipient:9:chat:120000@g.us",
      recipientChatId: "120000@g.us",
      scheduledLocalDate: "2026-09-28",
      scheduledLocalHour: 18,
      attachmentKeys: ["pdf", "excel"],
    };

    const [left, right] = await Promise.all([
      claimScheduledWhatsAppOccurrence(input),
      claimScheduledWhatsAppOccurrence(input),
    ]);

    expect([left?.acquired, right?.acquired].filter(Boolean)).toHaveLength(1);
    expect(db.occurrences).toHaveLength(1);
    expect(db.attachments).toHaveLength(2);
    expect(left?.occurrenceKey).toBe(right?.occurrenceKey);
  });

  it("recovers an expired claim only when delivery never began", async () => {
    const occurrenceKey = buildScheduledWhatsAppOccurrenceKey({
      jobType: "containers_report",
      recipientKey: "group:120000@g.us",
      scheduledLocalDate: "2026-09-28",
      scheduledLocalHour: 8,
    });
    db.occurrences.push({
      id: 1,
      job_type: "containers_report",
      company_id: null,
      recipient_key: "group:120000@g.us",
      recipient_chat_id: "120000@g.us",
      scheduled_local_date: "2026-09-28",
      scheduled_local_hour: 8,
      occurrence_key: occurrenceKey,
      status: "claimed",
      claim_token: "dead-process",
      delivery_started_at: null,
      claimExpired: true,
    });
    db.attachments.push({
      occurrence_id: 1,
      attachment_key: "pdf",
      status: "pending",
      attempt_count: 0,
      last_error: null,
      sent_at: null,
    });

    const recovered = await claimRetryableScheduledWhatsAppOccurrence({
      jobType: "containers_report",
      recipientKey: "group:120000@g.us",
      recipientChatId: "120000@g.us",
    });

    expect(recovered?.acquired).toBe(true);
    expect(recovered?.occurrenceKey).toBe(occurrenceKey);
    expect(db.occurrences[0].claim_token).not.toBe("dead-process");
  });

  it("does not auto-recover an ambiguous claim after external delivery started", async () => {
    const occurrenceKey = buildScheduledWhatsAppOccurrenceKey({
      jobType: "containers_report",
      recipientKey: "group:120000@g.us",
      scheduledLocalDate: "2026-09-28",
      scheduledLocalHour: 8,
    });
    db.occurrences.push({
      id: 1,
      job_type: "containers_report",
      company_id: null,
      recipient_key: "group:120000@g.us",
      recipient_chat_id: "120000@g.us",
      scheduled_local_date: "2026-09-28",
      scheduled_local_hour: 8,
      occurrence_key: occurrenceKey,
      status: "claimed",
      claim_token: "dead-process",
      delivery_started_at: new Date("2026-09-28T12:00:00Z"),
      claimExpired: true,
    });
    db.attachments.push({
      occurrence_id: 1,
      attachment_key: "pdf",
      status: "sending",
      attempt_count: 1,
      last_error: null,
      sent_at: null,
    });

    const recovered = await claimRetryableScheduledWhatsAppOccurrence({
      jobType: "containers_report",
      recipientKey: "group:120000@g.us",
      recipientChatId: "120000@g.us",
    });

    expect(recovered).toBeNull();
  });

  it("isolates occurrence keys by company and recipient", () => {
    const base = {
      jobType: "stock_report",
      scheduledLocalDate: "2026-09-28",
      scheduledLocalHour: 18,
    };
    const companyA = buildScheduledWhatsAppOccurrenceKey({
      ...base,
      companyId: 1,
      recipientKey: "recipient:10:chat:a@g.us",
    });
    const companyB = buildScheduledWhatsAppOccurrenceKey({
      ...base,
      companyId: 2,
      recipientKey: "recipient:10:chat:a@g.us",
    });
    const recipientB = buildScheduledWhatsAppOccurrenceKey({
      ...base,
      companyId: 1,
      recipientKey: "recipient:11:chat:b@g.us",
    });

    expect(new Set([companyA, companyB, recipientB]).size).toBe(3);
  });
});
