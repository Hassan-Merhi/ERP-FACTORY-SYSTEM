/**
 * Supplier Partner offload reversal and reconciliation
 * (server/routes/sp/spOffloadLifecycleRoutes.ts) over HTTP against
 * PostgreSQL, one rolled-back supplier-partner company per test.
 *
 * Pinned refusals (nothing reversed): a non-numeric id, a short reason, a
 * malformed date, an unknown or another company's offload, an offload already
 * reversed, a container that is not offloaded, a newer active offload, no
 * stock movements, a consumed lot, a prepaid charge that cannot be restored,
 * an unavailable or empty original voucher, and a lot whose location is not
 * mapped. The success path mirrors the original voucher, restores prepaid
 * usage, removes the stock and reopens the container; the reconciliation
 * report passes on a clean company and counts each mismatch kind.
 */
import { describe, expect, it } from "vitest";

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";
import { nextSeq, otherCompany } from "./helpers/voucherReadFixture";

interface Seed {
  containerStatus?: string;
  movement?: { qtyIn: string; qtyRemaining: string; locationId?: number | null } | null;
  voucher?: "posted" | "deleted" | "empty" | null;
  prepaid?: { used: string; charged: string } | null;
}

async function seed(w: FactoryWorld, opts: Seed = {}) {
  await w.q(`UPDATE companies SET company_type = 'supplier_partner' WHERE id = $1`, [w.companyId]);
  const item = await w.one(
    `INSERT INTO stock_items (company_id, code, name, uom) VALUES ($1, $2, 'Bale', 'PCS') RETURNING id`,
    [w.companyId, `${w.tag}I${nextSeq()}`]
  );
  await w.q(
    `INSERT INTO inventory (company_id, location_id, stock_item_id, quantity, average_rate, total_value) VALUES ($1, $2, $3, 10, 5, 50)`,
    [w.companyId, w.locationId, item]
  );
  const container = await w.one(
    `INSERT INTO sp_containers (company_id, invoice_date, invoice_number, supplier_name, status, notes)
     VALUES ($1, '2026-09-10', $2, 'Supplier', $3, 'arrived') RETURNING id`,
    [w.companyId, `${w.tag}INV${nextSeq()}`, opts.containerStatus ?? "offloaded"]
  );
  let voucherId: number | null = null;
  if (opts.voucher !== null) {
    const stockAccount = await w.one(
      `INSERT INTO ledger_accounts (company_id, code, name, account_type) VALUES ($1, $2::varchar, $2::text, 'Asset') RETURNING id`,
      [w.companyId, `${w.tag}STK${nextSeq()}`]
    );
    const otwAccount = await w.one(
      `INSERT INTO ledger_accounts (company_id, code, name, account_type) VALUES ($1, $2::varchar, $2::text, 'Asset') RETURNING id`,
      [w.companyId, `${w.tag}OTW${nextSeq()}`]
    );
    voucherId = await w.one(
      `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, total_amount, source_module, deleted_at)
       VALUES ($1, $2, 'Journal', '2026-09-15', 50, 'SP', CASE WHEN $3::boolean THEN now() END) RETURNING id`,
      [w.companyId, `${w.tag}OFF${nextSeq()}`, opts.voucher === "deleted"]
    );
    if (opts.voucher !== "empty") {
      await w.q(
        `INSERT INTO voucher_entries (voucher_id, ledger_account_id, debit_amount, credit_amount)
         VALUES ($1, $2, 50, 0), ($1, $3, 0, 50)`,
        [voucherId, stockAccount, otwAccount]
      );
    }
  }
  const offload = await w.one(
    `INSERT INTO sp_offloads (company_id, container_id, offload_date, total_final_cost_usd, total_qty, voucher_id_stock)
     VALUES ($1, $2, '2026-09-15', 50, 10, $3) RETURNING id`,
    [w.companyId, container, voucherId]
  );
  const movement = opts.movement === undefined ? { qtyIn: "10", qtyRemaining: "10" } : opts.movement;
  if (movement) {
    await w.q(
      `INSERT INTO sp_stock_movements (company_id, article_code, stock_item_id, location_id, container_id, offload_id,
         qty_in, qty_remaining, final_unit_cost_usd, source_type)
       VALUES ($1, 'BALE', $2, $3, $4, $5, $6, $7, 5, 'offload')`,
      [
        w.companyId,
        item,
        movement.locationId === undefined ? w.locationId : movement.locationId,
        container,
        offload,
        movement.qtyIn,
        movement.qtyRemaining,
      ]
    );
  }
  let prepaid: number | null = null;
  if (opts.prepaid) {
    prepaid = await w.one(
      `INSERT INTO sp_prepaid_charges (company_id, charge_type, amount_paid_usd, amount_used_usd, container_id)
       VALUES ($1, 'freight', 100, $2, $3) RETURNING id`,
      [w.companyId, opts.prepaid.used, container]
    );
    await w.q(
      `INSERT INTO sp_offload_charges (company_id, offload_id, charge_type, amount_usd, prepaid_charge_id)
       VALUES ($1, $2, 'prepaid_used', $3, $4), ($1, $2, 'cash', 1, NULL)`,
      [w.companyId, offload, opts.prepaid.charged, prepaid]
    );
  }
  return { item, container, offload, voucherId, prepaid };
}

