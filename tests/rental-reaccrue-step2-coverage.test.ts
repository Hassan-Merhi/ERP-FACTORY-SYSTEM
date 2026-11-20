/**
 * POST /api/factory/rental/re-accrue
 * (server/routes/rental/registerRentalAccrualConfigRoutesStep2.ts), against a
 * real factory company inside one rolled-back transaction per test.
 *
 * Pinned: no shop contract is a no-op; unpaid accruals are retired and
 * re-posted; a payment made before its accrual gets exactly one phantom
 * correction (never a second one); AP-debiting payments and AP-CLEAR journals
 * are left alone; a combined accrual voucher still referenced by a paid month
 * is never retired; a deleted accrual link is refused for review.
 */
import { describe, expect, it } from "vitest";

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";

const URL = "/api/factory/rental/re-accrue";

async function shopContract(w: FactoryWorld, unitType = "SHOP") {
  const unitId = await w.one(
    `INSERT INTO property_units (company_id, module, unit_type, unit_number, location_group, active)
     VALUES ($1, 'FACTORY', $2, $3, 'RA', true) RETURNING id`,
    [w.companyId, unitType, `${w.tag}-${unitType}`]
  );
  const contractId = await w.one(
    `INSERT INTO property_contracts (company_id, module, unit_id, tenant_name, rental_amount, start_date, status, currency)
     VALUES ($1, 'FACTORY', $2, 'Landlord', '100.00', '2026-08-01', 'ACTIVE', 'USD') RETURNING id`,
    [w.companyId, unitId]
  );
  return { unitId, contractId };
}

const rows = (w: FactoryWorld, contractId: number) =>
  w.q<{ id: number; accrual_voucher_id: number | null; year: number; month: number }>(
    `SELECT id, accrual_voucher_id, year, month FROM property_monthly_ledger WHERE contract_id = $1 ORDER BY year, month`,
    [contractId]
  );

/** The exact-code rent control accounts the corrections look up (reused by the accrual passes). */
async function rentAccounts(w: FactoryWorld) {
  const ap = await w.one(
    `INSERT INTO ledger_accounts (company_id, code, name, account_type, opening_balance, active)
     VALUES ($1, 'ACCR-RENT-PAY', 'Accrued Rent Payable', 'Liability', '0', TRUE) RETURNING id`,
    [w.companyId]
  );
  const expense = await w.one(
    `INSERT INTO ledger_accounts (company_id, code, name, account_type, opening_balance, active)
     VALUES ($1, 'SHOP-RENT-EXP', 'Rent Expense - Factory Shops', 'Indirect Expense', '0', TRUE) RETURNING id`,
    [w.companyId]
  );
  return { ap, expense };
}

const journals = (w: FactoryWorld, like: string) =>
  w.q(`SELECT id FROM vouchers WHERE company_id = $1 AND description LIKE $2 AND deleted_at IS NULL`, [
    w.companyId,
    like,
  ]);

/** A paid month: a Payment voucher (debiting `debitAccount`) linked to the ledger row. */
async function pay(
  w: FactoryWorld,
  contract: { unitId: number; contractId: number },
  row: { id: number; year: number; month: number },
  debitAccount: number,
  cash: number,
  number: string
) {
  const voucherId = await w.one(
    `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, total_amount)
     VALUES ($1, $2, 'Payment', '2026-08-05', 40) RETURNING id`,
    [w.companyId, number]
  );
  await w.q(
    `INSERT INTO voucher_entries (voucher_id, ledger_account_id, debit_amount, credit_amount)
     VALUES ($1, $2, 40, 0), ($1, $3, 0, 40)`,
    [voucherId, debitAccount, cash]
  );
  await w.q(`UPDATE property_monthly_ledger SET paid_amount = 40 WHERE id = $1`, [row.id]);
  await w.q(
    `INSERT INTO property_payments (company_id, module, contract_id, unit_id, ledger_row_id, amount, payment_date,
       for_year, for_month, voucher_id)
     VALUES ($1, 'FACTORY', $2, $3, $4, 40, '2026-08-05', $5, $6, $7)`,
    [w.companyId, contract.contractId, contract.unitId, row.id, row.year, row.month, voucherId]
  );
  return voucherId;
}

