/**
 * How engine party balances become net position lines: customers, banks,
 * shared and own suppliers, factory suppliers, employees under the ERP and
 * Factory policies, worker advances, lines on missing accounts and the
 * not-in-ledger memo. The balance engine, employee master, salary advances
 * and supplier lookup are stubbed.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  parties: {} as Record<string, unknown[]>,
  missing: [] as unknown[],
  employees: [] as unknown[],
  sharedSuppliers: [] as unknown[],
  outstanding: "0" as string | null,
  advances: [] as unknown[],
  queries: [] as unknown[],
  executes: [] as string[],
}));

vi.mock("../server/services/accounting/balances/ledgerBalanceEngine", () => ({
  getPartyBalances: async (_db: unknown, input: { kind: string; memo: boolean }) => {
    h.queries.push(input);
    return { parties: h.parties[input.kind] ?? [] };
  },
  loadBalanceRows: async () => h.missing,
  toPartyBalance: (row: unknown) => row,
}));
vi.mock("../server/helpers/salaryAdvanceNetPosition", () => ({
  loadSalaryAdvanceNetPositionAdjustments: async () => h.advances,
}));
vi.mock("../server/db", async () => {
  const { PgDialect } = await import("drizzle-orm/pg-core");
  const dialect = new PgDialect();
  const chain = { from: () => chain, where: async () => h.employees };
  return {
    db: {
      select: () => chain,
      execute: async (query: never) => {
        const text = dialect.sqlToQuery(query).sql;
        h.executes.push(text);
        if (text.includes("FROM suppliers")) return { rows: h.sharedSuppliers };
        return { rows: [{ outstanding: h.outstanding }] };
      },
    },
  };
});

import {
  loadNetPositionParties,
  MISSING_ACCOUNT_CATEGORY,
  NET_POSITION_NOT_IN_LEDGER_LABEL,
  notInLedgerSection,
} from "../server/services/accounting/balances/netPositionParties";

type Row = Record<string, unknown>;
const party = (id: number | null, closing: string, over: Row = {}): Row => ({
  id,
  name: `Party ${id}`,
  code: `P${id}`,
  historicalBaseClosing: closing,
  linkedLedgerAccountId: null,
  memoLines: [],
  ...over,
});
const memo = (source: string, amount: string | null) => ({
  source,
  reference: null,
  sourceId: 1,
  date: "2026-10-01",
  amount,
});
const none = {
  asOf: null,
  customers: false,
  suppliers: false,
  factorySuppliers: false,
  employees: false as const,
  codes: "erp" as const,
};
const load = (over: Partial<Parameters<typeof loadNetPositionParties>[1]> = {}) =>
  loadNetPositionParties(3, { ...none, ...over });

beforeEach(() => {
  h.parties = {};
  h.missing = [];
  h.employees = [];
  h.sharedSuppliers = [];
  h.outstanding = "0";
  h.advances = [];
  h.queries = [];
  h.executes = [];
});

describe("notInLedgerSection", () => {
  it("keeps lines with a value or a count and totals them", () => {
    expect(
      notInLedgerSection([
        { label: "a", code: "A", value: 1.005, category: "x", count: 0 },
        { label: "b", code: "B", value: 0, category: "x", count: 2 },
        { label: "c", code: "C", value: 0, category: "x", count: 0 },
        { label: "d", code: "D", value: 2, category: "x", count: 1 },
      ])
    ).toEqual({
      label: NET_POSITION_NOT_IN_LEDGER_LABEL,
      total: 3.01,
      lines: [
        { label: "a", code: "A", value: 1.005, category: "x", count: 0 },
        { label: "b", code: "B", value: 0, category: "x", count: 2 },
        { label: "d", code: "D", value: 2, category: "x", count: 1 },
      ],
    });
  });
});

describe("loadNetPositionParties", () => {
  it("only queries what is asked for and always records customer-owned ledgers", async () => {
    h.parties.customer = [party(1, "50", { linkedLedgerAccountId: 70 })];
    const out = await load();
    expect(h.queries).toEqual([{ companyId: 3, kind: "customer", asOf: null, memo: false }]);
    expect(out).toMatchObject({ forUs: [], onUs: [], forUsTotal: 0, onUsTotal: 0, payrollSigned: 0 });
    expect([...out.customerLedgerIds]).toEqual([70]);
    expect(out.notInLedger).toEqual({ label: NET_POSITION_NOT_IN_LEDGER_LABEL, total: 0, lines: [] });
  });

  it("lists customers by balance side with ERP or Factory codes and groups their memo lines", async () => {
    h.parties.customer = [
      party(1, "150.004", {
        linkedLedgerAccountId: 70,
        memoLines: [memo("factoryInvoice", "20"), memo("factoryInvoice", null)],
      }),
      party(2, "-30", {
        code: null,
        memoLines: [memo("customerBalanceCache", "5"), memo("customerBalanceCache", "-5")],
      }),
      party(3, "0.004"),
    ];
    const erp = await load({ customers: true, asOf: "2026-10-30" });
    expect(h.queries[0]).toEqual({ companyId: 3, kind: "customer", asOf: "2026-10-30", memo: true });
    expect(erp.forUs).toEqual([
      { id: 70, name: "Party 1", category: "Customer", partyKind: "customer", partyId: 1, code: "P1", value: 150 },
    ]);
    expect(erp.onUs).toEqual([
      { name: "Party 2", category: "Customer", partyKind: "customer", partyId: 2, code: "", value: 30 },
    ]);
    expect(erp.notInLedger.lines).toEqual([
      {
        label: "Factory invoices not yet in the ledger",
        code: "NOT_IN_LEDGER_FACTORY_INVOICE",
        value: 20,
        category: "Not yet in the ledger",
        count: 2,
        unconvertedCount: 1,
      },
    ]);
    expect(erp.notInLedger.total).toBe(20);

    // A source with only unconverted amounts is still shown, at zero.
    h.parties.customer = [party(4, "0", { memoLines: [memo("factoryPosDeposit", null)] })];
    expect((await load({ customers: true })).notInLedger.lines).toEqual([
      expect.objectContaining({ code: "NOT_IN_LEDGER_FACTORY_POS_DEPOSIT", value: 0, count: 1, unconvertedCount: 1 }),
    ]);

    h.parties.customer = [party(1, "150"), party(2, "-30")];
    const factory = await load({ customers: true, codes: "factory" });
    expect(factory.forUs[0].code).toBe("CUSTOMER_DR");
    expect(factory.onUs[0].code).toBe("CUSTOMER_CR");
  });

  it("presents bank balances as cash, skipping unidentified banks", async () => {
    h.parties.bank = [party(5, "400"), party(6, "-25.5", { code: null }), party(null, "99"), party(7, "0")];
    const out = await load({ banks: true });
    expect(out.forUs).toEqual([
      { name: "Party 5", code: "P5", category: "Bank", partyKind: "bank", partyId: 5, bankAccountId: 5, value: 400 },
    ]);
    expect(out.onUs).toEqual([
      { name: "Party 6", code: "", category: "Bank", partyKind: "bank", partyId: 6, bankAccountId: 6, value: 25.5 },
    ]);
  });

  it("lists suppliers we owe or overpaid, naming another company's suppliers from their master", async () => {
    h.parties.supplier = [
      party(8, "-500"),
      party(9, "40"),
      party(10, "-60", { code: null, name: "Unknown" }),
      party(11, "-15", { code: null, name: "Fallback" }),
      party(12, "-0.001"),
    ];
    h.sharedSuppliers = [{ id: "10", legal_name: "Shared Co", code: "SH-10" }];
    const out = await load({ suppliers: true });
    expect(h.executes.filter((t) => t.includes("FROM suppliers"))).toHaveLength(1);
    expect(out.onUs).toEqual([
      { name: "Party 8", code: "P8", partyKind: "supplier", partyId: 8, value: 500, category: "Supplier" },
      { name: "Shared Co", code: "SH-10", partyKind: "supplier", partyId: 10, value: 60, category: "Supplier" },
      { name: "Fallback", code: "", partyKind: "supplier", partyId: 11, value: 15, category: "Supplier" },
    ]);
    expect(out.forUs).toEqual([
      { name: "Party 9", code: "P9", partyKind: "supplier", partyId: 9, value: 40, category: "Supplier Overpayment" },
    ]);
    expect(out.onUsTotal).toBe(575);

    h.executes = [];
    h.parties.supplier = [party(8, "-1")];
    await load({ suppliers: true });
    expect(h.executes).toEqual([]);
  });

  it("lists factory suppliers with their own codes and memo lines", async () => {
    h.parties.factorySupplier = [
      party(20, "-75", { memoLines: [memo("factoryContainerFreight", "-12.5")] }),
      party(21, "10"),
      party(22, "0"),
    ];
    const out = await load({ factorySuppliers: true });
    expect(h.queries).toContainEqual({ companyId: 3, kind: "factorySupplier", asOf: null, memo: true });
    expect(out.onUs).toEqual([
      {
        name: "Party 20",
        partyKind: "factorySupplier",
        partyId: 20,
        code: "SUPPLIER",
        value: 75,
        category: "Supplier",
      },
    ]);
    expect(out.forUs).toEqual([
      {
        name: "Party 21",
        partyKind: "factorySupplier",
        partyId: 21,
        code: "SUPPLIER_OVERPAID",
        value: 10,
        category: "Supplier Overpayments",
      },
    ]);
    expect(out.notInLedger.lines).toEqual([
      expect.objectContaining({ code: "NOT_IN_LEDGER_FACTORY_CONTAINER_FREIGHT", value: -12.5, count: 1 }),
    ]);
  });

  it("puts this company's lines on missing accounts in its own totals", async () => {
    h.missing = [
      party(30, "12", { name: "Deleted account" }),
      party(null, "-8", { name: "Other company" }),
      party(31, "0.004"),
    ];
    const out = await load({ missingAccounts: true });
    expect(out.forUs).toEqual([
      {
        name: "Deleted account",
        code: "MISSING_ACCOUNT_30",
        category: MISSING_ACCOUNT_CATEGORY,
        partyKind: "missingAccount",
        partyId: 30,
        value: 12,
      },
    ]);
    expect(out.onUs).toEqual([expect.objectContaining({ code: "MISSING_ACCOUNT_", partyId: null, value: 8 })]);
  });

  it("nets ERP employees from the payroll balance and takes worker advances from the advances table", async () => {
    h.parties.employee = [party(40, "-100"), party(41, "20"), party(42, "300"), party(null, "5")];
    h.employees = [
      { id: 40, type: "Employee", currentBalance: "120" },
      { id: 41, type: "Employee", currentBalance: "-20" },
      { id: 42, type: "Worker", currentBalance: "0" },
    ];
    h.outstanding = "45.5";
    h.advances = [{ remainingBalance: 50, postedDebit: 40 }];
    const out = await load({ employees: "erp", payrollCurrentBalanceMemo: true });
    expect(out.onUs).toEqual([
      {
        name: "Party 40",
        code: "PAYROLL_EMPLOYEE",
        value: 120,
        category: "Payroll",
        partyKind: "employee",
        partyId: 40,
      },
    ]);
    expect(out.forUs).toEqual([
      {
        name: "Worker Advances (Prepaid)",
        code: "WORKER_LEDGER",
        value: 45.5,
        category: "Worker Advances",
        partyKind: "employee",
        partyId: null,
      },
      {
        name: "Party 41",
        code: "EMPLOYEE_RECEIVABLE",
        value: 20,
        category: "Employee Receivable",
        partyKind: "employee",
        partyId: 41,
      },
    ]);
    // 120 owed less 20 receivable.
    expect(out.payrollSigned).toBe(100);
    expect(out.notInLedger.lines).toEqual([
      {
        label: "Salary advances: advances-table remaining balance differs from the ledger",
        code: "NOT_IN_LEDGER_SALARY_ADVANCES",
        value: 10,
        category: "Not yet in the ledger",
        count: 1,
      },
      {
        label: "Payroll: the payroll page's current balance differs from the ledger",
        code: "NOT_IN_LEDGER_PAYROLL_CURRENT_BALANCE",
        // Current balances (100 Cr) against the ledger's employees (-75 Dr): 25 more owed than posted.
        value: -25,
        category: "Not yet in the ledger",
        count: 0,
      },
    ]);
    expect(h.executes.some((t) => t.includes("FROM salary_advances"))).toBe(true);
  });

  it("uses the worker ledger as of a date, reporting a negative balance as payable", async () => {
    h.parties.employee = [party(42, "-35"), party(43, "0")];
    h.employees = [
      { id: 42, type: "Worker", currentBalance: null },
      { id: 43, type: "Employee", currentBalance: null },
    ];
    h.outstanding = null;
    const out = await load({ employees: "erp", asOf: "2026-06-30" });
    expect(h.executes.some((t) => t.includes("FROM salary_advances"))).toBe(false);
    expect(out.onUs).toEqual([
      {
        name: "Workers Payable",
        code: "WORKER_LEDGER",
        value: 35,
        category: "Payroll",
        partyKind: "employee",
        partyId: null,
      },
    ]);
    expect(out.notInLedger.lines).toEqual([]);

    // A null outstanding advance total counts as zero.
    h.parties.employee = [];
    expect((await load({ employees: "erp" })).forUs).toEqual([]);
  });

  it("lists Factory employee receivables and books the rest as Payroll Payable", async () => {
    h.parties.employee = [party(50, "80"), party(51, "-200"), party(52, "0")];
    h.employees = [
      { id: 50, type: "Employee", currentBalance: "0" },
      { id: 51, type: "Employee", currentBalance: "0" },
    ];
    const out = await load({ employees: "factory", codes: "factory" });
    expect(out.forUs).toEqual([
      {
        name: "Party 50",
        code: "EMPLOYEE_RECEIVABLE",
        value: 80,
        category: "Employee Receivable",
        partyKind: "employee",
        partyId: 50,
      },
    ]);
    expect(out.onUs).toEqual([
      {
        name: "Payroll Payable",
        code: "EMPLOYEE_PAYROLL_PAYABLE",
        value: 200,
        category: "Liability",
        partyKind: "employee",
        partyId: null,
      },
    ]);
    expect(out.payrollSigned).toBe(200);
    // Without the payroll memo option the current-balance difference is not reported.
    expect(out.notInLedger.lines).toEqual([]);

    // Factory codes always show the payable line, even at zero.
    h.parties.employee = [party(50, "80")];
    expect((await load({ employees: "factory", codes: "factory" })).onUs).toEqual([
      expect.objectContaining({ name: "Payroll Payable", value: 0 }),
    ]);
    // ERP codes only show it when something is owed.
    expect((await load({ employees: "factory" })).onUs).toEqual([]);
    h.parties.employee = [party(51, "-200")];
    expect((await load({ employees: "factory" })).onUs).toEqual([
      expect.objectContaining({ name: "Payroll Payable", code: "PAYROLL_PAYABLE", category: "Payroll", value: 200 }),
    ]);
  });

  it("sorts each side by value and totals it", async () => {
    h.parties.bank = [party(1, "10"), party(2, "300"), party(3, "-5"), party(4, "-50")];
    const out = await load({ banks: true });
    expect(out.forUs.map((l) => l.value)).toEqual([300, 10]);
    expect(out.onUs.map((l) => l.value)).toEqual([50, 5]);
    expect([out.forUsTotal, out.onUsTotal]).toEqual([310, 55]);
  });
});
