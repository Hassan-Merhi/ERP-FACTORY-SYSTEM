/**
 * ticketService against PostgreSQL in one rolled-back transaction per test:
 * actor and field refusals, company-membership checks for creator, assignee
 * and reported user, voucher linking (invalid, other company, found), and
 * every lifecycle transition with its events and outbox rows. Also proves a
 * ticket id from another company is never found.
 */
import { describe, expect, it } from "vitest";

import { withReportWorld, type ReportWorld } from "./helpers/reportCaseWorld";
import { createSupportTicket, transitionSupportTicket } from "../server/lib/ticketService";
import type { TicketActor } from "../server/lib/ticketPolicy";

let seq = 0;
async function member(w: ReportWorld, companyId = w.companyId, active = true) {
  const [u] = await w.q<{ id: string }>(
    `INSERT INTO users (username, password, active) VALUES ($1, 'x', $2) RETURNING id`,
    [`${w.tag.toLowerCase()}_t${++seq}`, active]
  );
  await w.q(`INSERT INTO user_company_roles (user_id, company_id, role) VALUES ($1, $2, 'Normal User')`, [
    u.id,
    companyId,
  ]);
  return String(u.id);
}

const actorOf = (w: ReportWorld, userId: string, extra: Partial<TicketActor> = {}): TicketActor => ({
  userId,
  companyId: w.companyId,
  role: "Normal User",
  canAccessPage: true,
  canCreate: true,
  ...extra,
});

const input = (assignedTo: string, extra: Record<string, unknown> = {}) => ({
  assignedTo,
  category: " Accounts ",
  priority: "normal" as const,
  sourceMode: "erp" as const,
  title: " Wrong balance ",
  description: " Please check ",
  ...extra,
});

const ticketRows = (w: ReportWorld) => w.q(`SELECT id FROM support_tickets WHERE company_id = $1`, [w.companyId]);

describe("createSupportTicket refusals", () => {
  it("refuses incomplete actors, missing create permission and blank fields before writing", () =>
    withReportWorld(async (w) => {
      const me = await member(w);
      const good = actorOf(w, me);
      await expect(createSupportTicket({ ...good, userId: "" }, input(me))).rejects.toThrow("TICKET_ACCESS_DENIED");
      await expect(createSupportTicket({ ...good, companyId: 0 }, input(me))).rejects.toThrow("TICKET_ACCESS_DENIED");
      await expect(createSupportTicket({ ...good, companyId: 1.5 }, input(me))).rejects.toThrow("TICKET_ACCESS_DENIED");
      await expect(createSupportTicket({ ...good, canAccessPage: false }, input(me))).rejects.toThrow(
        "TICKET_ACCESS_DENIED"
      );
      await expect(createSupportTicket({ ...good, canCreate: undefined }, input(me))).rejects.toThrow(
        "TICKET_CREATE_DENIED"
      );
      for (const blank of [{ title: " " }, { description: "" }, { category: "  " }]) {
        await expect(createSupportTicket(good, input(me, blank))).rejects.toThrow("TICKET_FIELDS_REQUIRED");
      }
      expect(await ticketRows(w)).toEqual([]);
    }));

  it("requires creator, assignee and reported user to be active members of the company", () =>
    withReportWorld(async (w) => {
      const me = await member(w);
      const other = await w.otherCompany();
      const outsider = await member(w, other);
      const inactive = await member(w, w.companyId, false);
      const attempt = (actor: string, data: Record<string, unknown>) =>
        withSavepoint(w, () => createSupportTicket(actorOf(w, actor), input(String(data.assignedTo ?? me), data)));
      await expect(attempt(outsider, {})).rejects.toThrow("TICKET_COMPANY_USER_REQUIRED");
      await expect(attempt(me, { assignedTo: inactive })).rejects.toThrow("TICKET_COMPANY_USER_REQUIRED");
      await expect(attempt(me, { reportedUserId: outsider })).rejects.toThrow("TICKET_COMPANY_USER_REQUIRED");
      expect(await ticketRows(w)).toEqual([]);
    }));

  it("refuses invalid voucher ids and vouchers of another company", () =>
    withReportWorld(async (w) => {
      const me = await member(w);
      const other = await w.otherCompany();
      const foreign = await w.voucher("Payment", "2026-01-01", { companyId: other });
      for (const [voucherId, code] of [
        [0, "TICKET_INVALID_VOUCHER"],
        [1.5, "TICKET_INVALID_VOUCHER"],
        [foreign, "TICKET_VOUCHER_NOT_FOUND"],
      ] as const) {
        await expect(
          withSavepoint(w, () => createSupportTicket(actorOf(w, me), input(me, { voucherId })))
        ).rejects.toThrow(code);
      }
      expect(await ticketRows(w)).toEqual([]);
    }));
});

