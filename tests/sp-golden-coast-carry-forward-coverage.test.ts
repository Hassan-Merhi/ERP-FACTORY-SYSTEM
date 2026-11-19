/**
 * Golden Coast existing-position carry-forward routes through the real app
 * in a rolled-back world: non supplier-partner and non Golden Coast refusals,
 * missing or ambiguous stock/clearing accounts, plan blockers (nothing
 * written), a successful carry-forward and its idempotent replay.
 */
import { describe, expect, it } from "vitest";

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";

const URL = "/api/sp/golden-coast/cutover/existing-position-carry-forward";

async function account(w: FactoryWorld, code: string, type: string, subType: string) {
  return w.one(
    `INSERT INTO ledger_accounts (company_id, code, name, account_type, sub_type) VALUES ($1, $2::varchar, $2::text, $3, $4) RETURNING id`,
    [w.companyId, `${w.tag}${code}`, type, subType]
  );
}

/** A supplier-partner company; `goldenCoast` adds the capital roles, `stock` the three carry-forward roles. */
async function configure(w: FactoryWorld, opts: { goldenCoast?: boolean; stock?: boolean } = {}) {
  await w.q(`UPDATE companies SET company_type = 'supplier_partner' WHERE id = $1`, [w.companyId]);
  if (opts.goldenCoast !== false) {
    await account(w, "PCAP", "Equity", "gc_partner_capital");
    await account(w, "OCAP", "Equity", "gc_owner_capital");
  }
  if (opts.stock !== false) {
    await account(w, "STK", "Asset", "sp_stock");
    await account(w, "OTW", "Asset", "sp_goods_otw");
    await account(w, "OPN", "Equity", "sp_opnbal");
  }
}

async function inventory(w: FactoryWorld, quantity: string, rate: string) {
  const itemId = await w.one(
    `INSERT INTO stock_items (company_id, code, name, uom) VALUES ($1, $2, 'Bales', 'kg') RETURNING id`,
    [w.companyId, `${w.tag}SI${quantity}`]
  );
  await w.q(
    `INSERT INTO inventory (company_id, location_id, stock_item_id, quantity, average_rate) VALUES ($1, $2, $3, $4, $5)`,
    [w.companyId, w.locationId, itemId, quantity, rate]
  );
}

let keySeq = 0;
/** POST with the SP sensitive-action confirmation, reason and a fresh idempotency key. */
const apply = (w: FactoryWorld, body: Record<string, unknown> = {}) =>
  w.agent
    .post(URL)
    .set("Idempotency-Key", `${w.tag}-cf-${++keySeq}`)
    .send({ confirmation: "RUN SP MIGRATION", reason: "Cutover carry-forward", ...body });

const voucherCount = async (w: FactoryWorld) =>
  (await w.q<{ n: number }>(`SELECT count(*)::int AS n FROM vouchers WHERE company_id = $1`, [w.companyId]))[0].n;

