/**
 * Property and inter-company rows that /api/admin/repair-balances can find
 * and repair, seeded inside a rolled-back factory world (withFactoryWorld).
 * Every kind of discrepancy the scan reports has one row here; a second
 * company carries the same kinds so scoping can be checked.
 */
import type { FactoryWorld } from "./rolledBackFactoryApp";

export interface BalanceRepairSeed {
  otherCompanyId: number;
  cashId: number;
  warehouseUnitId: number;
  shopUnitId: number;
  contractId: number;
  shopContractId: number;
  staleFlagContractId: number;
  missingFlagContractId: number;
  mismatchContractId: number;
  driftLedgerId: number;
  emptyVoucherId: number;
  deletedShopVoucherId: number;
  erpVoucherId: number;
  factoryVoucherId: number;
  noCashVoucherId: number;
  healthyVoucherId: number;
  toOrphanTransferId: number;
  fromOrphanTransferId: number;
  toOrphanVoucherId: number;
  fromOrphanVoucherId: number;
  otherLedgerId: number;
  otherContractId: number;
}

type Q = FactoryWorld["one"];

async function voucher(one: Q, companyId: number, number: string, total: string, deleted = false, date = "2026-05-10") {
  return one(
    `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, total_amount, description, deleted_at)
     VALUES ($1, $2, 'Receipt', $3::date, $4, $5, CASE WHEN $6::boolean THEN now() ELSE NULL END) RETURNING id`,
    [companyId, number, date, total, `${number} desc`, deleted]
  );
}

async function balancedLines(w: FactoryWorld, voucherId: number, debitId: number, creditId: number, amount: string) {
  await w.q(
    `INSERT INTO voucher_entries (voucher_id, ledger_account_id, debit_amount, credit_amount, narration)
     VALUES ($1, $2, $4, 0, 'dr'), ($1, $3, 0, $4, 'cr')`,
    [voucherId, debitId, creditId, amount]
  );
}