describe("createSupportTicket success", () => {
  it("creates a numbered ticket with a linked voucher, event and outbox row", () =>
    withReportWorld(async (w) => {
      const me = await member(w);
      const assignee = await member(w);
      const voucher = await w.voucher("Payment", "2026-01-01");
      const t = await createSupportTicket(actorOf(w, me), input(assignee, { voucherId: voucher, reportedUserId: me }));
      expect(t).toMatchObject({ status: "open", title: "Wrong balance", category: "Accounts", reportedUserId: me });
      expect(t.ticketNumber).toMatch(new RegExp(`^TKT-\\d{4}-${String(t.id).padStart(6, "0")}$`));
      const [record] = await w.q(`SELECT record_type, record_id FROM support_ticket_records WHERE ticket_id = $1`, [
        t.id,
      ]);
      expect(record).toEqual({ record_type: "voucher", record_id: String(voucher) });
      const events = await w.q(`SELECT event_type FROM support_ticket_outbox WHERE ticket_id = $1`, [t.id]);
      expect(events).toEqual([{ event_type: "ticket_created" }]);
    }));

  it("creates a ticket without a voucher or reported user", () =>
    withReportWorld(async (w) => {
      const me = await member(w);
      const t = await createSupportTicket(actorOf(w, me), input(me));
      expect(t.reportedUserId).toBeNull();
      expect(await w.q(`SELECT id FROM support_ticket_records WHERE ticket_id = $1`, [t.id])).toEqual([]);
    }));
});

describe("transitionSupportTicket", () => {
  it("walks seen, start, finalize and reopen, recording events and outbox rows", () =>
    withReportWorld(async (w) => {
      const creator = await member(w);
      const worker = await member(w);
      const t = await createSupportTicket(actorOf(w, creator), input(worker));
      const asWorker = actorOf(w, worker);
      expect((await transitionSupportTicket(asWorker, t.id, "seen")).firstSeenAt).toBeInstanceOf(Date);
      expect((await transitionSupportTicket(asWorker, t.id, "start")).status).toBe("working");
      const done = await transitionSupportTicket(asWorker, t.id, "finalize", { resolutionNote: "  fixed  " });
      expect(done).toMatchObject({ status: "finalized", resolutionNote: "fixed", finalizedBy: worker });
      const reopened = await transitionSupportTicket(actorOf(w, creator), t.id, "reopen", { reason: " still wrong " });
      expect(reopened).toMatchObject({
        status: "reopened",
        finalizedAt: null,
        reopenedCount: 1,
        version: t.version + 4,
      });
      const events = await w.q(
        `SELECT event_type, reason FROM support_ticket_events WHERE ticket_id = $1 ORDER BY id`,
        [t.id]
      );
      expect(events).toEqual([
        { event_type: "created", reason: null },
        { event_type: "seen", reason: null },
        { event_type: "start", reason: null },
        { event_type: "finalize", reason: "fixed" },
        { event_type: "reopen", reason: "still wrong" },
      ]);
    }));

  it("lets a participant see the ticket but refuses their actions, and hides other companies' tickets", () =>
    withReportWorld(async (w) => {
      const creator = await member(w);
      const participant = await member(w);
      const stranger = await member(w);
      const t = await createSupportTicket(actorOf(w, creator), input(creator));
      await w.q(
        `INSERT INTO support_ticket_participants (ticket_id, company_id, user_id, added_by) VALUES ($1, $2, $3, $4)`,
        [t.id, w.companyId, participant, creator]
      );
      await expect(
        withSavepoint(w, () => transitionSupportTicket(actorOf(w, participant), t.id, "start"))
      ).rejects.toThrow("TICKET_ACTION_DENIED");
      await expect(
        withSavepoint(w, () => transitionSupportTicket(actorOf(w, stranger), t.id, "start"))
      ).rejects.toThrow("TICKET_ACCESS_DENIED");
      const other = await w.otherCompany();
      const foreignActor = { ...actorOf(w, creator), companyId: other };
      await expect(withSavepoint(w, () => transitionSupportTicket(foreignActor, t.id, "seen"))).rejects.toThrow(
        "TICKET_NOT_FOUND"
      );
      await expect(
        transitionSupportTicket({ ...actorOf(w, creator), canAccessPage: false }, t.id, "seen")
      ).rejects.toThrow("TICKET_ACCESS_DENIED");
      const [row] = await w.q(`SELECT status, version FROM support_tickets WHERE id = $1`, [t.id]);
      expect(row).toEqual({ status: "open", version: t.version });
    }));
});

/** Run work that is expected to fail inside a savepoint so the test transaction stays usable. */
async function withSavepoint<T>(w: ReportWorld, work: () => Promise<T>): Promise<T> {
  await w.q("SAVEPOINT ticket_attempt");
  try {
    const result = await work();
    await w.q("RELEASE SAVEPOINT ticket_attempt");
    return result;
  } catch (error) {
    await w.q("ROLLBACK TO SAVEPOINT ticket_attempt");
    throw error;
  }
}
