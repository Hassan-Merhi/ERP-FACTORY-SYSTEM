/**
 * Transporter statement: transporter list, payment-terms settings, per-entry
 * due dates and the WhatsApp summary, over HTTP in one rolled-back
 * transaction per test. Only the WhatsApp provider boundary is mocked.
 *
 * Pinned: id and body validation, account scoping of the WhatsApp summary,
 * the summary totals/overdue line, and (known bug) that a due date is keyed
 * only by voucher entry id, so a company can overwrite or delete a due date
 * that another company stored.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const wa = vi.hoisted(() => ({ recipients: vi.fn(), file: vi.fn(), text: vi.fn() }));

vi.mock("../server/services/whatsappService", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getActiveRecipients: wa.recipients,
  sendWhatsAppFileToChatId: wa.file,
  sendWhatsAppTextToChatId: wa.text,
}));

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";

async function loansAccount(w: FactoryWorld, name: string, companyId = w.companyId) {
  return w.one(
    `INSERT INTO ledger_accounts (company_id, code, name, account_type, opening_balance, active)
     VALUES ($1, $2, $3, 'Loans', '0', TRUE) RETURNING id`,
    [companyId, `${w.tag}${name}`.slice(0, 40), name]
  );
}

async function entry(w: FactoryWorld, accountId: number, date: string, debit: string, credit: string) {
  const voucherId = await w.one(
    `INSERT INTO vouchers (company_id, voucher_type, voucher_number, voucher_date, total_amount)
     VALUES ($1, 'Journal', $2, $3, 0) RETURNING id`,
    [w.companyId, `${w.tag}J${Math.floor(Math.random() * 1e9)}`, date]
  );
  return w.one(
    `INSERT INTO voucher_entries (company_id, voucher_id, ledger_account_id, debit_amount, credit_amount)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [w.companyId, voucherId, accountId, debit, credit]
  );
}

beforeEach(() => {
  wa.recipients.mockReset().mockResolvedValue([{ chatId: "a@c.us" }, { chatId: "b@c.us" }]);
  wa.file.mockReset().mockResolvedValue({ success: true });
  wa.text.mockReset().mockResolvedValue({ success: true });
});

describe("transporter list and settings", () => {
  it("lists only Loans accounts named as transporters of active containers", async () => {
    await withFactoryWorld(async (w) => {
      const supplierId = await w.one(
        `INSERT INTO suppliers (company_id, code, legal_name, email) VALUES ($1, $2, 'Sup', 'sup@example.com') RETURNING id`,
        [w.companyId, `${w.tag}S`]
      );
      const active = await loansAccount(w, `${w.tag} Trucks`);
      await loansAccount(w, `${w.tag} Idle`);
      for (const [n, transporter, status] of [
        ["1", ` ${w.tag} trucks `, "OTW"],
        ["2", `${w.tag} Idle`, "OFFLOADED"],
      ]) {
        await w.q(
          `INSERT INTO containers (company_id, container_number, import_date, supplier_id, transporter, status)
           VALUES ($1, $2, '2026-01-01', $3, $4, $5)`,
          [w.companyId, `${w.tag}C${n}`, supplierId, transporter, status]
        );
      }
      const res = await w.agent.get("/api/transporter-statement/transporters");
      expect(res.status).toBe(200);
      expect(res.body.map((r: { id: number }) => r.id)).toEqual([active]);
    });
  });

  it("validates ids and terms, upserts payment terms and defaults to zero", async () => {
    await withFactoryWorld(async (w) => {
      const account = await loansAccount(w, "Terms");
      const base = `/api/transporter-statement/${account}/settings`;
      expect((await w.agent.get("/api/transporter-statement/abc/settings")).status).toBe(400);
      expect((await w.agent.put("/api/transporter-statement/abc/settings").send({})).status).toBe(400);
      expect((await w.agent.get(base)).body).toEqual({ paymentTermsDays: 0 });
      expect((await w.agent.put(base).send({ paymentTermsDays: 366 })).status).toBe(400);
      expect((await w.agent.put(base).send({ paymentTermsDays: 30 })).body).toEqual({ paymentTermsDays: 30 });
      expect((await w.agent.put(base).send({ paymentTermsDays: 45 })).status).toBe(200);
      expect((await w.agent.get(base)).body).toEqual({ paymentTermsDays: 45 });
    });
  });
});

describe("transporter entry due dates", () => {
  it("validates, sets, replaces and clears a due date", async () => {
    await withFactoryWorld(async (w) => {
      const account = await loansAccount(w, "Due");
      const entryId = await entry(w, account, "2026-01-05", "0", "100");
      const url = `/api/transporter-entry-due-dates/${entryId}`;
      expect((await w.agent.put("/api/transporter-entry-due-dates/x").send({ dueDate: null })).status).toBe(400);
      expect((await w.agent.put(url).send({ dueDate: 5 })).status).toBe(400);
      expect((await w.agent.put(url).send({ dueDate: "2026-02-01" })).body).toEqual({
        ok: true,
        dueDate: "2026-02-01",
      });
      await w.agent.put(url).send({ dueDate: "2026-03-01" });
      const [row] = await w.q(
        `SELECT due_date::text AS d FROM transporter_entry_due_dates WHERE voucher_entry_id = $1`,
        [entryId]
      );
      expect(row.d).toBe("2026-03-01");
      expect((await w.agent.put(url).send({ dueDate: null })).status).toBe(200);
      expect(await w.q(`SELECT id FROM transporter_entry_due_dates WHERE voucher_entry_id = $1`, [entryId])).toEqual(
        []
      );
    });
  });

  // Known bug (pinned): writes are keyed only by voucher_entry_id, so another
  // company can overwrite or delete this company's due date.
  it("lets a different company overwrite and delete the due date of a foreign entry", async () => {
    await withFactoryWorld(async (w) => {
      const account = await loansAccount(w, "Owned");
      const entryId = await entry(w, account, "2026-01-05", "0", "100");
      const other = await w.one(
        `INSERT INTO companies (code, name, company_type) VALUES ($1::varchar, $1::text, 'factory') RETURNING id`,
        [`${w.tag}X`]
      );
      await w.q(
        `INSERT INTO transporter_entry_due_dates (voucher_entry_id, company_id, due_date) VALUES ($1, $2, '2026-02-01')`,
        [entryId, other]
      );
      await w.agent.put(`/api/transporter-entry-due-dates/${entryId}`).send({ dueDate: "2030-01-01" });
      const [row] = await w.q(
        `SELECT company_id, due_date::text AS d FROM transporter_entry_due_dates WHERE voucher_entry_id = $1`,
        [entryId]
      );
      expect(row).toEqual({ company_id: other, d: "2030-01-01" });
      await w.agent.put(`/api/transporter-entry-due-dates/${entryId}`).send({ dueDate: null });
      expect(await w.q(`SELECT id FROM transporter_entry_due_dates WHERE voucher_entry_id = $1`, [entryId])).toEqual(
        []
      );
    });
  });
});

describe("transporter statement WhatsApp summary", () => {
  const send = (w: FactoryWorld, id: number | string, body: Record<string, unknown> = {}) =>
    w.agent.post(`/api/transporter-statement/${id}/send-whatsapp`).send(body);

  it("refuses bad ids and bodies, foreign accounts and missing recipients", async () => {
    await withFactoryWorld(async (w) => {
      expect((await send(w, "x")).status).toBe(400);
      const account = await loansAccount(w, "Wa");
      expect((await send(w, account, { dateFrom: 5 })).status).toBe(500);
      const other = await w.one(
        `INSERT INTO companies (code, name, company_type) VALUES ($1::varchar, $1::text, 'factory') RETURNING id`,
        [`${w.tag}Y`]
      );
      const foreign = await loansAccount(w, "Foreign", other);
      expect((await send(w, foreign)).status).toBe(404);
      wa.recipients.mockResolvedValueOnce([]);
      const none = await send(w, account);
      expect(none.status).toBe(400);
      expect(none.body.message).toMatch(/No active WhatsApp recipients/);
      expect(wa.text).not.toHaveBeenCalled();
    });
  });

  it("sends a text summary with totals, overdue count and partial failures", async () => {
    await withFactoryWorld(async (w) => {
      const account = await loansAccount(w, "Summary");
      const charge = await entry(w, account, "2026-01-05", "0", "100");
      await entry(w, account, "2026-01-10", "40", "0");
      const settled = await entry(w, account, "2026-02-05", "0", "60");
      const payment = await entry(w, account, "2026-02-06", "60", "0");
      await w.q(
        `INSERT INTO transporter_payment_allocations (company_id, credit_entry_id, debit_entry_id, allocated_amount)
         VALUES ($1, $2, $3, 60)`,
        [w.companyId, settled, payment]
      );
      wa.text.mockResolvedValueOnce({ success: false, error: "blocked" });
      const res = await send(w, account, { dateFrom: "2026-01-01", dateTo: "2026-01-31" });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true, sent: 1, failed: 1, errors: ["blocked"] });
      const message = wa.text.mock.calls[0][1] as string;
      expect(message).toContain("Period: 2026-01-01 → 2026-01-31");
      expect(message).toContain("Total Charged: 100.00");
      expect(message).toContain("Total Paid:    40.00");
      expect(message).toContain("*Outstanding:  60.00*");
      expect(message).toContain("1 entry/entries overdue");
      expect(charge).toBeGreaterThan(0);

      await send(w, account, { dateFrom: "2026-01-01" });
      expect(wa.text.mock.calls.at(-1)?.[1]).toContain("From: 2026-01-01");
      await send(w, account, { dateTo: "2026-01-31" });
      expect(wa.text.mock.calls.at(-1)?.[1]).toContain("To: 2026-01-31");
    });
  });

  it("sends an image when one is supplied and reports per-recipient failures", async () => {
    await withFactoryWorld(async (w) => {
      const account = await loansAccount(w, "Image");
      wa.file.mockResolvedValueOnce({ success: false }).mockResolvedValueOnce({ success: false, error: "too big" });
      const res = await send(w, account, { imageBase64: "data:image/png;base64,aGVsbG8=" });
      expect(res.body).toEqual({ ok: true, sent: 0, failed: 2, errors: ["too big"] });
      expect(wa.file.mock.calls[0][1]).toEqual(Buffer.from("hello"));
      expect(wa.file.mock.calls[0][3]).toContain("All time");
      expect(wa.file.mock.calls[0][3]).toContain("All entries current");
      wa.file.mockResolvedValue({ success: true });
      expect((await send(w, account, { imageBase64: "aGVsbG8=" })).body.sent).toBe(2);
    });
  });
});