export async function seedBalanceRepair(w: FactoryWorld, date = "2026-05-10"): Promise<BalanceRepairSeed> {
  const { one, companyId, tag } = w;
  const otherCompanyId = await one(
    `INSERT INTO companies (code, name, company_type, base_currency) VALUES ($1::varchar, $1::text, 'factory', 'USD') RETURNING id`,
    [`${tag}X`]
  );
  const account = (cid: number, code: string, name: string, type: string) =>
    one(
      `INSERT INTO ledger_accounts (company_id, code, name, account_type, active) VALUES ($1, $2, $3, $4, true) RETURNING id`,
      [cid, `${tag}${code}`, `${name} ${tag}`, type]
    );
  const cashId = await account(companyId, "C", "Cash", "Cash");
  const incomeId = await account(companyId, "I", "Income", "Income");
  const otherCash = await account(otherCompanyId, "OC", "Other cash", "Cash");
  const otherIncome = await account(otherCompanyId, "OI", "Other income", "Income");

  const unit = (cid: number, type: string, n: string) =>
    one(
      `INSERT INTO property_units (company_id, module, unit_type, unit_number, location_group, active)
       VALUES ($1, 'PROPERTIES', $2, $3, 'Block', true) RETURNING id`,
      [cid, type, n]
    );
  const warehouseUnitId = await unit(companyId, "WAREHOUSE", `${tag}W`);
  const shopUnitId = await unit(companyId, "SHOP", `${tag}S`);
  const otherUnit = await unit(otherCompanyId, "WAREHOUSE", `${tag}OW`);

  const contract = (
    cid: number,
    unitId: number,
    name: string,
    guarantee: string,
    flag: boolean,
    posted: string | null
  ) =>
    one(
      `INSERT INTO property_contracts (company_id, module, unit_id, tenant_name, rental_amount, start_date, status,
         currency, guarantee_amount, guarantee_posted_to_statement, guarantee_posted_amount)
       VALUES ($1, 'PROPERTIES', $2, $3, '100.00', '2026-01-01', 'ACTIVE', 'USD', $4, $5, $6) RETURNING id`,
      [cid, unitId, name, guarantee, flag, posted]
    );
  const contractId = await contract(companyId, warehouseUnitId, "Tenant W", "0", false, null);
  const shopContractId = await contract(companyId, shopUnitId, "Tenant S", "0", false, null);
  const staleFlagContractId = await contract(companyId, warehouseUnitId, "Stale", "300", true, "300");
  const missingFlagContractId = await contract(companyId, warehouseUnitId, "Missing", "400", false, null);
  const mismatchContractId = await contract(companyId, warehouseUnitId, "Mismatch", "500", true, "450");
  const otherContractId = await contract(otherCompanyId, otherUnit, "Other", "200", true, "200");

  const ledger = (cid: number, contract: number, unitId: number | null, month: number, paid: string) =>
    one(
      `INSERT INTO property_monthly_ledger (company_id, module, contract_id, unit_id, year, month, expected_amount, paid_amount)
       VALUES ($1, 'PROPERTIES', $2, $3, 2026, $4, '100.00', $5) RETURNING id`,
      [cid, contract, unitId, month, paid]
    );
  const driftLedgerId = await ledger(companyId, contractId, warehouseUnitId, 4, "100.00");
  await ledger(companyId, contractId, warehouseUnitId, 3, "0.00");
  const otherLedgerId = await ledger(otherCompanyId, otherContractId, otherUnit, 4, "90.00");

  const emptyVoucherId = await voucher(one, companyId, `${tag}-E`, "60.00", false, date);
  const deletedShopVoucherId = await voucher(one, companyId, `${tag}-D`, "40.00", true, date);
  const erpVoucherId = await voucher(one, companyId, `${tag}-ERP`, "10.00", false, date);
  const factoryVoucherId = await voucher(one, companyId, `${tag}-FAC`, "11.00", false, date);
  const noCashVoucherId = await voucher(one, companyId, `${tag}-NC`, "12.00", false, date);
  const healthyVoucherId = await voucher(one, companyId, `${tag}-H`, "13.00", false, date);
  await balancedLines(w, healthyVoucherId, cashId, incomeId, "13.00");
  const otherEmpty = await voucher(one, otherCompanyId, `${tag}-OE`, "5.00", false, date);

  const payment = (
    cid: number,
    contract: number,
    unitId: number,
    amount: string,
    voucherId: number | null,
    cash: number | null,
    ledgerRow: number | null,
    module = "PROPERTIES"
  ) =>
    one(
      `INSERT INTO property_payments (company_id, module, contract_id, unit_id, amount, payment_date, for_year, for_month,
         voucher_id, cash_account_id, ledger_row_id)
       VALUES ($1, $8, $2, $3, $4, $9::date, 2026, 4, $5, $6, $7) RETURNING id`,
      [cid, contract, unitId, amount, voucherId, cash, ledgerRow, module, date]
    );
  await payment(companyId, contractId, warehouseUnitId, "35.00", emptyVoucherId, cashId, driftLedgerId);
  await payment(companyId, contractId, warehouseUnitId, "25.00", emptyVoucherId, cashId, driftLedgerId);
  await payment(companyId, shopContractId, shopUnitId, "40.00", deletedShopVoucherId, cashId, null);
  await payment(companyId, contractId, warehouseUnitId, "10.00", erpVoucherId, cashId, null, "ERP");
  await payment(companyId, contractId, warehouseUnitId, "11.00", factoryVoucherId, cashId, null, "FACTORY");
  await payment(companyId, contractId, warehouseUnitId, "12.00", noCashVoucherId, null, null);
  await payment(companyId, contractId, warehouseUnitId, "13.00", healthyVoucherId, cashId, null);
  await payment(otherCompanyId, otherContractId, otherUnit, "5.00", otherEmpty, otherCash, null);

  // Guarantee vouchers: GUAR-<contractId>.
  const missingGuar = await voucher(one, companyId, `GUAR-${tag}-${missingFlagContractId}`, "400.00", false, date);
  await balancedLines(w, missingGuar, cashId, incomeId, "400.00");
  const mismatchGuar = await voucher(one, companyId, `GUAR-${tag}-${mismatchContractId}`, "500.00", false, date);
  await balancedLines(w, mismatchGuar, cashId, incomeId, "500.00");

  // Inter-company transfers: one empty TO side, one soft-deleted FROM side,
  // one healthy, one fully broken (both sides empty, not an orphan).
  const transfer = (fromVoucher: number | null, toVoucher: number | null, description: string) =>
    one(
      `INSERT INTO inter_company_transfers (transfer_type, from_company_id, to_company_id, transfer_date, amount,
         from_ledger_account_id, to_ledger_account_id, from_voucher_id, to_voucher_id, description)
       VALUES ('Cash', $1, $2, $7::date, 70, $3, $4, $5, $6, $8) RETURNING id`,
      [companyId, otherCompanyId, cashId, otherCash, fromVoucher, toVoucher, date, description]
    );
  const fromGood = await voucher(one, companyId, `${tag}-TF1`, "70.00", false, date);
  await balancedLines(w, fromGood, incomeId, cashId, "70.00");
  const toOrphanVoucherId = await voucher(one, otherCompanyId, `${tag}-TT1`, "70.00", false, date);
  const toOrphanTransferId = await transfer(fromGood, toOrphanVoucherId, "to side empty");

  const fromOrphanVoucherId = await voucher(one, companyId, `${tag}-TF2`, "70.00", true, date);
  const toGood = await voucher(one, otherCompanyId, `${tag}-TT2`, "70.00", false, date);
  await balancedLines(w, toGood, otherCash, otherIncome, "70.00");
  const fromOrphanTransferId = await transfer(fromOrphanVoucherId, toGood, "from side deleted");

  const healthyFrom = await voucher(one, companyId, `${tag}-TF3`, "70.00", false, date);
  await balancedLines(w, healthyFrom, incomeId, cashId, "70.00");
  const healthyTo = await voucher(one, otherCompanyId, `${tag}-TT3`, "70.00", false, date);
  await balancedLines(w, healthyTo, otherCash, otherIncome, "70.00");
  await transfer(healthyFrom, healthyTo, "healthy");
  await transfer(null, null, "no vouchers");

  return {
    otherCompanyId,
    cashId,
    warehouseUnitId,
    shopUnitId,
    contractId,
    shopContractId,
    staleFlagContractId,
    missingFlagContractId,
    mismatchContractId,
    driftLedgerId,
    emptyVoucherId,
    deletedShopVoucherId,
    erpVoucherId,
    factoryVoucherId,
    noCashVoucherId,
    healthyVoucherId,
    toOrphanTransferId,
    fromOrphanTransferId,
    toOrphanVoucherId,
    fromOrphanVoucherId,
    otherLedgerId,
    otherContractId,
  };
}

