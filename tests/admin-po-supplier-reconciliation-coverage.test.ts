/**
 * POST /api/admin/po-supplier-reconciliation
 * (server/routes/admin/registerPoSupplierReconciliationRoutesPart1.ts)
 * through the real app, one rolled-back transaction per test.
 *
 * Pinned: refusals for a bad or inaccessible company; a dry run classifies and
 * never writes; apply repairs only a single-voucher duplicate that stays
 * balanced, audits it, and leaves every ambiguous case for manual review.
 */
import { describe, expect, it } from "vitest";

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";
import { closeBooks } from "./helpers/dispatchFlowFixture";

const URL = "/api/admin/po-supplier-reconciliation";

let seq = 0;

async function supplier(w: FactoryWorld, companyId = w.companyId) {
  return w.one(
    `INSERT INTO suppliers (company_id, code, legal_name, email) VALUES ($1, $2, 'Recon Supplier', 'recon@example.test') RETURNING id`,
    [companyId, `${w.tag}S${++seq}`]
  );
}

const purchases = (w: FactoryWorld, companyId = w.companyId) =>
  w.one(
    `INSERT INTO ledger_accounts (company_id, code, name, account_type, opening_balance, active)
     VALUES ($1, $2::varchar, $2::text, 'Expense', '0', TRUE) RETURNING id`,
    [companyId, `${w.tag}PUR${++seq}`]
  );