describe("Golden Coast existing-position carry-forward", () => {
  it("refuses non supplier-partner and non Golden Coast companies", () =>
    withFactoryWorld(async (w) => {
      expect((await w.agent.get(URL)).status).toBe(403);
      expect((await apply(w)).status).toBe(403);
      await configure(w, { goldenCoast: false });
      const status = await w.agent.get(URL);
      expect(status.status).toBe(409);
      expect(status.body.code).toBe("GC_CARRY_FORWARD_NOT_CONFIGURED");
      const refusedApply = await apply(w);
      expect(refusedApply.body.code).toBe("GC_CARRY_FORWARD_NOT_CONFIGURED");
      expect(await voucherCount(w)).toBe(0);
    }));

  it("refuses missing or ambiguous stock and clearing accounts", () =>
    withFactoryWorld(async (w) => {
      await configure(w, { stock: false });
      const missing = await w.agent.get(URL);
      expect(missing.body.code).toBe("GC_CARRY_FORWARD_ACCOUNTS_NOT_READY");
      await account(w, "STK", "Asset", "sp_stock");
      await account(w, "STK2", "Asset", "sp_stock");
      await account(w, "OTW", "Asset", "sp_goods_otw");
      await account(w, "OPN", "Equity", "sp_opnbal");
      const ambiguous = await apply(w);
      expect(ambiguous.status).toBe(409);
      expect(ambiguous.body.code).toBe("GC_CARRY_FORWARD_ACCOUNTS_AMBIGUOUS");
    }));

  it("reports plan blockers and refuses to apply them", () =>
    withFactoryWorld(async (w) => {
      await configure(w);
      await inventory(w, "5", "0");
      const status = await w.agent.get(URL);
      expect(status.status).toBe(200);
      expect(status.body).toMatchObject({ canApply: false, posted: false, plan: null });
      expect(status.body.blockers.length).toBeGreaterThan(0);
      const blocked = await apply(w);
      expect(blocked.status).toBe(409);
      expect(blocked.body.code).toBe("GC_CARRY_FORWARD_BLOCKED");
      expect(await voucherCount(w)).toBe(0);
    }));

  it("applies the carry-forward once and replays it afterwards", () =>
    withFactoryWorld(async (w) => {
      await configure(w);
      await inventory(w, "10", "2.5");
      const status = await w.agent.get(URL);
      expect(status.body).toMatchObject({ canApply: true, blockers: [] });
      const unconfirmed = await w.agent.post(URL).send({ reason: "Cutover carry-forward" });
      expect(unconfirmed.body.code).toBe("SP_EXACT_CONFIRMATION_REQUIRED");
      expect(await voucherCount(w)).toBe(0);
      const applied = await apply(w);
      expect(applied.status).toBe(200);
      expect(applied.body).toMatchObject({ success: true, replayed: false, state: { posted: true } });
      expect(applied.body.inserted.length).toBeGreaterThan(0);
      expect(await voucherCount(w)).toBe(1);
      const replay = await apply(w);
      expect(replay.body).toMatchObject({ success: true, replayed: true, inserted: [] });
      expect(await voucherCount(w)).toBe(1);
    }));

  it("blocks a partial carry-forward journal and an existing Phase 3 opening voucher", () =>
    withFactoryWorld(async (w) => {
      await configure(w);
      await inventory(w, "4", "1");
      const voucher = (number: string) =>
        w.q(
          `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, total_amount)
           VALUES ($1, $2, 'Journal', '2026-09-01', 0)`,
          [w.companyId, number]
        );
      await voucher(`GC-EXISTING-POSITION-20260901-C${w.companyId}`);
      await voucher(`GC-CUTOVER-20260901-C${w.companyId}`);
      const status = await w.agent.get(URL);
      expect(status.body).toMatchObject({ canApply: false, posted: false });
      expect(status.body.blockers.join(" ")).toMatch(/FIFO bridge is missing/);
      expect(status.body.blockers.join(" ")).toMatch(/Phase 3 opening voucher already exists/);
      const blocked = await apply(w);
      expect(blocked.status).toBe(409);
      expect(blocked.body.message).toMatch(/FIFO bridge is missing/);
      expect(await voucherCount(w)).toBe(2);
    }));

  it("blocks a FIFO bridge that has no carry-forward journal", () =>
    withFactoryWorld(async (w) => {
      await configure(w);
      await inventory(w, "4", "1");
      await w.q(
        `INSERT INTO sp_stock_movements (company_id, article_code, source_type) VALUES ($1, 'ART', 'golden_coast_cutover')`,
        [w.companyId]
      );
      const status = await w.agent.get(URL);
      expect(status.body).toMatchObject({ canApply: false, posted: false });
      expect(status.body.blockers.join(" ")).toMatch(/bridge exists without the carry-forward journal/);
      expect((await apply(w)).status).toBe(409);
      expect(await voucherCount(w)).toBe(0);
    }));
});