/** Everything the apply route can change, for before/after comparisons. */
export async function balanceRepairState(w: FactoryWorld, seed: BalanceRepairSeed) {
  const companies = [w.companyId, seed.otherCompanyId];
  return {
    ledger: await w.q(
      `SELECT id, paid_amount FROM property_monthly_ledger WHERE company_id = ANY($1::int[]) ORDER BY id`,
      [companies]
    ),
    contracts: await w.q(
      `SELECT id, guarantee_posted_to_statement, guarantee_posted_amount FROM property_contracts
        WHERE company_id = ANY($1::int[]) ORDER BY id`,
      [companies]
    ),
    vouchers: await w.q(
      `SELECT id, voucher_number, deleted_at IS NOT NULL AS deleted,
              (SELECT COUNT(*)::int FROM voucher_entries e WHERE e.voucher_id = v.id) AS lines
         FROM vouchers v WHERE company_id = ANY($1::int[]) ORDER BY id`,
      [companies]
    ),
    transfers: await w.q(`SELECT id FROM inter_company_transfers WHERE from_company_id = ANY($1::int[]) ORDER BY id`, [
      companies,
    ]),
    accounts: await w.q(`SELECT id FROM ledger_accounts WHERE company_id = ANY($1::int[]) ORDER BY id`, [companies]),
  };
}

/** Every column of the transfers of both companies, for exact before/after comparisons. */
export async function balanceRepairTransferRows(w: FactoryWorld, seed: BalanceRepairSeed) {
  return w.q(
    `SELECT id, transfer_type, from_company_id, to_company_id, transfer_date::text AS transfer_date,
            amount::text AS amount, from_ledger_account_id, to_ledger_account_id, from_voucher_id,
            to_voucher_id, description, source_payment_id, created_at::text AS created_at
       FROM inter_company_transfers WHERE from_company_id = ANY($1::int[]) ORDER BY id`,
    [[w.companyId, seed.otherCompanyId]]
  );
}
