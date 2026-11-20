/**
 * propertiesAccountStatementWhatsApp service against the real database inside
 * one rolled-back transaction. The WhatsApp provider (whatsappService) is
 * mocked at its module boundary; the statement PDF is generated for real.
 * Covers schedule timing, date ranges, the delivery claim (duplicates), every
 * delivery status, and the scheduler loop.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";

const wa = vi.hoisted(() => ({
  calls: [] as Array<{ chatId: string; fileName: string; caption: string; size: number }>,
  next: [] as Array<{ success: boolean; error?: string } | Error>,
}));
vi.mock("../server/services/whatsappService", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../server/services/whatsappService")>()),
  sendWhatsAppFileByUploadPos: async (chatId: string, pdf: Buffer, fileName: string, caption: string) => {
    wa.calls.push({ chatId, fileName, caption, size: pdf.length });
    const result = wa.next.shift() ?? { success: true };
    if (result instanceof Error) throw result;
    return result;
  },
}));

import { withRolledBackPool } from "./helpers/routedPoolClient";
import {
  propertiesWaDateRange,
  propertiesWaDue,
  propertiesWaLocalParts,
  runScheduledPropertiesWaStatements,
  sendPropertiesWaStatement,
  type PropertiesWaSchedule,
} from "../server/services/propertiesAccountStatementWhatsApp";

let seq = 0;
async function world(client: PoolClient) {
  const tag = `PWA${process.pid}${Date.now().toString(36)}${++seq}`.toUpperCase().slice(0, 18);
  const company = await client.query<{ id: number }>(
    `INSERT INTO companies (code, name, company_type) VALUES ($1::varchar, $1::text, 'properties') RETURNING id`,
    [tag]
  );
  const companyId = company.rows[0].id;
  const account = await client.query<{ id: number }>(
    `INSERT INTO ledger_accounts (company_id, code, name, account_type) VALUES ($1, $2, 'Tenant/A "B"', 'Asset') RETURNING id`,
    [companyId, `${tag}T`]
  );
  return { tag, companyId, accountId: account.rows[0].id };
}

const deliveries = async (client: PoolClient, companyId: number) =>
  (
    await client.query(
      `SELECT attempt_key, mode, status, error, statement_from::text AS "from", statement_to::text AS "to"
         FROM properties_account_wa_deliveries WHERE company_id = $1 ORDER BY id`,
      [companyId]
    )
  ).rows;

const schedule = (over: Partial<PropertiesWaSchedule> = {}): PropertiesWaSchedule => ({
  company_id: 1,
  account_id: 1,
  chat_id: "123@g.us",
  enabled: true,
  frequency: "daily",
  send_time: "09:00",
  day_of_week: 1,
  day_of_month: 1,
  timezone: "UTC",
  period_mode: "previous_month",
  updated_at: new Date("2026-01-01T00:00:00Z"),
  ...over,
});

beforeEach(() => {
  wa.calls.length = 0;
  wa.next.length = 0;
});

describe("properties statement schedule timing", () => {
  const monday10 = new Date("2026-06-01T10:00:00Z"); // a Monday, the 1st

  it("reads local date parts in the schedule's timezone", () => {
    expect(propertiesWaLocalParts(monday10, "UTC")).toEqual({
      date: "2026-06-01",
      time: "10:00",
      weekday: 1,
      monthDay: 1,
    });
    expect(propertiesWaLocalParts(monday10, "Asia/Tokyo").time).toBe("19:00");
  });

  it("is due only when enabled, addressed, past its time and on its day", () => {
    expect(propertiesWaDue(schedule(), monday10)).toBe("2026-06-01");
    expect(propertiesWaDue(schedule({ enabled: false }), monday10)).toBeNull();
    expect(propertiesWaDue(schedule({ chat_id: "" }), monday10)).toBeNull();
    expect(propertiesWaDue(schedule({ send_time: "11:00" }), monday10)).toBeNull();
    expect(propertiesWaDue(schedule({ frequency: "weekly", day_of_week: 2 }), monday10)).toBeNull();
    expect(propertiesWaDue(schedule({ frequency: "weekly", day_of_week: 1 }), monday10)).toBe("2026-06-01");
    expect(propertiesWaDue(schedule({ frequency: "monthly", day_of_month: 2 }), monday10)).toBeNull();
    expect(propertiesWaDue(schedule({ frequency: "monthly" }), monday10)).toBe("2026-06-01");
    // Edited today after the send time: no back-send today.
    expect(propertiesWaDue(schedule({ updated_at: new Date("2026-06-01T09:30:00Z") }), monday10)).toBeNull();
    expect(propertiesWaDue(schedule({ updated_at: new Date("2026-06-01T08:30:00Z") }), monday10)).toBe("2026-06-01");
    expect(() => propertiesWaDue(schedule({ timezone: "Not/AZone" }), monday10)).toThrow();
  });

  it("covers the previous month or the current month to date", () => {
    expect(propertiesWaDateRange("2026-03-15", "previous_month")).toEqual({
      startDate: "2026-02-01",
      endDate: "2026-02-28",
    });
    expect(propertiesWaDateRange("2026-01-10", "previous_month")).toEqual({
      startDate: "2025-12-01",
      endDate: "2025-12-31",
    });
    expect(propertiesWaDateRange("2026-03-15", "current_month")).toEqual({
      startDate: "2026-03-01",
      endDate: "2026-03-15",
    });
  });
});

describe("sendPropertiesWaStatement", () => {
  it("claims once, sends the PDF and records the accepted delivery", () =>
    withRolledBackPool(async (client) => {
      const w = await world(client);
      const input = {
        companyId: w.companyId,
        accountId: w.accountId,
        chatId: "555@g.us",
        attemptKey: "manual:1",
        mode: "manual" as const,
        startDate: "2026-01-01",
        endDate: "2026-01-31",
      };
      const first = await sendPropertiesWaStatement(input);
      expect(first).toEqual({ accepted: true, status: "accepted", error: null, duplicate: false });
      expect(wa.calls).toHaveLength(1);
      expect(wa.calls[0].fileName).toBe("Tenant_A _B_-Statement-2026-01-31.pdf");
      expect(wa.calls[0].caption).toContain("through 2026-01-31");
      expect(wa.calls[0].size).toBeGreaterThan(100);

      const again = await sendPropertiesWaStatement(input);
      expect(again).toEqual({ accepted: false, duplicate: true });
      expect(wa.calls).toHaveLength(1);
      expect(await deliveries(client, w.companyId)).toEqual([
        {
          attempt_key: "manual:1",
          mode: "manual",
          status: "accepted",
          error: null,
          from: "2026-01-01",
          to: "2026-01-31",
        },
      ]);
    }));

  it("records provider rejections, ambiguous failures and a missing account", () =>
    withRolledBackPool(async (client) => {
      const w = await world(client);
      const base = { companyId: w.companyId, accountId: w.accountId, chatId: "555@g.us", mode: "manual" as const };
      wa.next.push({ success: false, error: "file too large" });
      expect(await sendPropertiesWaStatement({ ...base, attemptKey: "a" })).toMatchObject({
        accepted: false,
        status: "failed",
        error: "file too large",
      });
      wa.next.push({ success: false });
      expect(await sendPropertiesWaStatement({ ...base, attemptKey: "b" })).toMatchObject({
        status: "failed",
        error: "WhatsApp provider rejected the file",
      });
      wa.next.push({ success: false, error: "Request timeout after 30s" });
      expect((await sendPropertiesWaStatement({ ...base, attemptKey: "c" })).status).toBe("uncertain");
      wa.next.push(new Error("socket connection lost"));
      expect((await sendPropertiesWaStatement({ ...base, attemptKey: "d" })).status).toBe("uncertain");

      const other = await world(client);
      const missing = await sendPropertiesWaStatement({ ...base, accountId: other.accountId, attemptKey: "e" });
      expect(missing).toMatchObject({ status: "failed", error: "Properties account no longer exists" });
      // No provider call for the account of another company.
      expect(wa.calls).toHaveLength(4);
      expect((await deliveries(client, w.companyId)).map((d) => [d.attempt_key, d.status])).toEqual([
        ["a", "failed"],
        ["b", "failed"],
        ["c", "uncertain"],
        ["d", "uncertain"],
        ["e", "failed"],
      ]);
      // All-time statement file name.
      wa.next.push({ success: true });
      await sendPropertiesWaStatement({ ...base, attemptKey: "f" });
      expect(wa.calls.at(-1)?.fileName).toMatch(/-Statement-All-Time\.pdf$/);
    }));
});

describe("runScheduledPropertiesWaStatements", () => {
  it("sends due schedules once per local date and skips the rest", () =>
    withRolledBackPool(async (client) => {
      const w = await world(client);
      const second = await client.query<{ id: number }>(
        `INSERT INTO ledger_accounts (company_id, code, name, account_type) VALUES ($1, $2, 'Tenant B', 'Asset') RETURNING id`,
        [w.companyId, `${w.tag}U`]
      );
      const third = await client.query<{ id: number }>(
        `INSERT INTO ledger_accounts (company_id, code, name, account_type) VALUES ($1, $2, 'Tenant C', 'Asset') RETURNING id`,
        [w.companyId, `${w.tag}V`]
      );
      const insert = (accountId: number, chat: string, extra: { tz?: string; time?: string }) =>
        client.query(
          `INSERT INTO properties_account_wa_schedules
             (company_id, account_id, chat_id, enabled, frequency, send_time, timezone, period_mode, updated_at)
           VALUES ($1, $2, $3, true, 'daily', $4, $5, 'previous_month', '2026-01-01T00:00:00Z')`,
          [w.companyId, accountId, chat, extra.time ?? "09:00", extra.tz ?? "UTC"]
        );
      await insert(w.accountId, `${w.tag}-due@g.us`, {});
      await insert(second.rows[0].id, `${w.tag}-late@g.us`, { time: "23:00" });
      await insert(third.rows[0].id, `${w.tag}-badtz@g.us`, { tz: "Not/AZone" });
      const other = await world(client);
      // A schedule naming an account of another company fails before the provider.
      await client.query(
        `INSERT INTO properties_account_wa_schedules
           (company_id, account_id, chat_id, enabled, frequency, send_time, timezone, updated_at)
         VALUES ($1, $2, $3, true, 'daily', '09:00', 'UTC', '2026-01-01T00:00:00Z')`,
        [w.companyId, other.accountId, `${w.tag}-stray@g.us`]
      );

      const now = new Date("2026-06-01T10:00:00Z");
      await runScheduledPropertiesWaStatements(now);
      const mine = () => wa.calls.filter((c) => c.chatId.startsWith(w.tag));
      expect(mine().map((c) => c.chatId)).toEqual([`${w.tag}-due@g.us`]);
      await runScheduledPropertiesWaStatements(now);
      expect(mine()).toHaveLength(1);
      expect(await deliveries(client, w.companyId)).toEqual([
        {
          attempt_key: "scheduled:2026-06-01",
          mode: "scheduled",
          status: "accepted",
          error: null,
          from: "2026-05-01",
          to: "2026-05-31",
        },
        {
          attempt_key: "scheduled:2026-06-01",
          mode: "scheduled",
          status: "failed",
          error: "Properties account no longer exists",
          from: "2026-05-01",
          to: "2026-05-31",
        },
      ]);
    }));
});
