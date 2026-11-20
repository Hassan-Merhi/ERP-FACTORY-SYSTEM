/**
 * buildVoucherAndStockDrafts: the AI provider is mocked at its module boundary
 * and the ledger / inventory reads run against PostgreSQL in one rolled-back
 * transaction per test. Pins the intent gate, the "null" / malformed / short
 * extraction refusals, balance and stock enrichment, inventory rate fill and
 * the silent-failure paths.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ callAI: vi.fn() }));
vi.mock("../server/chat/aiProviders", () => ({ callAIWithFallback: h.callAI }));

import { withReportWorld, type ReportWorld } from "./helpers/reportCaseWorld";
import { buildVoucherAndStockDrafts } from "../server/chat/voucherAndStockDrafts";

const reply = (response: string) => h.callAI.mockResolvedValueOnce({ response, usedProvider: "gemini" });
const run = (w: ReportWorld, userMessage: string, intent = "create_voucher") =>
  buildVoucherAndStockDrafts({ userMessage, companyId: w.companyId, selectedProvider: "gemini", intent });

beforeEach(() => h.callAI.mockReset());

describe("voucher draft extraction", () => {
  it("skips extraction unless the intent is create_voucher and the text matches", () =>
    withReportWorld(async (w) => {
      expect(await run(w, "paid 500 to rent", "general")).toEqual({
        voucherDraft: undefined,
        stockAdjustmentDraft: undefined,
      });
      expect(await run(w, "hello there")).toEqual({ voucherDraft: undefined, stockAdjustmentDraft: undefined });
      expect(h.callAI).not.toHaveBeenCalled();
    }));

  it("returns no draft for a null, non-object, short or malformed reply and when the provider throws", () =>
    withReportWorld(async (w) => {
      reply("null");
      expect((await run(w, "paid 500 to rent")).voucherDraft).toBeUndefined();
      reply("I could not tell");
      expect((await run(w, "paid 500 to rent")).voucherDraft).toBeUndefined();
      reply(JSON.stringify({ type: "Payment", entries: [{ accountId: 1, debit: 5, credit: 0 }] }));
      expect((await run(w, "paid 500 to rent")).voucherDraft).toBeUndefined();
      reply(JSON.stringify({ entries: [{}, {}] }));
      expect((await run(w, "paid 500 to rent")).voucherDraft).toBeUndefined();
      reply("{not json");
      expect((await run(w, "paid 500 to rent")).voucherDraft).toBeUndefined();
      h.callAI.mockRejectedValueOnce(new Error("provider down"));
      expect((await run(w, "paid 500 to rent")).voucherDraft).toBeUndefined();
      expect(h.callAI).toHaveBeenCalledTimes(6);
    }));

  it("lists the company's accounts in the prompt and adds balances to resolved entries", () =>
    withReportWorld(async (w) => {
      const cash = await w.ledger("Petty Cash", "Cash");
      const rent = await w.ledger("Rent", "Expense");
      const v = await w.voucher("Payment", "2026-01-02");
      await w.entry(v, rent, 120, 0);
      await w.entry(v, cash, 0, 120);
      const optional = await w.voucher("Payment", "2026-01-03", { optional: true });
      await w.entry(optional, rent, 999, 0);
      reply(
        "```json\n" +
          JSON.stringify({
            type: "Payment",
            date: "2026-02-01",
            entries: [
              { accountId: rent, accountName: "Rent", debit: 500, credit: 0 },
              { accountId: cash, accountName: "Petty Cash", debit: 0, credit: 500 },
              { accountName: "Unresolved", debit: 0, credit: 0 },
            ],
          }) +
          "\n```"
      );
      const { voucherDraft } = await run(w, "paid 500 from petty cash to rent");
      expect(h.callAI.mock.calls[0][1]).toContain(`${rent}:Rent:Expense`);
      expect(voucherDraft.entries.map((e: { balanceBefore?: number }) => e.balanceBefore)).toEqual([
        120,
        -120,
        undefined,
      ]);
    }));

  it("keeps the draft when the balance lookup fails", () =>
    withReportWorld(async (w) => {
      reply(
        JSON.stringify({
          type: "Journal",
          entries: [
            { accountId: "not-a-number", debit: 1, credit: 0 },
            { accountId: "x", debit: 0, credit: 1 },
          ],
        })
      );
      const { voucherDraft } = await run(w, "record journal entry of 1");
      expect(voucherDraft).toMatchObject({ type: "Journal" });
      expect(voucherDraft.entries[0].balanceBefore).toBeUndefined();
    }));
});

describe("stock adjustment draft extraction", () => {
  const seedStock = async (w: ReportWorld) => {
    const loc = await w.one(`INSERT INTO locations (company_id, code, name) VALUES ($1, $2, 'Floor') RETURNING id`, [
      w.companyId,
      `${w.tag}F`,
    ]);
    const item = (name: string) =>
      w.one(`INSERT INTO stock_items (company_id, code, name, uom) VALUES ($1, $2, $3, 'KG') RETURNING id`, [
        w.companyId,
        `${w.tag}${name}`,
        name,
      ]);
    const rag = await item("Rag");
    const yarn = await item("Yarn");
    await w.q(
      `INSERT INTO inventory (company_id, location_id, stock_item_id, quantity, average_rate, total_value) VALUES ($1, $2, $3, 10, 2.5, 25)`,
      [w.companyId, loc, rag]
    );
    return { loc, rag, yarn };
  };

  it("fills rates from inventory and projects stock for produce and consume lines", () =>
    withReportWorld(async (w) => {
      const { loc, rag, yarn } = await seedStock(w);
      reply(
        JSON.stringify({
          date: "2026-03-01",
          locationId: loc,
          items: [
            { type: "CONSUME", stockItemId: rag, quantity: 4, rate: 0 },
            { type: "PRODUCE", stockItemId: yarn, quantity: 3, rate: 0 },
            { type: "PRODUCE", stockItemName: "Unknown", quantity: 1, rate: 0 },
          ],
        })
      );
      const { stockAdjustmentDraft, voucherDraft } = await run(
        w,
        "record production of yarn",
        "create_stock_adjustment"
      );
      expect(voucherDraft).toBeUndefined();
      expect(h.callAI.mock.calls[0][1]).toContain(`${loc}:Floor`);
      expect(
        stockAdjustmentDraft.items.map((i: Record<string, unknown>) => [i.rate, i.currentStock, i.projectedStock])
      ).toEqual([
        [2.5, 10, 6],
        [0, 0, 3],
        [0, undefined, undefined],
      ]);
    }));

  it("keeps rate zero when no line has a stock item", () =>
    withReportWorld(async (w) => {
      const { loc } = await seedStock(w);
      reply(JSON.stringify({ locationId: loc, items: [{ type: "PRODUCE", quantity: 2, rate: 0 }] }));
      const { stockAdjustmentDraft } = await run(w, "produce 2 bales", "create_stock_adjustment");
      expect(stockAdjustmentDraft.items).toEqual([{ type: "PRODUCE", quantity: 2, rate: 0 }]);
    }));

  it("returns no draft without a location or items, for null or malformed replies and when the provider throws", () =>
    withReportWorld(async (w) => {
      reply(JSON.stringify({ items: [{ stockItemId: 1, quantity: 1 }] }));
      expect((await run(w, "consume 3 bales", "x")).stockAdjustmentDraft).toBeUndefined();
      reply(JSON.stringify({ locationId: 1, items: [] }));
      expect((await run(w, "consume 3 bales", "x")).stockAdjustmentDraft).toBeUndefined();
      reply("null");
      expect((await run(w, "consume 3 bales", "x")).stockAdjustmentDraft).toBeUndefined();
      reply("{oops");
      expect((await run(w, "consume 3 bales", "x")).stockAdjustmentDraft).toBeUndefined();
      h.callAI.mockRejectedValueOnce(new Error("down"));
      expect((await run(w, "consume 3 bales", "x")).stockAdjustmentDraft).toBeUndefined();
    }));

  it("keeps the draft when the stock lookup fails", () =>
    withReportWorld(async (w) => {
      const { loc } = await seedStock(w);
      reply(JSON.stringify({ locationId: loc, items: [{ type: "CONSUME", stockItemId: "bad", quantity: 1 }] }));
      const { stockAdjustmentDraft } = await run(w, "consume 1 bale", "x");
      expect(stockAdjustmentDraft).toMatchObject({ locationId: loc });
      expect(stockAdjustmentDraft.items[0].rate).toBe(0);
      expect(stockAdjustmentDraft.items[0].currentStock).toBeUndefined();
    }));
});