const BODY = { confirmation: "REVERSE SP OFFLOAD", reason: "Wrong container offloaded", reversalDate: "2026-10-01" };

const reverse = (w: FactoryWorld, id: number | string, body: Record<string, unknown> = BODY) =>
  w.agent.post(`/api/sp/offloads/${id}/reverse`).set("Idempotency-Key", `${w.tag}-${nextSeq()}`).send(body);

const reversals = (w: FactoryWorld) =>
  w.q(`SELECT offload_id FROM sp_offload_reversals WHERE company_id = $1`, [w.companyId]);

async function expectConflict(w: FactoryWorld, id: number, pattern: RegExp, status = 409) {
  const res = await reverse(w, id);
  expect(res.status, res.text).toBe(status);
  expect(res.body.message).toMatch(pattern);
  expect(await reversals(w)).toEqual([]);
}

describe("offload reversal refusals", () => {
  it("refuses a bad id, a short reason, a malformed date and an unknown offload", () =>
    withFactoryWorld(async (w) => {
      const { offload } = await seed(w);
      expect((await reverse(w, "abc")).status).toBe(400);
      const shortReason = await reverse(w, offload, { ...BODY, reason: "Oops" });
      // The SP access gate itself asks for a 5-character reason first.
      expect(shortReason.status).toBe(400);
      const date = await reverse(w, offload, { ...BODY, reversalDate: "01/10/2026" });
      expect(date.status).toBe(400);
      expect(date.body.message).toMatch(/YYYY-MM-DD/);
      await expectConflict(w, 999999999, /not found/, 404);
    }));

  it("refuses another company's offload id", () =>
    withFactoryWorld(async (w) => {
      await seed(w);
      const other = await otherCompany(w);
      const container = await w.one(
        `INSERT INTO sp_containers (company_id, invoice_date, invoice_number, supplier_name, status)
         VALUES ($1, '2026-09-10', 'X', 'S', 'offloaded') RETURNING id`,
        [other]
      );
      const foreign = await w.one(
        `INSERT INTO sp_offloads (company_id, container_id, offload_date) VALUES ($1, $2, '2026-09-15') RETURNING id`,
        [other, container]
      );
      await expectConflict(w, foreign, /not found/, 404);
    }));

  it("refuses an already reversed offload, a non-offloaded container and a newer offload", () =>
    withFactoryWorld(async (w) => {
      const first = await seed(w, { containerStatus: "open" });
      await expectConflict(w, first.offload, /currently offloaded container/);
      await w.q(`UPDATE sp_containers SET status = 'offloaded' WHERE id = $1`, [first.container]);
      await w.q(`INSERT INTO sp_offloads (company_id, container_id, offload_date) VALUES ($1, $2, '2026-09-16')`, [
        w.companyId,
        first.container,
      ]);
      await expectConflict(w, first.offload, /newer active offload/);
      await w.q(
        `INSERT INTO sp_offload_reversals (company_id, container_id, offload_id, reversal_date, reason)
         VALUES ($1, $2, $3, '2026-10-01', 'earlier')`,
        [w.companyId, first.container, first.offload]
      );
      const done = await reverse(w, first.offload);
      expect(done.status).toBe(409);
      expect(done.body.message).toMatch(/already been reversed/);
    }));

  it("refuses an offload without movements or with a consumed lot", () =>
    withFactoryWorld(async (w) => {
      const empty = await seed(w, { movement: null });
      await expectConflict(w, empty.offload, /no stock movements/);
      await w.q(`UPDATE sp_containers SET status = 'closed' WHERE id = $1`, [empty.container]);
      const consumed = await seed(w, { movement: { qtyIn: "10", qtyRemaining: "4" } });
      await expectConflict(w, consumed.offload, /has been consumed/);
    }));

  it("refuses a prepaid charge that cannot be restored exactly", () =>
    withFactoryWorld(async (w) => {
      const { offload, prepaid } = await seed(w, { prepaid: { used: "3", charged: "5" } });
      await expectConflict(w, offload, /cannot be restored exactly/);
      const [row] = await w.q(`SELECT amount_used_usd::text AS used FROM sp_prepaid_charges WHERE id = $1`, [prepaid]);
      expect(Number(row.used)).toBe(3);
    }));

  it("refuses a deleted or empty original voucher", () =>
    withFactoryWorld(async (w) => {
      const deleted = await seed(w, { voucher: "deleted" });
      await expectConflict(w, deleted.offload, /is unavailable/);
      await w.q(`UPDATE sp_containers SET status = 'closed' WHERE id = $1`, [deleted.container]);
      const empty = await seed(w, { voucher: "empty" });
      await expectConflict(w, empty.offload, /has no entries/);
    }));

  it("refuses a lot whose location is not mapped", () =>
    withFactoryWorld(async (w) => {
      const { offload } = await seed(w, {
        voucher: null,
        movement: { qtyIn: "2", qtyRemaining: "2", locationId: null },
      });
      const res = await reverse(w, offload);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe("SP_INVENTORY_LINK_REQUIRED");
      expect(await reversals(w)).toEqual([]);
    }));
});