/** A PO of `itemsTotal` with an import voucher: Dr purchases `debit`, Cr supplier per `credits`. */
async function po(
  w: FactoryWorld,
  opts: {
    itemsTotal: string;
    credits: string[];
    debit?: string;
    companyId?: number;
    voucherCompanyId?: number;
    voucher?: boolean;
    voucherNumber?: (poNumber: string) => string;
    date?: string;
  }
) {
  const companyId = opts.companyId ?? w.companyId;
  const supplierId = await supplier(w, companyId);
  const containerId = await w.one(
    `INSERT INTO containers (company_id, container_number, supplier_id, status, import_date)
     VALUES ($1, $2, $3, 'OFFLOADED', '2026-06-01') RETURNING id`,
    [companyId, `${w.tag}CN${++seq}`, supplierId]
  );
  const poNumber = `${w.tag}PO${seq}`;
  let voucherId: number | null = null;
  if (opts.voucher !== false) {
    const voucherCompany = opts.voucherCompanyId ?? companyId;
    voucherId = await w.one(
      `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, total_amount, description)
       VALUES ($1, $2, 'Journal', $3, $4, $5) RETURNING id`,
      [
        voucherCompany,
        opts.voucherNumber?.(poNumber) ?? `${w.tag}V${seq}`,
        opts.date ?? "2026-06-01",
        opts.debit ?? opts.itemsTotal,
        `${w.tag}CN${seq}`,
      ]
    );
    await w.q(
      `INSERT INTO voucher_entries (voucher_id, ledger_account_id, debit_amount, credit_amount) VALUES ($1, $2, $3, 0)`,
      [voucherId, await purchases(w, voucherCompany), opts.debit ?? opts.itemsTotal]
    );
    for (const credit of opts.credits) {
      await w.q(
        `INSERT INTO voucher_entries (voucher_id, supplier_id, debit_amount, credit_amount) VALUES ($1, $2, 0, $3)`,
        [voucherId, supplierId, credit]
      );
    }
  }
  const poId = await w.one(
    `INSERT INTO purchase_orders (company_id, container_id, po_number, supplier_id, voucher_id, items_total)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [
      companyId,
      containerId,
      poNumber,
      supplierId,
      opts.companyId && opts.voucherCompanyId ? null : voucherId,
      opts.itemsTotal,
    ]
  );
  return { poId, voucherId, supplierId, poNumber };
}

const run = (w: FactoryWorld, body: Record<string, unknown>) => w.agent.post(URL).send(body);
const byPo = (body: { results: Array<{ poId: number }> }) => Object.fromEntries(body.results.map((r) => [r.poId, r]));
const supplierCredits = (w: FactoryWorld, voucherId: number) =>
  w.q(
    `SELECT credit_amount::numeric(18,2)::text AS c FROM voucher_entries WHERE voucher_id = $1 AND supplier_id IS NOT NULL ORDER BY id`,
    [voucherId]
  );

describe("PO supplier reconciliation refusals", () => {
  it("rejects an invalid company id and a company the user cannot access", async () => {
    await withFactoryWorld(async (w) => {
      for (const companyId of ["abc", -1, 1.5]) {
        const res = await run(w, { companyId });
        expect(res.status).toBe(400);
      }
      const other = await w.one(
        `INSERT INTO companies (code, name, company_type, base_currency) VALUES ($1::varchar, $1::text, 'factory', 'USD') RETURNING id`,
        [`${w.tag}X`]
      );
      const denied = await run(w, { companyId: other, apply: true });
      expect([403, 404]).toContain(denied.status);
    });
  });
});

describe("PO supplier reconciliation dry run", () => {
  it("classifies every PO without writing", async () => {
    await withFactoryWorld(async (w) => {
      const matched = await po(w, { itemsTotal: "100", credits: ["100"] });
      const mismatch = await po(w, { itemsTotal: "100", credits: ["90"] });
      const duplicate = await po(w, { itemsTotal: "100", credits: ["50", "50"] });
      const missing = await po(w, { itemsTotal: "100", credits: [], voucher: false });
      const res = await run(w, {});
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ dryRun: true, selectedCompanyId: w.companyId, repaired: 0 });
      const results = byPo(res.body);
      expect(results[matched.poId]).toMatchObject({ status: "matched", repairStatus: "not_requested" });
      expect(results[mismatch.poId]).toMatchObject({ status: "amount_mismatch", difference: "-10.00" });
      expect(results[duplicate.poId]).toMatchObject({ status: "duplicate" });
      expect(results[missing.poId]).toMatchObject({ status: "missing", voucherIds: [] });
      expect(res.body.counts).toMatchObject({ matched: 1, amount_mismatch: 1, duplicate: 1, missing: 1 });
      expect(await supplierCredits(w, duplicate.voucherId!)).toEqual([{ c: "50.00" }, { c: "50.00" }]);
    });
  });

  it("finds a subsidiary PO's payable in the parent's intercompany voucher", async () => {
    await withFactoryWorld(async (w) => {
      const child = await w.one(
        `INSERT INTO companies (code, name, company_type, base_currency, parent_company_id)
         VALUES ($1::varchar, $1::text, 'factory', 'USD', $2) RETURNING id`,
        [`${w.tag}CH`, w.companyId]
      );
      const sub = await po(w, {
        itemsTotal: "80",
        credits: ["80"],
        companyId: child,
        voucherCompanyId: w.companyId,
        voucherNumber: (n) => `IC-${child}-${n}-1`,
      });
      const res = await run(w, { companyId: w.companyId });
      expect(res.status).toBe(200);
      expect(res.body.companies).toEqual([w.companyId, child]);
      expect(byPo(res.body)[sub.poId]).toMatchObject({
        status: "matched",
        balanceCompanyId: w.companyId,
        sourceCompanyId: child,
      });
    });
  });
});

describe("PO supplier reconciliation apply", () => {
  it("repairs a balanced single-voucher duplicate and audits it; leaves ambiguous cases for review", async () => {
    await withFactoryWorld(async (w) => {
      const duplicate = await po(w, { itemsTotal: "100", credits: ["60", "40"] });
      const unbalanced = await po(w, { itemsTotal: "100", credits: ["90"], debit: "90" });
      const missingVoucher = await po(w, { itemsTotal: "100", credits: [], voucher: false });
      const noCredit = await po(w, { itemsTotal: "100", credits: [] });
      const matched = await po(w, { itemsTotal: "70", credits: ["70"] });

      const res = await run(w, { apply: true });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ dryRun: false, repaired: 1 });
      const results = byPo(res.body);
      expect(results[duplicate.poId]).toMatchObject({ repairStatus: "repaired", status: "matched" });
      expect(results[unbalanced.poId]).toMatchObject({ repairStatus: "manual_review", status: "amount_mismatch" });
      expect(results[missingVoucher.poId]).toMatchObject({ repairStatus: "manual_review" });
      expect(results[noCredit.poId]).toMatchObject({ repairStatus: "manual_review", status: "missing" });
      expect(results[matched.poId]).toMatchObject({ repairStatus: "not_requested" });

      expect(await supplierCredits(w, duplicate.voucherId!)).toEqual([{ c: "100.00" }]);
      expect(await supplierCredits(w, unbalanced.voucherId!)).toEqual([{ c: "90.00" }]);
      const audit = await w.q(
        `SELECT record_identifier FROM audit_log WHERE company_id = $1 AND action = 'reconcile' AND table_name = 'po_supplier_payables'`,
        [w.companyId]
      );
      expect(audit).toEqual([{ record_identifier: `po-supplier-reconciliation:${w.companyId}` }]);
    });
  });

  it("leaves a duplicate in a closed period for manual review", async () => {
    await withFactoryWorld(async (w) => {
      const duplicate = await po(w, { itemsTotal: "100", credits: ["60", "40"], date: "2026-01-15" });
      await closeBooks(w, "2026-03-31");
      const res = await run(w, { apply: true });
      expect(res.status).toBe(200);
      expect(byPo(res.body)[duplicate.poId]).toMatchObject({ repairStatus: "manual_review", status: "duplicate" });
      expect(res.body.repaired).toBe(0);
      expect(await supplierCredits(w, duplicate.voucherId!)).toEqual([{ c: "60.00" }, { c: "40.00" }]);
    });
  });
});
