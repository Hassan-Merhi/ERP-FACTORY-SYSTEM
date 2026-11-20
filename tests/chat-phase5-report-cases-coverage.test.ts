/**
 * Chat report phase 5 cases (worker document expiry, purchase order detail,
 * trial balance) run against PostgreSQL in one rolled-back transaction per
 * test. The phase 5 container cost breakdown is not exercised: the report
 * registry routes "container_cost_breakdown" to the schema-compatibility
 * shard, so that phase 5 handler is never called in production.
 *
 * Pinned: missing-parameter and not-found answers, expired-document flags,
 * which charge rows appear, and trial balance totals for live vouchers only.
 */
import { describe, expect, it } from "vitest";
import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";
import {
  runPhase5PurchaseOrderDetail,
  runPhase5TrialBalance,
  runPhase5WorkerDocumentExpiry,
} from "../server/chat/reports/implementations/phase5ReportCases";

const fmt = (n: number) => n.toFixed(2);
const fmtDec = (n: number) => n.toFixed(3);
let seq = 0;

async function seed(w: FactoryWorld) {
  const supplier = (cid: number) =>
    w.one(
      `INSERT INTO suppliers (company_id, code, legal_name, email) VALUES ($1, $2, 'Acme Supply', 'a@example.com') RETURNING id`,
      [cid, `${w.tag}S${++seq}`]
    );
  return { tag: w.tag, companyId: w.companyId, one: w.one, q: w.q, supplier };
}

describe("worker document expiry", () => {
  it("flags expired documents and reports none when nothing expires soon", async () => {
    await withFactoryWorld(async (w) => {
      const s = await seed(w);
      const todayDate = new Date("2026-06-01T00:00:00Z");
      const base = { todayDate, companyId: s.companyId, rowLimit: 50, todayStr: "2026-06-01" };
      expect(await runPhase5WorkerDocumentExpiry(base)).toMatchObject({ noData: true });
      await s.q(
        `INSERT INTO factory_workers (company_id, full_name, active, employee_code, nationality, visa_expiry, work_permit_expiry)
         VALUES ($1, 'Expired Ed', TRUE, 'E1', 'LB', '2026-05-01', NULL),
                ($1, 'Soon Sam', TRUE, NULL, NULL, NULL, '2026-07-01'),
                ($1, 'Later Lou', TRUE, NULL, NULL, '2027-01-01', NULL)`,
        [s.companyId]
      );
      await s.q(
        `INSERT INTO factory_workers (company_id, full_name, active, residential_permit_expiry) VALUES ($1, 'Res Rita', TRUE, '2026-05-30')`,
        [s.companyId]
      );
      const res = await runPhase5WorkerDocumentExpiry(base);
      expect(res.noData).toBe(false);
      expect(res.table.rows).toEqual([
        ["Expired Ed", "E1", "LB", "2026-05-01 ⚠ EXPIRED", "—", "—"],
        ["Res Rita", "—", "—", "—", "—", "2026-05-30 ⚠ EXPIRED"],
        ["Soon Sam", "—", "—", "—", "2026-07-01", "—"],
      ]);
      expect(res.stats[1]).toMatchObject({ value: "2", highlight: "negative" });
    });
  });
});