describe("offload reversal", () => {
  it("mirrors the voucher, restores prepaid usage, removes stock and reopens the container", () =>
    withFactoryWorld(async (w) => {
      const { offload, container, voucherId, prepaid, item } = await seed(w, { prepaid: { used: "5", charged: "5" } });
      const res = await reverse(w, offload);
      expect(res.status, res.text).toBe(200);
      expect(res.body).toMatchObject({
        containerId: container,
        restoredPrepaidChargeCount: 1,
        reversedMovementCount: 1,
        originalVoucherIds: [voucherId],
      });
      expect(res.body.reversalVoucherIds).toHaveLength(1);
      const mirror = await w.q(
        `SELECT debit_amount::numeric::text AS dr, credit_amount::numeric::text AS cr FROM voucher_entries
          WHERE voucher_id = $1 ORDER BY debit_amount`,
        [res.body.reversalVoucherIds[0]]
      );
      expect(mirror.map((e) => [Number(e.dr), Number(e.cr)])).toEqual([
        [0, 50],
        [50, 0],
      ]);
      const [state] = await w.q(
        `SELECT c.status, c.notes, p.amount_used_usd::numeric::text AS used, i.quantity::numeric::text AS qty
           FROM sp_containers c, sp_prepaid_charges p, inventory i
          WHERE c.id = $1 AND p.id = $2 AND i.company_id = $3 AND i.stock_item_id = $4`,
        [container, prepaid, w.companyId, item]
      );
      expect(state.status).toBe("open");
      expect(state.notes).toMatch(/OFFLOAD REVERSED/);
      expect(Number(state.used)).toBe(0);
      expect(Number(state.qty)).toBe(0);
      expect(await reversals(w)).toEqual([{ offload_id: offload }]);
    }));
});

