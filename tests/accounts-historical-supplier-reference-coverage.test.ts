/**
 * GET /api/accounts/supplier/:id/transactions
 * (server/routes/accounts/historicalSupplierReferenceRoutes.ts): id and
 * company checks, the zero-impact "Historical PO Reference" rows added for a
 * linked child company's legacy POs (and every reason one is skipped), the
 * brought-forward sum, and the engine opening fallbacks. Rolled back per test.
 */
import { describe, expect, it } from "vitest";

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";

const url = (id: number | string) => `/api/accounts/supplier/${id}/transactions`;

async function childWorld(w: FactoryWorld) {
  const childId = await w.one(
    `INSERT INTO companies (code, name, parent_company_id) VALUES ($1::varchar, 'Child Co', $2) RETURNING id`,
    [`${w.tag}CH`, w.companyId]
  );
  await w.q(`INSERT INTO user_company_roles (user_id, company_id, role) VALUES ($1, $2, 'Admin')`, [w.userId, childId]);
  const supplierId = await w.one(
    `INSERT INTO suppliers (company_id, code, legal_name, email) VALUES ($1, $2, 'Supp', 's@x.test') RETURNING id`,
    [w.companyId, `${w.tag}S`]
  );
  let n = 0;
  const container = (companyId: number, number: string) =>
    w.one(
      `INSERT INTO containers (company_id, container_number, import_date, supplier_id) VALUES ($1, $2, '2026-03-01', $3) RETURNING id`,
      [companyId, number, supplierId]
    );
  /** A child voucher with one supplier line, and a PO pointing at it. */
  const childPo = async (
    containerId: number,
    poNumber: string,
    credit: string,
    debit = "0",
    opts: { voucher?: boolean; currency?: string | null } = {}
  ) => {
    let voucherId: number | null = null;
    if (opts.voucher !== false) {
      voucherId = await w.one(
        `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, total_amount)
         VALUES ($1, $2, 'Purchase', $3, $4) RETURNING id`,
        [childId, `${w.tag}-CV${++n}`, `2026-03-0${Math.min(n, 9)}`, credit]
      );
      await w.q(
        `INSERT INTO voucher_entries (voucher_id, supplier_id, debit_amount, credit_amount, narration, transaction_currency)
         VALUES ($1, $2, $3, $4, 'child po', $5)`,
        [voucherId, supplierId, debit, credit, opts.currency ?? null]
      );
    }
    return w.one(
      `INSERT INTO purchase_orders (company_id, container_id, po_number, supplier_id, voucher_id, currency)
       VALUES ($1, $2, $3, $4, $5, 'EUR') RETURNING id`,
      [childId, containerId, poNumber, supplierId, voucherId]
    );
  };
  return { childId, supplierId, container, childPo };
}

