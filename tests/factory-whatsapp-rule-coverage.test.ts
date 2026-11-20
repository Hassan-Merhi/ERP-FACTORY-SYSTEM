/**
 * Factory account WhatsApp auto-statement rules: GET defaults and stored
 * rules, PUT refusals (bad id, foreign account) and upsert; the voucher-time
 * prompt check and the send trigger honour every gate (non-ledger, no rule,
 * disabled, no chat, per-voucher-type switches) and report provider failures.
 * Only the WhatsApp provider is stubbed. One rolled-back transaction per test.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const wa = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("../server/services/whatsappService", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../server/services/whatsappService")>()),
  sendWhatsAppFileByUploadPos: (...args: unknown[]) => wa.send(...args),
}));

import { checkAccountWhatsAppRule, triggerAccountWhatsAppStatement } from "../server/routes/factoryWhatsappRoutes";
import { type FactoryWorld, withFactoryWorld } from "./helpers/rolledBackFactoryApp";

const rulePath = (id: unknown) => `/api/factory/accounts/${id}/whatsapp-rule`;

async function account(w: FactoryWorld, companyId = w.companyId) {
  return w.one(
    `INSERT INTO ledger_accounts (company_id, code, name, account_type) VALUES ($1, $2, 'Supplier: A/B', 'Liability') RETURNING id`,
    [companyId, `${w.tag}${Math.random().toString(36).slice(2, 6)}`]
  );
}

beforeEach(() => {
  wa.send.mockReset();
});

describe("WhatsApp rule routes", () => {
  it("returns defaults, refuses bad ids and foreign accounts, then upserts", async () => {
    await withFactoryWorld(async (w) => {
      const id = await account(w);
      const other = await w.one(`INSERT INTO companies (code, name) VALUES ($1::varchar, $1::text) RETURNING id`, [
        `${w.tag}O`,
      ]);
      const foreign = await account(w, other);

      expect((await w.agent.get(rulePath("abc"))).status).toBe(400);
      expect((await w.agent.put(rulePath("abc")).send({})).status).toBe(400);
      const empty = await w.agent.get(rulePath(id));
      expect(empty.body).toMatchObject({ id: null, enabled: false, ledgerAccountId: id, sendOnJournal: true });

      const refused = await w.agent.put(rulePath(foreign)).send({ enabled: true, whatsappChatId: "x" });
      expect(refused.status).toBe(404);
      const none = await w.q(`SELECT 1 FROM factory_account_whatsapp_rules WHERE ledger_account_id = $1`, [foreign]);
      expect(none).toHaveLength(0);

      const created = await w.agent.put(rulePath(id)).send({ enabled: 1, whatsappChatId: "123@g.us" });
      expect(created.body).toMatchObject({ enabled: true, whatsappChatId: "123@g.us", sendOnPayment: true });
      const updated = await w.agent.put(rulePath(id)).send({ enabled: false, sendOnPayment: false });
      expect(updated.body).toMatchObject({
        id: created.body.id,
        enabled: false,
        whatsappChatId: null,
        sendOnPayment: false,
      });
      const read = await w.agent.get(rulePath(id));
      expect(read.body).toMatchObject({ id: created.body.id, sendOnPayment: false });
    });
  });
});

describe("WhatsApp statement prompt and trigger", () => {
  async function rule(w: FactoryWorld, id: number, values: Record<string, unknown>) {
    await w.q(
      `INSERT INTO factory_account_whatsapp_rules (company_id, ledger_account_id, enabled, whatsapp_chat_id, send_on_payment, send_on_receipt, send_on_journal)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (company_id, ledger_account_id) DO UPDATE SET enabled = EXCLUDED.enabled,
         whatsapp_chat_id = EXCLUDED.whatsapp_chat_id, send_on_payment = EXCLUDED.send_on_payment,
         send_on_receipt = EXCLUDED.send_on_receipt, send_on_journal = EXCLUDED.send_on_journal`,
      [
        w.companyId,
        id,
        values.enabled ?? true,
        values.chat === undefined ? "chat-1" : values.chat,
        values.payment ?? true,
        values.receipt ?? true,
        values.journal ?? true,
      ]
    );
  }

  const opts = (
    w: FactoryWorld,
    accountId: number,
    voucherType: "Payment" | "Receipt" | "Journal",
    type = "ledger"
  ) => ({
    companyId: w.companyId,
    accountId,
    accountType: type,
    voucherType,
    voucherDate: "2026-03-15",
  });

  it("does not prompt or send when a gate is closed", async () => {
    await withFactoryWorld(async (w) => {
      const id = await account(w);
      expect(await checkAccountWhatsAppRule(opts(w, id, "Payment", "bank"))).toEqual({ prompt: false });
      expect(await triggerAccountWhatsAppStatement(opts(w, id, "Payment", "bank"))).toEqual({ sent: false });
      expect(await checkAccountWhatsAppRule(opts(w, id, "Payment"))).toEqual({ prompt: false });
      expect(await triggerAccountWhatsAppStatement(opts(w, id, "Payment"))).toEqual({ sent: false });
      await rule(w, id, { enabled: false });
      expect(await checkAccountWhatsAppRule(opts(w, id, "Payment"))).toEqual({ prompt: false });
      await rule(w, id, { chat: null });
      expect(await triggerAccountWhatsAppStatement(opts(w, id, "Payment"))).toEqual({ sent: false });
      await rule(w, id, { payment: false, receipt: false, journal: false });
      for (const type of ["Payment", "Receipt", "Journal"] as const) {
        expect(await checkAccountWhatsAppRule(opts(w, id, type))).toEqual({ prompt: false });
        expect(await triggerAccountWhatsAppStatement(opts(w, id, type))).toEqual({ sent: false });
      }
      expect(wa.send).not.toHaveBeenCalled();
    });
  });

  it("prompts and sends the month's statement, reporting provider failures", async () => {
    await withFactoryWorld(async (w) => {
      const id = await account(w);
      await rule(w, id, {});
      expect(await checkAccountWhatsAppRule(opts(w, id, "Receipt"))).toEqual({
        prompt: true,
        accountId: id,
        voucherDate: "2026-03-15",
        month: "2026-03",
      });
      wa.send.mockResolvedValueOnce({ success: true });
      expect(await triggerAccountWhatsAppStatement(opts(w, id, "Journal"))).toEqual({ sent: true });
      const [chat, pdf, fileName, caption] = wa.send.mock.calls[0];
      expect(chat).toBe("chat-1");
      expect(Buffer.isBuffer(pdf)).toBe(true);
      expect(fileName).toBe("Supplier_ A_B Statement 2026-03.pdf");
      expect(caption).toBe("Supplier: A/B — Statement 2026-03");

      wa.send.mockResolvedValueOnce({ success: false, error: "provider down" });
      expect(await triggerAccountWhatsAppStatement(opts(w, id, "Payment"))).toEqual({
        sent: false,
        error: "provider down",
      });
      wa.send.mockRejectedValueOnce(new Error("socket closed"));
      expect(await triggerAccountWhatsAppStatement(opts(w, id, "Receipt"))).toEqual({
        sent: false,
        error: "socket closed",
      });
    });
  });
});