describe("offload reversal edge cases", () => {
  it("defaults the date to today, mirrors a parent-agent voucher and restores a zero prepaid charge", () =>
    withFactoryWorld(async (w) => {
      const { offload, container, voucherId } = await seed(w, { prepaid: { used: "0", charged: "0" } });
      const cash = await w.one(
        `INSERT INTO ledger_accounts (company_id, code, name, account_type) VALUES ($1, $2::varchar, $2::text, 'Cash') RETURNING id`,
        [w.companyId, `${w.tag}AGC`]
      );
      const fee = await w.one(
        `INSERT INTO ledger_accounts (company_id, code, name, account_type) VALUES ($1, $2::varchar, $2::text, 'Expense') RETURNING id`,
        [w.companyId, `${w.tag}AGF`]
      );
      const agentVoucher = await w.one(
        `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, total_amount, source_module)
         VALUES ($1, $2, 'Payment', '2026-09-15', 7, 'SP') RETURNING id`,
        [w.companyId, `SP-AGENT-${container}-1`]
      );
      await w.q(
        `INSERT INTO voucher_entries (voucher_id, ledger_account_id, debit_amount, credit_amount)
         VALUES ($1, $2, 7, 0), ($1, $3, 0, 7)`,
        [agentVoucher, fee, cash]
      );
      const res = await reverse(w, offload, { confirmation: BODY.confirmation, reason: BODY.reason });
      expect(res.status, res.text).toBe(200);
      expect(res.body.originalVoucherIds).toEqual([voucherId, agentVoucher]);
      expect(res.body.reversalVoucherIds).toHaveLength(2);
      const [reversal] = await w.q(
        `SELECT reversal_date::text AS d, snapshot->'parentVoucherIds' AS parents FROM sp_offload_reversals WHERE offload_id = $1`,
        [offload]
      );
      expect(reversal.d).toBe(new Date().toISOString().slice(0, 10));
      expect(reversal.parents).toEqual([agentVoucher]);
    }));

  it("answers 500 when Postgres rejects a well-formed but impossible date", () =>
    withFactoryWorld(async (w) => {
      const { offload } = await seed(w, { voucher: null });
      const res = await reverse(w, offload, { ...BODY, reversalDate: "2026-13-45" });
      expect(res.status).toBe(500);
      expect(await reversals(w)).toEqual([]);
    }));
});

describe("offload reconciliation", () => {
  it("passes a clean company and counts mismatches", () =>
    withFactoryWorld(async (w) => {
      await w.q(`UPDATE companies SET company_type = 'supplier_partner' WHERE id = $1`, [w.companyId]);
      const clean = await w.agent.get("/api/sp/reconciliation/offloads");
      expect(clean.status).toBe(200);
      expect(clean.body).toMatchObject({ status: "PASS", mismatchCount: 0 });

      const { container } = await seed(w, { voucher: null });
      // An offloaded container whose only offload is reversed, a prepaid overuse,
      // and a reversal whose voucher lists differ in length.
      await w.q(`UPDATE sp_offloads SET total_final_cost_usd = 999 WHERE container_id = $1`, [container]);
      await w.q(
        `INSERT INTO sp_prepaid_charges (company_id, charge_type, amount_paid_usd, amount_used_usd) VALUES ($1, 'freight', 10, 20)`,
        [w.companyId]
      );
      const orphan = await w.one(
        `INSERT INTO sp_containers (company_id, invoice_date, invoice_number, supplier_name, status)
         VALUES ($1, '2026-09-10', $2, 'S', 'offloaded') RETURNING id`,
        [w.companyId, `${w.tag}ORPH`]
      );
      const orphanOffload = await w.one(
        `INSERT INTO sp_offloads (company_id, container_id, offload_date) VALUES ($1, $2, '2026-09-15') RETURNING id`,
        [w.companyId, orphan]
      );
      await w.q(
        `INSERT INTO sp_offload_reversals (company_id, container_id, offload_id, reversal_date, reason,
           voucher_ids_original, voucher_ids_reversal)
         VALUES ($1, $2, $3, '2026-10-01', 'test', '[1]'::jsonb, '[]'::jsonb)`,
        [w.companyId, orphan, orphanOffload]
      );
      const res = await w.agent.get("/api/sp/reconciliation/offloads");
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("FAIL");
      expect(res.body.checks).toMatchObject({
        stockCost: 1,
        prepaidBalances: 1,
        reversalVoucherPairs: 1,
        containerState: 1,
      });
    }));

  it("refuses a company that is not a supplier partner", () =>
    withFactoryWorld(async (w) => {
      expect((await w.agent.get("/api/sp/reconciliation/offloads")).status).toBe(403);
    }));
});