describe("rental re-accrue", () => {
  it("does nothing without an active shop contract", async () => {
    await withFactoryWorld(async (w) => {
      await shopContract(w, "OFFICE");
      const res = await w.agent.post(URL).send({});
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ reset: 0, accrued: 0, skipped: 0 });
      const vouchers = await w.q(`SELECT id FROM vouchers WHERE company_id = $1`, [w.companyId]);
      expect(vouchers).toEqual([]);
    });
  });

  it("retires unpaid accruals and posts them again", async () => {
    await withFactoryWorld(async (w) => {
      const contract = await shopContract(w);
      const first = await w.agent.post(URL).send({});
      expect(first.status).toBe(200);
      expect(first.body.reset).toBe(0);
      expect(first.body.accrued).toBeGreaterThan(0);
      const accrued = (await rows(w, contract.contractId)).filter((r) => r.accrual_voucher_id != null);
      expect(accrued.length).toBe(first.body.accrued);

      const second = await w.agent.post(URL).send({});
      expect(second.status).toBe(200);
      expect(second.body.reset).toBeGreaterThan(0);
      expect(second.body.accrued).toBe(first.body.accrued);
      const oldVoucher = accrued[0].accrual_voucher_id;
      const [retired] = await w.q(`SELECT deleted_at FROM vouchers WHERE id = $1`, [oldVoucher]);
      expect(retired.deleted_at).not.toBeNull();
    });
  });

  it("posts one phantom correction for a pre-accrual payment and leaves AP-settled months alone", async () => {
    await withFactoryWorld(async (w) => {
      const contract = await shopContract(w);
      const { ap, expense } = await rentAccounts(w);
      expect((await w.agent.post(URL).send({})).status).toBe(200);
      const cash = await w.one(
        `INSERT INTO ledger_accounts (company_id, code, name, account_type, opening_balance, active)
         VALUES ($1, $2, 'Cash', 'Asset', '0', TRUE) RETURNING id`,
        [w.companyId, `${w.tag}CASH`]
      );
      const accrued = (await rows(w, contract.contractId)).filter((r) => r.accrual_voucher_id != null);
      expect(accrued.length).toBeGreaterThanOrEqual(3);
      // Month 1: paid before accrual (expense debit only) -> phantom.
      await pay(w, contract, accrued[0], expense, cash, `${w.tag}-P1`);
      // Month 2: the payment debited AP -> already correct.
      await pay(w, contract, accrued[1], ap, cash, `${w.tag}-P2`);
      // Month 3: expense-only payment cleared by its AP-CLEAR journal -> already correct.
      const p3 = await pay(w, contract, accrued[2], expense, cash, `${w.tag}-P3`);
      const clear = await w.one(
        `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, total_amount)
         VALUES ($1, $2, 'Journal', '2026-08-05', 40) RETURNING id`,
        [w.companyId, `AP-CLEAR-${p3}`]
      );
      await w.q(
        `INSERT INTO voucher_entries (voucher_id, ledger_account_id, debit_amount, credit_amount)
         VALUES ($1, $2, 40, 0), ($1, $3, 0, 40)`,
        [clear, ap, expense]
      );
      // Every other month paid through AP, so no unpaid row shares the combined accrual voucher.
      for (const [i, row] of accrued.slice(3).entries()) await pay(w, contract, row, ap, cash, `${w.tag}-PX${i}`);

      const res = await w.agent.post(URL).send({});
      expect(res.status).toBe(200);
      const phantom = await journals(w, "Phantom accrual correction%");
      expect(phantom).toHaveLength(1);
      const lines = await w.q(
        `SELECT ledger_account_id, debit_amount::numeric(18,2)::text AS dr, credit_amount::numeric(18,2)::text AS cr, narration
           FROM voucher_entries WHERE voucher_id = $1 ORDER BY id`,
        [phantom[0].id]
      );
      expect(lines).toEqual([
        {
          ledger_account_id: ap,
          dr: "40.00",
          cr: "0.00",
          narration: `Phantom accrual correction — ledger row ${accrued[0].id}`,
        },
        {
          ledger_account_id: expense,
          dr: "0.00",
          cr: "40.00",
          narration: `Phantom accrual correction — ledger row ${accrued[0].id}`,
        },
      ]);
      expect(res.body.reset).toBe(0);
      // Paid months keep their accrual voucher; only unpaid ones are reset.
      const after = await rows(w, contract.contractId);
      expect(after.find((r) => r.id === accrued[0].id)?.accrual_voucher_id).toBe(accrued[0].accrual_voucher_id);

      const again = await w.agent.post(URL).send({});
      expect(again.status, JSON.stringify(again.body)).toBe(200);
      expect(await journals(w, "Phantom accrual correction%")).toHaveLength(1);
    });
  });

  // One accrual voucher covers every month of a run. While a paid month still
  // references it, the unpaid-month reset must not retire it.
  it("keeps a combined accrual voucher that a paid month references, and re-accrues again", async () => {
    await withFactoryWorld(async (w) => {
      const contract = await shopContract(w);
      const { ap } = await rentAccounts(w);
      expect((await w.agent.post(URL).send({})).status).toBe(200);
      const cash = await w.one(
        `INSERT INTO ledger_accounts (company_id, code, name, account_type, opening_balance, active)
         VALUES ($1, $2, 'Cash', 'Asset', '0', TRUE) RETURNING id`,
        [w.companyId, `${w.tag}CASH`]
      );
      const accrued = (await rows(w, contract.contractId)).filter((r) => r.accrual_voucher_id != null);
      expect(accrued.length).toBeGreaterThanOrEqual(2);
      const voucherId = accrued[0].accrual_voucher_id;
      // Paid and unpaid months share the one combined voucher.
      expect(new Set(accrued.map((r) => r.accrual_voucher_id))).toEqual(new Set([voucherId]));
      await pay(w, contract, accrued[0], ap, cash, `${w.tag}-P1`);
      const vouchersBefore = await w.q(`SELECT id FROM vouchers WHERE company_id = $1 ORDER BY id`, [w.companyId]);

      const first = await w.agent.post(URL).send({});
      expect(first.status, JSON.stringify(first.body)).toBe(200);
      expect(first.body).toMatchObject({ reset: 0, accrued: 0 });
      const [voucher] = await w.q(`SELECT deleted_at FROM vouchers WHERE id = $1`, [voucherId]);
      expect(voucher.deleted_at).toBeNull();
      // Paid and unpaid months both keep their accrual; nothing is posted twice.
      const after = await rows(w, contract.contractId);
      for (const row of accrued) {
        expect(after.find((r) => r.id === row.id)?.accrual_voucher_id).toBe(voucherId);
      }
      expect(await w.q(`SELECT id FROM vouchers WHERE company_id = $1 ORDER BY id`, [w.companyId])).toEqual(
        vouchersBefore
      );

      const second = await w.agent.post(URL).send({});
      expect(second.status, JSON.stringify(second.body)).toBe(200);
      expect(second.body).toMatchObject({ reset: 0, accrued: 0 });
      const [still] = await w.q(`SELECT deleted_at FROM vouchers WHERE id = $1`, [voucherId]);
      expect(still.deleted_at).toBeNull();
    });
  });

  it("refuses to re-accrue over a deleted accrual voucher link", async () => {
    await withFactoryWorld(async (w) => {
      const contract = await shopContract(w);
      expect((await w.agent.post(URL).send({})).status).toBe(200);
      const [row] = (await rows(w, contract.contractId)).filter((r) => r.accrual_voucher_id != null);
      const before = await w.q(`SELECT COUNT(*)::int AS n FROM vouchers WHERE company_id = $1`, [w.companyId]);
      await w.q(`UPDATE vouchers SET optional = TRUE WHERE id = $1`, [row.accrual_voucher_id]);
      const res = await w.agent.post(URL).send({});
      expect(res.status).toBe(409);
      expect(res.body.code).toBe("RENTAL_DANGLING_ACCRUAL_REQUIRES_REVIEW");
      const after = await w.q(`SELECT COUNT(*)::int AS n FROM vouchers WHERE company_id = $1`, [w.companyId]);
      expect(after[0].n).toBe(before[0].n);
      const [kept] = await w.q(`SELECT accrual_voucher_id FROM property_monthly_ledger WHERE id = $1`, [row.id]);
      expect(kept.accrual_voucher_id).toBe(row.accrual_voucher_id);
    });
  });

  it("corrects an orphaned AP debit once when a dangling row escapes the company audit", async () => {
    await withFactoryWorld(async (w) => {
      const contract = await shopContract(w);
      const { ap } = await rentAccounts(w);
      expect((await w.agent.post(URL).send({})).status).toBe(200);
      const cash = await w.one(
        `INSERT INTO ledger_accounts (company_id, code, name, account_type, opening_balance, active)
         VALUES ($1, $2, 'Cash', 'Asset', '0', TRUE) RETURNING id`,
        [w.companyId, `${w.tag}CASH`]
      );
      const other = await w.one(
        `INSERT INTO companies (code, name, company_type, base_currency) VALUES ($1::varchar, $1::text, 'factory', 'USD') RETURNING id`,
        [`${w.tag}X`]
      );
      const [row] = (await rows(w, contract.contractId)).filter((r) => r.accrual_voucher_id != null);
      await pay(w, contract, row, ap, cash, `${w.tag}-PO`);
      // A legacy row stamped with another company id: the company-scoped
      // reconciliation does not see it, the contract-scoped sweep does.
      const gone = await w.one(
        `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, total_amount, deleted_at)
         VALUES ($1, $2, 'Journal', '2026-08-01', 0, NOW()) RETURNING id`,
        [w.companyId, `${w.tag}-GONE`]
      );
      await w.q(`UPDATE property_monthly_ledger SET company_id = $1, accrual_voucher_id = $2 WHERE id = $3`, [
        other,
        gone,
        row.id,
      ]);

      const res = await w.agent.post(URL).send({});
      expect(res.status).toBe(200);
      expect(await journals(w, "Orphaned AP debit correction%")).toHaveLength(1);
      const [cleared] = await w.q(`SELECT accrual_voucher_id FROM property_monthly_ledger WHERE id = $1`, [row.id]);
      expect(cleared.accrual_voucher_id).toBeNull();
    });
  });
});