describe("purchase order detail", () => {
  it("asks for a number and answers not found", async () => {
    await withFactoryWorld(async (w) => {
      const s = await seed(w);
      const ctx = { companyId: s.companyId, fmt, fmtDec };
      expect(await runPhase5PurchaseOrderDetail({ ...ctx, params: {} as never })).toMatchObject({
        summary: "Please specify a PO number.",
      });
      expect(await runPhase5PurchaseOrderDetail({ ...ctx, params: { entityName: "NOPE" } as never })).toMatchObject({
        summary: 'No PO found matching "NOPE".',
      });
    });
  });

  it("lists a PO with its line items and non-zero charges", async () => {
    await withFactoryWorld(async (w) => {
      const s = await seed(w);
      const supplierId = await s.supplier(s.companyId);
      const containerId = await s.one(
        `INSERT INTO containers (company_id, container_number, import_date, supplier_id)
         VALUES ($1, $2, '2026-01-01', $3) RETURNING id`,
        [s.companyId, `${s.tag}CN1`, supplierId]
      );
      const poId = await s.one(
        `INSERT INTO purchase_orders (company_id, container_id, supplier_id, po_number, items_total, freight, surcharge,
           fumigation, document_charges, other_charges, discount)
         VALUES ($1, $2, $3, $4, 1000, 10, 5, 3, 2, 0, 4) RETURNING id`,
        [s.companyId, containerId, supplierId, `${s.tag}PO1`]
      );
      const itemId = await s.one(
        `INSERT INTO stock_items (company_id, code, name, uom) VALUES ($1, $2, 'Shirts', 'KG') RETURNING id`,
        [s.companyId, `${s.tag}IT`]
      );
      await s.q(
        `INSERT INTO po_line_items (po_id, stock_item_id, item_name, quantity, rate, line_total) VALUES ($1, $2, 'Shirts', 500, 2, 1000)`,
        [poId, itemId]
      );
      const ctx = { companyId: s.companyId, fmt, fmtDec };

      const po = await runPhase5PurchaseOrderDetail({ ...ctx, params: { containerNumber: `${s.tag}PO` } as never });
      expect(po.title).toBe(`PO Detail: ${s.tag}PO1`);
      expect(po.noData).toBe(false);
      expect(po.table?.rows[0]).toEqual(["Shirts", `${s.tag}IT`, "500.000 KG", "2.000", "1000.00"]);
      expect(po.table?.rows.map((r) => r[0]).slice(1)).toEqual([
        "Freight",
        "Surcharge",
        "Fumigation",
        "Document Charges",
        "Discount",
        "GRAND TOTAL",
      ]);
      expect(po.table?.rows.at(-1)?.[4]).toBe("1016.00");
    });
  });
});

describe("trial balance", () => {
  it("sums live in-range vouchers only and flags an unbalanced total", async () => {
    await withFactoryWorld(async (w) => {
      const s = await seed(w);
      const ctx = { companyId: s.companyId, dateFrom: "2026-01-01", dateTo: "2026-01-31", fmt };
      expect(await runPhase5TrialBalance(ctx)).toMatchObject({ noData: true });
      const account = (code: string, type: string) =>
        s.one(
          `INSERT INTO ledger_accounts (company_id, code, name, account_type, opening_balance, active)
           VALUES ($1, $2::varchar, $2::text, $3, '0', TRUE) RETURNING id`,
          [s.companyId, `${s.tag}${code}`, type]
        );
      const cash = await account("CASH", "Cash");
      const sales = await account("SALES", "Income");
      const voucher = (date: string, deleted: boolean) =>
        s.one(
          `INSERT INTO vouchers (company_id, voucher_type, voucher_number, voucher_date, total_amount, deleted_at)
           VALUES ($1, 'Journal', $2, $3, 0, CASE WHEN $4::boolean THEN NOW() END) RETURNING id`,
          [s.companyId, `${s.tag}V${++seq}`, date, deleted]
        );
      const live = await voucher("2026-01-10", false);
      const outOfRange = await voucher("2026-02-10", false);
      const deleted = await voucher("2026-01-11", true);
      for (const [v, a, dr, cr] of [
        [live, cash, 100, 0],
        [live, sales, 0, 70],
        [outOfRange, cash, 500, 0],
        [deleted, cash, 900, 0],
      ] as const) {
        await s.q(
          `INSERT INTO voucher_entries (company_id, voucher_id, ledger_account_id, debit_amount, credit_amount) VALUES ($1, $2, $3, $4, $5)`,
          [s.companyId, v, a, dr, cr]
        );
      }
      const res = await runPhase5TrialBalance(ctx);
      expect(res.noData).toBe(false);
      expect(res.table.rows.at(-1)).toEqual(["", "GRAND TOTAL", "", "100.00", "70.00", "30.00", "—"]);
      expect(res.stats[3]).toMatchObject({ value: "30.00", highlight: "negative" });
      const salesRow = res.table.rows.find((r) => r[1] === `${s.tag}SALES`);
      expect(salesRow?.slice(5)).toEqual(["—", "70.00"]);
    });
  });
});