describe("GET /api/accounts/supplier/:id/transactions", () => {
  it("refuses a non-numeric id and a company the user cannot read", async () => {
    await withFactoryWorld(async (w) => {
      const bad = await w.agent.get(url("abc"));
      expect(bad.status).toBe(400);
      const other = await w.one(`INSERT INTO companies (code, name) VALUES ($1::varchar, $1::text) RETURNING id`, [
        `${w.tag}X`,
      ]);
      const foreign = await w.agent.get(url(1)).query({ companyId: other });
      expect(foreign.status).toBe(403);
      // The company-scope middleware refuses it before the route runs.
      expect(foreign.body.message).toBe("Forbidden");
    });
  });

  it("adds one reference row per legacy child PO and skips every PO that must not appear", async () => {
    await withFactoryWorld(async (w) => {
      const { childId, supplierId, container, childPo } = await childWorld(w);
      const shown = await container(childId, "CONT-SHOWN");
      const shownPo = await childPo(shown, "PO-SHOWN", "250", "0", { currency: "AED" });
      await childPo(await container(childId, "CONT-NOVOUCHER"), "PO-NV", "10", "0", { voucher: false });
      await childPo(await container(childId, "CONT-ZERO"), "PO-ZERO", "0", "10");
      await childPo(await container(w.companyId, "CONT-PARENT"), "PO-WRONGCO", "40");
      await childPo(await container(childId, "CONT-MATCHED"), "PO-MATCHED", "60");
      const fallback = await childPo(await container(childId, " "), "PO-FALLBACK", "70");

      // A parent supplier line that names CONT-MATCHED is its parent counterpart.
      const parentVoucher = await w.one(
        `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, total_amount, description)
         VALUES ($1, $2, 'Journal', '2026-03-05', 60, 'Import cont-matched') RETURNING id`,
        [w.companyId, `${w.tag}-PV`]
      );
      await w.q(
        `INSERT INTO voucher_entries (voucher_id, supplier_id, debit_amount, credit_amount, narration)
         VALUES ($1, $2, 0, 60, 'parent')`,
        [parentVoucher, supplierId]
      );

      const res = await w.agent.get(url(supplierId));
      expect(res.status).toBe(200);
      const refs = res.body.transactions.filter(
        (t: { voucherType: string }) => t.voucherType === "Historical PO Reference"
      );
      expect(refs.map((r: { voucherId: number }) => r.voucherId).sort()).toEqual([-shownPo, -fallback].sort());
      const shownRow = refs.find((r: { voucherId: number }) => r.voucherId === -shownPo);
      expect(shownRow).toMatchObject({
        debitAmount: "0.00",
        creditAmount: "0.00",
        currency: "USD",
        voucherNumber: "PO-SHOWN",
        companyId: w.companyId,
      });
      expect(shownRow.narration).toBe(
        "CONT-SHOWN · PO-SHOWN · Child Co · USD 250.00 · reference only; parent supplier balance unchanged"
      );
      const fallbackRow = refs.find((r: { voucherId: number }) => r.voucherId === -fallback);
      expect(fallbackRow.narration).toContain("PO-FALLBACK · Child Co");
      expect(res.body.transactions.some((t: { voucherId: number }) => t.voucherId === parentVoucher)).toBe(true);
      expect(res.body).toMatchObject({ preNetBalance: 0, startDate: null });
    });
  });

  it("matches a PO-number counterpart when the container number is blank", async () => {
    await withFactoryWorld(async (w) => {
      const { childId, supplierId, container, childPo } = await childWorld(w);
      await childPo(await container(childId, "  "), "PO-BLANKCONT", "30");
      const nameless = await childPo(await container(childId, "   "), "", "15");
      const parentVoucher = await w.one(
        `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, total_amount)
         VALUES ($1, 'po-blankcont parent', 'Journal', '2026-03-05', 30) RETURNING id`,
        [w.companyId]
      );
      await w.q(
        `INSERT INTO voucher_entries (voucher_id, supplier_id, debit_amount, credit_amount, narration) VALUES ($1, $2, 0, 30, 'p')`,
        [parentVoucher, supplierId]
      );
      const res = await w.agent.get(url(supplierId));
      const refs = res.body.transactions.filter(
        (t: { voucherType: string }) => t.voucherType === "Historical PO Reference"
      );
      // Only the PO with neither a container nor a PO number is listed, under PO-<id>.
      expect(refs.map((r: { voucherNumber: string }) => r.voucherNumber)).toEqual([`PO-${nameless}`]);
    });
  });

  it("sums the brought-forward balance before startDate and skips the engine for an inverted window", async () => {
    await withFactoryWorld(async (w) => {
      const { supplierId } = await childWorld(w);
      const early = await w.one(
        `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, total_amount)
         VALUES ($1, $2, 'Journal', '2026-01-10', 90) RETURNING id`,
        [w.companyId, `${w.tag}-E`]
      );
      await w.q(
        `INSERT INTO voucher_entries (voucher_id, supplier_id, debit_amount, credit_amount, narration) VALUES ($1, $2, 0, 90, 'e')`,
        [early, supplierId]
      );
      const windowed = await w.agent.get(url(supplierId)).query({ startDate: "2026-02-01", endDate: "2026-12-31" });
      expect(windowed.status).toBe(200);
      expect(windowed.body).toMatchObject({ preNetBalance: -90, startDate: "2026-02-01", endDate: "2026-12-31" });
      expect(windowed.body.transactions).toEqual([]);

      const inverted = await w.agent.get(url(supplierId)).query({ startDate: "2026-06-01", endDate: "2026-02-01" });
      expect(inverted.body).toMatchObject({ openingBalance: 0, openingBalanceSide: "Cr", periodOpeningBalance: 0 });

      const unknown = await w.agent.get(url(999999999));
      expect(unknown.status).toBe(200);
      expect(unknown.body).toMatchObject({ transactions: [], openingBalance: 0, openingBalanceSide: "Cr" });
    });
  });
});
