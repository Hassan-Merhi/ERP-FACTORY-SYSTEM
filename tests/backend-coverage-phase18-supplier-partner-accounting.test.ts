/**
 * Phase 18 backend coverage — Supplier Partner accounting controls.
 *
 * These tests use real PostgreSQL rows and exercise both the operational
 * registers and the independently-derived ledger controls. They intentionally
 * verify supplier-facing statement behavior separately from the SP full
 * reconciliation so a broken statement cannot be hidden by a self-comparison.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { pool } from "../server/db";
import { projectGoldenCoastResidualEquity } from "../server/routes/stats/goldenCoastResidualEquityProjection";
import {
  selectCompany,
  setupGoldenCoastPhase5Fixture,
  teardownGoldenCoastPhase5Fixture,
  type GoldenCoastPhase5Fixture,
} from "./helpers/goldenCoastPhase5Fixture";

const PREFIX = "p18sp";
const TX_DATE = "2026-09-14";

type ReconciliationSurface = {
  key: string;
  databaseValue: number;
  reportValue: number;
  pass: boolean;
};

type ReconciliationReport = {
  status: string;
  mismatchCount: number;
  surfaces: ReconciliationSurface[];
  summary: {
    supplierCount: number;
  };
};

type ProjectionAccount = {
  id?: number;
  name?: string;
  code?: string;
  value?: number;
  category?: string;
};

let fixture: GoldenCoastPhase5Fixture;
let gcSupplierId: number;
let plainSupplierId: number;
let gcBankAccountId: number;

async function insertLedgerAccount(input: {
  companyId: number;
  code: string;
  name: string;
  accountType: string;
  subType?: string | null;
}): Promise<number> {
  const result = await pool.query<{ id: number }>(
    `INSERT INTO ledger_accounts
       (company_id, code, name, account_type, sub_type, opening_balance, opening_balance_side, active, is_hidden)
     VALUES ($1, $2, $3, $4, $5, '0', 'Dr', true, false)
     RETURNING id`,
    [input.companyId, input.code, input.name, input.accountType, input.subType ?? null]
  );
  return result.rows[0].id;
}

async function insertSupplier(companyId: number, suffix: string, openingBalance = "0"): Promise<number> {
  const result = await pool.query<{ id: number }>(
    `INSERT INTO suppliers (company_id, code, legal_name, email, opening_balance, active)
     VALUES ($1, $2, $3, $4, $5, true)
     RETURNING id`,
    [
      companyId,
      `${PREFIX}-${suffix}-${companyId}`,
      `${PREFIX} ${suffix} Supplier`,
      `${suffix.toLowerCase()}@phase18.test`,
      openingBalance,
    ]
  );
  return result.rows[0].id;
}

async function insertBalancedSupplierVoucher(input: {
  companyId: number;
  supplierId: number;
  debitAccountId: number;
  payableAccountId: number;
  amount: number;
  voucherNumber: string;
}): Promise<number> {
  const voucher = await pool.query<{ id: number }>(
    `INSERT INTO vouchers
       (company_id, voucher_type, voucher_number, voucher_date, description, total_amount, currency, exchange_rate, source_module)
     VALUES ($1, 'Journal', $2, $3, 'Phase 18 supplier payable control', $4, 'USD', '1', 'SP')
     RETURNING id`,
    [input.companyId, input.voucherNumber, TX_DATE, String(input.amount)]
  );
  const voucherId = voucher.rows[0].id;
  await pool.query(
    `INSERT INTO voucher_entries
       (voucher_id, ledger_account_id, debit_amount, credit_amount, narration)
     VALUES ($1, $2, $3, '0', 'Phase 18 supplier purchase debit')`,
    [voucherId, input.debitAccountId, String(input.amount)]
  );
  await pool.query(
    `INSERT INTO voucher_entries
       (voucher_id, ledger_account_id, supplier_id, debit_amount, credit_amount, narration)
     VALUES ($1, $2, $3, '0', $4, 'Phase 18 supplier payable credit')`,
    [voucherId, input.payableAccountId, input.supplierId, String(input.amount)]
  );
  return voucherId;
}

function surface(report: ReconciliationReport, key: string): ReconciliationSurface {
  const row = report.surfaces.find((candidate) => candidate.key === key);
  if (!row) throw new Error(`Missing reconciliation surface ${key}`);
  return row;
}

beforeAll(async () => {
  fixture = await setupGoldenCoastPhase5Fixture(PREFIX);

  await insertLedgerAccount({
    companyId: fixture.ctx.companyId,
    code: "P18-GC-OTW",
    name: "Phase 18 Goods OTW",
    accountType: "Asset",
    subType: "sp_goods_otw",
  });
  await insertLedgerAccount({
    companyId: fixture.ctx.companyId,
    code: "P18-GC-OTWC",
    name: "Phase 18 Goods OTW Clearing",
    accountType: "Liability",
    subType: "sp_otw_clearing",
  });
  await insertLedgerAccount({
    companyId: fixture.ctx.companyId,
    code: "P18-GC-PRE",
    name: "Phase 18 Prepaid",
    accountType: "Asset",
    subType: "sp_prepaid",
  });

  const bank = await pool.query<{ id: number }>(
    `INSERT INTO bank_accounts
       (company_id, code, name, bank_name, account_number, opening_balance, opening_balance_side, active)
     VALUES ($1, $2, 'Phase 18 Bank', 'Phase 18 Bank', 'P18-001', '0', 'Dr', true)
     RETURNING id`,
    [fixture.ctx.companyId, `${PREFIX}-BANK-${fixture.ctx.companyId}`]
  );
  gcBankAccountId = bank.rows[0].id;

  gcSupplierId = await insertSupplier(fixture.ctx.companyId, "GC");
  plainSupplierId = await insertSupplier(fixture.plainCompanyId, "PLAIN", "125.00");
}, 120000);

afterAll(async () => {
  if (fixture) {
    const companyIds = [fixture.ctx.companyId, fixture.plainCompanyId, fixture.hadiCompanyId];
    await pool
      .query(`DELETE FROM sp_offload_charges WHERE company_id = ANY($1::int[])`, [companyIds])
      .catch(() => undefined);
    await pool.query(`DELETE FROM sp_offloads WHERE company_id = ANY($1::int[])`, [companyIds]).catch(() => undefined);
    await pool
      .query(`DELETE FROM sp_prepaid_charges WHERE company_id = ANY($1::int[])`, [companyIds])
      .catch(() => undefined);
    await pool
      .query(`DELETE FROM sp_container_lines WHERE company_id = ANY($1::int[])`, [companyIds])
      .catch(() => undefined);
    await pool
      .query(`DELETE FROM sp_containers WHERE company_id = ANY($1::int[])`, [companyIds])
      .catch(() => undefined);
    await pool
      .query(`DELETE FROM bank_accounts WHERE company_id = ANY($1::int[])`, [companyIds])
      .catch(() => undefined);
    await teardownGoldenCoastPhase5Fixture(fixture);
  }
}, 120000);

describe.sequential("Phase 18 Supplier Partner accounting controls", () => {
  it("posts supplier purchases and prepaid charges to balanced independent accounting evidence", async () => {
    await selectCompany(fixture, fixture.ctx.companyId);

    const container = await fixture.agent.post("/api/sp/containers").send({
      supplierId: gcSupplierId,
      supplierName: `${PREFIX} GC Supplier`,
      containerNumber: "P18CONT0001",
      invoiceNumber: "P18-INV-001",
      invoiceDate: TX_DATE,
      invoiceTotalUsd: 500,
      discountPct: 0,
      freightEstimateUsd: 0,
      lines: [
        {
          articleCode: "P18-ARTICLE",
          description: "Phase 18 purchase",
          qty: 10,
          unitRateUsd: 50,
          stockItemId: fixture.goldenCoastStockItemId,
        },
      ],
    });
    expect(container.status, container.text).toBe(200);

    const prepaid = await fixture.agent.post("/api/sp/prepaid").send({
      containerId: container.body.id,
      prepaidDate: TX_DATE,
      chargeType: "freight",
      agentName: "Phase 18 Agent",
      amountPaidUsd: 80,
      bankAccountId: gcBankAccountId,
      notes: "Phase 18 prepaid accounting",
    });
    expect(prepaid.status, prepaid.text).toBe(200);
    expect(Number(prepaid.body.voucherId)).toBeGreaterThan(0);

    const purchaseVoucher = await pool.query<{
      debit: string;
      credit: string;
      supplier_credits: string;
    }>(
      `SELECT
         COALESCE(SUM(ve.debit_amount::numeric), 0)::text AS debit,
         COALESCE(SUM(ve.credit_amount::numeric), 0)::text AS credit,
         COALESCE(SUM(CASE WHEN ve.supplier_id = $2 THEN ve.credit_amount::numeric ELSE 0 END), 0)::text AS supplier_credits
       FROM vouchers v
       JOIN voucher_entries ve ON ve.voucher_id = v.id
       WHERE v.company_id = $1 AND v.id = (SELECT goods_otw_voucher_id FROM sp_containers WHERE id = $3)`,
      [fixture.ctx.companyId, gcSupplierId, container.body.id]
    );
    expect(Number(purchaseVoucher.rows[0].debit)).toBe(500);
    expect(Number(purchaseVoucher.rows[0].credit)).toBe(500);
    expect(Number(purchaseVoucher.rows[0].supplier_credits)).toBe(500);

    const prepaidVoucher = await pool.query<{ debit: string; credit: string }>(
      `SELECT
         COALESCE(SUM(debit_amount::numeric), 0)::text AS debit,
         COALESCE(SUM(credit_amount::numeric), 0)::text AS credit
       FROM voucher_entries WHERE voucher_id = $1`,
      [prepaid.body.voucherId]
    );
    expect(Number(prepaidVoucher.rows[0].debit)).toBe(80);
    expect(Number(prepaidVoucher.rows[0].credit)).toBe(80);
  }, 120000);

  it("independently reconciles supplier statements, payable control, OTW and prepaid balances", async () => {
    await selectCompany(fixture, fixture.ctx.companyId);

    await insertBalancedSupplierVoucher({
      companyId: fixture.ctx.companyId,
      supplierId: gcSupplierId,
      debitAccountId: fixture.stockInHandAccountId,
      payableAccountId: fixture.saleSideAccountId,
      amount: 250,
      voucherNumber: `P18-GC-PAY-${fixture.ctx.companyId}`,
    });

    const statement = await fixture.agent
      .get(`/api/suppliers/${gcSupplierId}/unified-ledger`)
      .query({ companyId: fixture.ctx.companyId });
    expect(statement.status, statement.text).toBe(200);
    const statementRows = statement.body as Array<{ type: string; credit: number; debit: number; balance: number }>;
    expect(statementRows.some((row) => row.type === "voucher" && row.credit === 500)).toBe(true);
    expect(statementRows.some((row) => row.type === "voucher" && row.credit === 250)).toBe(true);
    expect(statementRows.at(-1)?.balance).toBe(750);

    const reconciliation = await fixture.agent.get("/api/sp/reconciliation/full");
    expect(reconciliation.status, reconciliation.text).toBe(200);
    const reconciliationBody = reconciliation.body as ReconciliationReport;
    expect(reconciliationBody.status).toBe("PASS");
    expect(reconciliationBody.mismatchCount).toBe(0);

    expect(surface(reconciliationBody, "goods_otw_open")).toMatchObject({
      databaseValue: 500,
      reportValue: 500,
      pass: true,
    });
    expect(surface(reconciliationBody, "supplier_statements")).toMatchObject({
      databaseValue: 500,
      reportValue: 500,
      pass: true,
    });
    expect(surface(reconciliationBody, "supplier_statement_control")).toMatchObject({
      databaseValue: 750,
      reportValue: 750,
      pass: true,
    });
    expect(surface(reconciliationBody, "supplier_payable_control")).toMatchObject({
      databaseValue: 250,
      reportValue: 250,
      pass: true,
    });
    expect(surface(reconciliationBody, "prepaid_balances")).toMatchObject({
      databaseValue: 80,
      reportValue: 80,
      pass: true,
    });
  }, 120000);

  it("keeps non-parent Supplier Partner supplier visibility and statements company-scoped", async () => {
    await selectCompany(fixture, fixture.plainCompanyId);

    const listed = await fixture.agent.get("/api/suppliers?allowParentFallback=true");
    expect(listed.status, listed.text).toBe(200);
    const listedIds = (listed.body as Array<{ id: number }>).map((supplier) => supplier.id);
    expect(listedIds).toContain(plainSupplierId);
    expect(listedIds).not.toContain(gcSupplierId);

    const plainExpenseAccountId = await insertLedgerAccount({
      companyId: fixture.plainCompanyId,
      code: "P18-PLN-PUR",
      name: "Phase 18 Plain Purchases",
      accountType: "Direct Expense",
      subType: "phase18_plain_purchase",
    });
    await insertBalancedSupplierVoucher({
      companyId: fixture.plainCompanyId,
      supplierId: plainSupplierId,
      debitAccountId: plainExpenseAccountId,
      payableAccountId: fixture.plainPayableAccountId,
      amount: 75,
      voucherNumber: `P18-PLN-PAY-${fixture.plainCompanyId}`,
    });

    const statement = await fixture.agent
      .get(`/api/suppliers/${plainSupplierId}/unified-ledger`)
      .query({ companyId: fixture.plainCompanyId });
    expect(statement.status, statement.text).toBe(200);
    const rows = statement.body as Array<{ type: string; companyId: number | null; balance: number }>;
    expect(rows.some((row) => row.type === "opening")).toBe(false);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ type: "voucher", companyId: fixture.plainCompanyId, balance: 75 });

    const reconciliation = await fixture.agent.get("/api/sp/reconciliation/full");
    expect(reconciliation.status, reconciliation.text).toBe(200);
    const reconciliationBody = reconciliation.body as ReconciliationReport;
    expect(surface(reconciliationBody, "supplier_statement_control")).toMatchObject({
      databaseValue: 75,
      reportValue: 75,
      pass: true,
    });
    expect(surface(reconciliationBody, "supplier_payable_control")).toMatchObject({
      databaseValue: 75,
      reportValue: 75,
      pass: true,
    });
    expect(reconciliationBody.summary.supplierCount).toBe(1);
  }, 120000);

  it("verifies Golden Coast Net Position projection rules without changing ordinary Supplier Partner output", () => {
    const baseBody = {
      forUs: { total: 0, accounts: [] as ProjectionAccount[], breakdown: [] },
      onUs: { total: 0, accounts: [] as ProjectionAccount[], breakdown: [] },
      equity: {},
      netPositionBreakdown: {},
    };
    const gcAccounts = [
      {
        id: 1,
        name: "Fresh Start FZ Equity",
        code: "GC-FSCAP",
        accountType: "Equity",
        subType: "gc_partner_capital",
        openingBalance: "0",
        openingBalanceSide: "Cr",
        active: true,
      },
      {
        id: 2,
        name: "Hassan Dakik Equity",
        code: "GC-HCAP",
        accountType: "Equity",
        subType: "gc_owner_capital",
        openingBalance: "40",
        openingBalanceSide: "Cr",
        active: true,
      },
      {
        id: 3,
        name: "GC Sales Cash",
        code: "SP-PAY",
        accountType: "Liability",
        subType: "sp_payable",
        openingBalance: "0",
        openingBalanceSide: "Cr",
        active: true,
      },
      {
        id: 4,
        name: "Customer Account — must stay out",
        code: "CUST-001",
        accountType: "Customer",
        subType: "Accounts Receivable",
        openingBalance: "0",
        openingBalanceSide: "Dr",
        active: true,
      },
      {
        id: 5,
        name: "HADI Intercompany",
        code: "GC-IC-HADI",
        accountType: "Asset",
        subType: "sp_hadi_intercompany",
        openingBalance: "0",
        openingBalanceSide: "Dr",
        active: true,
      },
      {
        id: 6,
        name: "Prepaid Expenses",
        code: "GC-PRE",
        accountType: "Asset",
        subType: "sp_prepaid",
        openingBalance: "0",
        openingBalanceSide: "Dr",
        active: true,
      },
    ];
    const balances = new Map<number, { debit: number; credit: number }>([
      [2, { debit: 0, credit: 0 }],
      [3, { debit: 0, credit: 100 }],
      [4, { debit: 999, credit: 0 }],
      [5, { debit: 100, credit: 0 }],
      [6, { debit: 25, credit: 0 }],
    ]);

    const projected = projectGoldenCoastResidualEquity({
      body: structuredClone(baseBody),
      companyAccounts: gcAccounts,
      accountBalances: balances,
    });
    const projectedAccounts = Array.isArray(projected.forUs?.accounts)
      ? (projected.forUs.accounts as ProjectionAccount[])
      : [];
    expect(projectedAccounts.some((account) => account.id === 4)).toBe(false);
    expect(projectedAccounts.some((account) => account.id === 5)).toBe(false);
    expect(projectedAccounts.find((account) => account.id === 3)).toMatchObject({
      value: 100,
      category: "Cash",
    });
    expect(projectedAccounts.find((account) => account.id === 6)).toMatchObject({
      value: 25,
      category: "Prepaid",
    });
    expect(projected.equity?.hassanClaim).toBe(40);
    expect(projected.equity?.freshStartResidual).toBe(85);
    expect(projected.netPosition).toBe(125);

    const ordinaryBody = structuredClone(baseBody);
    const ordinary = projectGoldenCoastResidualEquity({
      body: ordinaryBody,
      companyAccounts: [
        {
          id: 9,
          name: "Supplier Cash Payable",
          code: "SP-PAY",
          accountType: "Liability",
          subType: "sp_payable",
          openingBalance: "0",
          openingBalanceSide: "Cr",
          active: true,
        },
      ],
      accountBalances: new Map([[9, { debit: 0, credit: 10 }]]),
    });
    expect(ordinary).toBe(ordinaryBody);
  });
});
