/**
 * Read-only HADI linked-rent control (getHadiLinkedRentControl): the payer and
 * as-of guards, the no-contract shortcut, due-month filtering (future months and
 * rows booked under the wrong company are ignored), paid vs unmatched posted
 * receipts (deleted voucher), owned-shop arrears, the payable-control guard and
 * both opening-balance sides.
 *
 * The control is pinned to fixed company ids (1 payer, 13 Properties) and
 * payable ledger 1021, so the fixture upserts those rows inside a transaction
 * that is always rolled back.
 */
import { describe, expect, it } from "vitest";

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";
import { getHadiLinkedRentControl } from "../server/services/rental/hadiLinkedRentProtection";

const failure = (work: Promise<unknown>) =>
  work.then(
    () => "resolved",
    (error: Error) => error.message
  );

async function hadiWorld(fw: FactoryWorld) {
  const q = fw.q;
  const id = fw.one;
  const tag = `HADI${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`.toUpperCase();
  for (const companyId of [1, 13]) {
    await q(`INSERT INTO companies (id, code, name) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING`, [
      companyId,
      `${tag}${companyId}`,
      `${tag} ${companyId}`,
    ]);
  }
  await q(
    `INSERT INTO ledger_accounts (id, company_id, code, name, account_type, opening_balance, opening_balance_side, active)
     VALUES (1021, 1, $1, 'Accrued Rent Payable', 'Liability', '10', 'Cr', TRUE)
     ON CONFLICT (id) DO UPDATE SET company_id = 1, name = 'Accrued Rent Payable', account_type = 'Liability',
       opening_balance = '10', opening_balance_side = 'Cr', active = TRUE, deleted_at = NULL`,
    [`${tag}-ARP`]
  );
  const unit = (companyId: number, module: string, type: string) =>
    id(
      `INSERT INTO property_units (company_id, module, unit_number, unit_type, location_group)
       VALUES ($1, $2, $3, $4, 'Main') RETURNING id`,
      [companyId, module, `${tag}-${module}-${type}`, type]
    );
  const contract = (companyId: number, module: string, unitId: number, linked: number | null, start: string) =>
    id(
      `INSERT INTO property_contracts (company_id, module, unit_id, tenant_name, start_date, linked_company_id, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'ACTIVE') RETURNING id`,
      [companyId, module, unitId, `${tag} tenant`, start, linked]
    );
  const month = (
    companyId: number,
    module: string,
    contractId: number,
    unitId: number,
    ym: [number, number],
    amount: string
  ) =>
    id(
      `INSERT INTO property_monthly_ledger (company_id, module, contract_id, unit_id, year, month, expected_amount)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [companyId, module, contractId, unitId, ym[0], ym[1], amount]
    );
  const voucher = (companyId: number, number: string, deleted: boolean) =>
    id(
      `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, total_amount, deleted_at)
       VALUES ($1, $2, 'Receipt', '2026-02-10', '0', CASE WHEN $3::boolean THEN now() END) RETURNING id`,
      [companyId, `${tag}-${number}`, deleted]
    );
  const payment = (contractId: number, unitId: number, ledgerRowId: number, voucherId: number, amount: string) =>
    q(
      `INSERT INTO property_payments (company_id, module, contract_id, unit_id, ledger_row_id, voucher_id, amount,
         payment_date, for_year, for_month, posting_status)
       VALUES (13, 'PROPERTIES', $1, $2, $3, $4, $5, '2026-02-10', 2026, 1, 'POSTED')`,
      [contractId, unitId, ledgerRowId, voucherId, amount]
    );
  return { q, id, tag, unit, contract, month, voucher, payment };
}

describe("getHadiLinkedRentControl guards", () => {
  it("refuses any payer other than the linked company and malformed dates", async () => {
    expect(await failure(getHadiLinkedRentControl(13, "2026-03-01"))).toBe("HADI_LINKED_RENT_WRONG_COMPANY");
    expect(await failure(getHadiLinkedRentControl(1, "2026-02-31"))).toBe("HADI_LINKED_RENT_INVALID_AS_OF_DATE");
    expect(await failure(getHadiLinkedRentControl(1, "yesterday"))).toBe("HADI_LINKED_RENT_INVALID_AS_OF_DATE");
  });

  it("refuses when the payable control ledger was renamed, retyped, deactivated or deleted", async () => {
    await withFactoryWorld(async (fw) => {
      const world = await hadiWorld(fw);
      for (const change of [
        `UPDATE ledger_accounts SET name = 'Renamed' WHERE id = 1021`,
        `UPDATE ledger_accounts SET name = 'Accrued Rent Payable', account_type = 'Asset' WHERE id = 1021`,
        `UPDATE ledger_accounts SET account_type = 'Liability', opening_balance = 0, active = FALSE WHERE id = 1021`,
        `UPDATE ledger_accounts SET active = TRUE, deleted_at = now() WHERE id = 1021`,
        `UPDATE ledger_accounts SET deleted_at = NULL, company_id = 13 WHERE id = 1021`,
      ]) {
        await world.q(change);
        expect(await failure(getHadiLinkedRentControl(1, "2026-03-01"))).toBe("HADI_RENT_PAYABLE_CONTROL_CHANGED");
      }
    });
  });
});

describe("getHadiLinkedRentControl totals", () => {
  it("compares linked and owned-shop arrears with the accrued payable", async () => {
    await withFactoryWorld(async (fw) => {
      const world = await hadiWorld(fw);
      const before = await getHadiLinkedRentControl(1, "2026-03-01");

      const propertiesUnit = await world.unit(13, "PROPERTIES", "SHOP");
      const linked = await world.contract(13, "PROPERTIES", propertiesUnit, 1, "2026-01-05");
      const jan = await world.month(13, "PROPERTIES", linked, propertiesUnit, [2026, 1], "100");
      const feb = await world.month(13, "PROPERTIES", linked, propertiesUnit, [2026, 2], "100");
      await world.month(13, "PROPERTIES", linked, propertiesUnit, [2026, 12], "100"); // not yet due
      await world.month(1, "PROPERTIES", linked, propertiesUnit, [2025, 12], "999"); // wrong company

      const shop = await world.unit(1, "ERP", "SHOP");
      const owned = await world.contract(1, "ERP", shop, null, "2026-01-01");
      await world.month(1, "ERP", owned, shop, [2026, 1], "50");
      const office = await world.unit(1, "ERP", "OFFICE");
      const notShop = await world.contract(1, "ERP", office, null, "2026-01-01");
      await world.month(1, "ERP", notShop, office, [2026, 1], "70");

      await world.payment(linked, propertiesUnit, jan, await world.voucher(13, "R1", false), "60");
      await world.payment(linked, propertiesUnit, feb, await world.voucher(13, "R2", true), "40");

      const journal = await world.voucher(1, "J1", false);
      await world.q(
        `INSERT INTO voucher_entries (company_id, voucher_id, ledger_account_id, debit_amount, credit_amount)
         VALUES (1, $1, 1021, '0', '30')`,
        [journal]
      );

      const result = await getHadiLinkedRentControl(1, "2026-03-01");
      const row = result.contracts.find((c) => c.contractId === linked);
      expect(row).toEqual({
        contractId: linked,
        tenantName: `${world.tag} tenant`,
        expectedAsOf: "200.00",
        paidAsOf: "60.00",
        outstanding: "140.00",
      });
      expect(result.linkedContracts - before.linkedContracts).toBe(1);
      expect(Number(result.linkedOutstanding) - Number(before.linkedOutstanding)).toBeCloseTo(140, 2);
      expect(Number(result.ownedShopOutstanding) - Number(before.ownedShopOutstanding)).toBeCloseTo(50, 2);
      expect(result.unmatchedPostedPayments - before.unmatchedPostedPayments).toBe(1);
      expect(Number(result.accruedRentPayableCredit) - Number(before.accruedRentPayableCredit)).toBeCloseTo(30, 2);
      expect(result.status).toBe("REVIEW");
      expect(result).toMatchObject({ asOf: "2026-03-01", payerCompanyId: 1, propertiesCompanyId: 13 });

      // A debit-side opening balance is subtracted instead of added.
      await world.q(`UPDATE ledger_accounts SET opening_balance_side = 'Dr' WHERE id = 1021`);
      const debit = await getHadiLinkedRentControl(1, "2026-03-01");
      expect(Number(result.accruedRentPayableCredit) - Number(debit.accruedRentPayableCredit)).toBeCloseTo(20, 2);

      // Before the first due date nothing is outstanding for the new contracts.
      const early = await getHadiLinkedRentControl(1, "2025-12-31");
      expect(early.contracts.find((c) => c.contractId === linked)).toMatchObject({
        expectedAsOf: "0.00",
        paidAsOf: "0.00",
        outstanding: "0.00",
      });
    });
  });
});
