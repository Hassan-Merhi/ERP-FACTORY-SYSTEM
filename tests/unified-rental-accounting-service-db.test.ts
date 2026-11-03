/**
 * Unified rental accounting view (ERP / Factory / Properties). Each case
 * seeds a disposable company inside a drizzle transaction that is rolled
 * back, then reads the contract list and one contract's operating rent,
 * deposit evidence and expense links.
 */
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { db, type DbTransaction } from "../server/db";
import { resultRows } from "../server/lib/queryResult";
import { companyBusinessDate } from "../server/services/accounting/companyBusinessDate";
import { RentalAccountingError } from "../server/services/rental/rentalExpenseAttributionService";
import {
  listRentalAccountingContractsTx,
  rentalContractAccountingTx,
} from "../server/services/rental/unifiedRentalAccountingService";

const ROLLBACK = new Error("rollback");
let seq = 0;

async function inRolledBackTx(run: (tx: DbTransaction) => Promise<void>): Promise<void> {
  await db
    .transaction(async (tx) => {
      await run(tx);
      throw ROLLBACK;
    })
    .catch((error) => {
      if (error !== ROLLBACK) throw error;
    });
}

async function insert(tx: DbTransaction, query: ReturnType<typeof sql>): Promise<number> {
  return Number(resultRows<{ id: number } & Record<string, unknown>>(await tx.execute(query))[0].id);
}

type Contract = {
  module?: string;
  unitType?: string;
  locationGroup?: string;
  unitNumber?: string;
  tenant?: string;
  start: string;
  end?: string | null;
  status?: string;
  rent?: number;
  guarantee?: number;
  currency?: string;
  linkedCompanyId?: number | null;
};

async function world(tx: DbTransaction) {
  const code = `RA${process.pid}${++seq}`;
  const companyId = await insert(tx, sql`INSERT INTO companies(code,name) VALUES(${code},${code}) RETURNING id`);
  const ledger = (accountCode: string) =>
    insert(
      tx,
      sql`INSERT INTO ledger_accounts(company_id,code,name,account_type) VALUES(${companyId},${accountCode},${accountCode},'Liability') RETURNING id`
    );
  return {
    companyId,
    ledger,
    async contract(c: Contract) {
      const module = c.module ?? "PROPERTIES";
      const unitId = await insert(
        tx,
        sql`INSERT INTO property_units(company_id,module,unit_type,location_group,unit_number)
            VALUES(${companyId},${module},${c.unitType ?? "WAREHOUSE"},${c.locationGroup ?? "North"},${c.unitNumber ?? `U${++seq}`}) RETURNING id`
      );
      const id = await insert(
        tx,
        sql`INSERT INTO property_contracts(company_id,module,unit_id,tenant_name,guarantee_amount,rental_amount,start_date,end_date,
              status,guarantee_posted_to_statement,guarantee_posted_amount,linked_company_id,currency)
            VALUES(${companyId},${module},${unitId},${c.tenant ?? "Tenant"},${c.guarantee ?? 0},${c.rent ?? 1000},${c.start}::date,
              ${c.end ?? null}::date,${c.status ?? "ACTIVE"},true,${c.guarantee ?? 0},${c.linkedCompanyId ?? null},${c.currency ?? "USD"})
            RETURNING id`
      );
      return { id, unitId, module };
    },
    async voucher(
      number: string,
      date: string,
      entries: Array<{ ledger: number; debit?: number; credit?: number }> = [],
      extra: { deleted?: boolean | string; optional?: boolean; reversalOf?: number } = {}
    ) {
      const voucherId = await insert(
        tx,
        sql`INSERT INTO vouchers(company_id,voucher_number,voucher_type,voucher_date,total_amount,currency,optional,deleted_at,reversal_of_voucher_id)
            VALUES(${companyId},${number},'Journal',${date}::date,0,'USD',${extra.optional ?? false},
              ${typeof extra.deleted === "string" ? sql`${extra.deleted}::timestamptz` : extra.deleted ? sql`NOW()` : null},
              ${extra.reversalOf ?? null}) RETURNING id`
      );
      for (const e of entries) {
        await tx.execute(sql`INSERT INTO voucher_entries(voucher_id,company_id,ledger_account_id,debit_amount,credit_amount,base_debit_amount,base_credit_amount)
            VALUES(${voucherId},${companyId},${e.ledger},${e.debit ?? 0},${e.credit ?? 0},${e.debit ?? 0},${e.credit ?? 0})`);
      }
      return voucherId;
    },
  };
}

type Ctx = { companyId: number };
type Lease = { id: number; unitId: number; module: string };

async function month(
  tx: DbTransaction,
  w: Ctx,
  c: Lease,
  ym: [number, number],
  m: { expected: number; paid: number; accrual?: number | null; prepaid?: boolean; advance?: boolean }
) {
  return insert(
    tx,
    sql`INSERT INTO property_monthly_ledger(company_id,module,contract_id,unit_id,year,month,expected_amount,paid_amount,
          accrual_voucher_id,used_prepaid_account,used_advance_account)
        VALUES(${w.companyId},${c.module},${c.id},${c.unitId},${ym[0]},${ym[1]},${m.expected},${m.paid},${m.accrual ?? null},
          ${m.prepaid ?? false},${m.advance ?? false}) RETURNING id`
  );
}

async function payment(
  tx: DbTransaction,
  w: Ctx,
  c: Lease,
  p: {
    ym: [number, number];
    amount: number;
    date: string;
    ledgerRowId: number | null;
    status?: string;
    currency?: string;
    voucherId?: number | null;
    group?: string;
  }
) {
  return insert(
    tx,
    sql`INSERT INTO property_payments(company_id,module,contract_id,unit_id,ledger_row_id,voucher_id,amount,payment_date,
          for_year,for_month,currency,exchange_rate,posting_status,payment_group_id)
        VALUES(${w.companyId},${c.module},${c.id},${c.unitId},${p.ledgerRowId},${p.voucherId ?? null},${p.amount},${p.date}::date,
          ${p.ym[0]},${p.ym[1]},${p.currency ?? "USD"},1,${p.status ?? "POSTED"},${p.group ?? null}) RETURNING id`
  );
}

async function expenseLink(
  tx: DbTransaction,
  w: Ctx,
  c: Lease,
  voucherId: number,
  amount: number,
  extra: { voided?: boolean; taggedAt?: string } = {}
) {
  return insert(
    tx,
    sql`INSERT INTO accounting_rental_expense_links(company_id,module,contract_id,unit_id,voucher_id,category,allocated_usd,note,
          tagged_by,tagged_at,voided_at,voided_by,void_reason)
        VALUES(${w.companyId},${c.module},${c.id},${c.unitId},${voucherId},'maintenance',${amount},'roof',
          '1',${extra.taggedAt ?? "2026-03-01T00:00:00Z"}::timestamptz,${extra.voided ? sql`'2026-03-02T00:00:00Z'::timestamptz` : null},
          ${extra.voided ? "1" : null},${extra.voided ? "mistake" : null}) RETURNING id`
  );
}

async function expectRentalError(promise: Promise<unknown>, code: string, status: number) {
  const error = await promise.then(
    () => null,
    (e: unknown) => e
  );
  expect(error).toBeInstanceOf(RentalAccountingError);
  expect(error).toMatchObject({ code, status });
}

describe("listRentalAccountingContractsTx", () => {
  it("lists one module's contracts, active first, with their rent perspective", async () => {
    await inRolledBackTx(async (tx) => {
      const w = await world(tx);
      const other = await world(tx);
      const ended = await w.contract({ start: "2025-01-01", status: "ENDED", locationGroup: "A", unitNumber: "1" });
      const shop = await w.contract({
        start: "2026-01-01",
        unitType: "SHOP",
        locationGroup: "B",
        unitNumber: "2",
        currency: "eur",
        rent: 1234.567,
      });
      const warehouse = await w.contract({ start: "2026-01-01", locationGroup: "A", unitNumber: "9", tenant: "Acme" });
      const shared = await w.contract({
        start: "2026-01-01",
        locationGroup: "A",
        unitNumber: "10",
        linkedCompanyId: other.companyId,
      });
      await w.contract({ start: "2026-01-01", module: "FACTORY" });
      await other.contract({ start: "2026-01-01" });

      const result = await listRentalAccountingContractsTx(tx, { companyId: w.companyId, module: "PROPERTIES" });
      expect(result).toMatchObject({
        companyId: w.companyId,
        module: "PROPERTIES",
        perspective: "MIXED_BY_CONTRACT",
        limitedTo: 500,
      });
      expect(result.contracts.map((c) => [c.id, c.perspective])).toEqual([
        [shared.id, "TENANT"],
        [warehouse.id, "LANDLORD"],
        [shop.id, "TENANT"],
        [ended.id, "LANDLORD"],
      ]);
      expect(result.contracts[1]).toEqual({
        perspective: "LANDLORD",
        id: warehouse.id,
        unitId: warehouse.unitId,
        unitNumber: "9",
        unitType: "WAREHOUSE",
        locationGroup: "A",
        tenantName: "Acme",
        status: "ACTIVE",
        currency: "USD",
        monthlyRent: "1000.00",
        startDate: "2026-01-01",
        endDate: null,
        internal: false,
        linkedCompanyId: null,
      });
      expect(result.contracts[2]).toMatchObject({ currency: "EUR", monthlyRent: "1234.57" });
      expect(result.contracts[0].linkedCompanyId).toBe(other.companyId);
    });
  });

  it("rejects an unknown module", async () => {
    await inRolledBackTx(async (tx) => {
      await expectRentalError(
        listRentalAccountingContractsTx(tx, { companyId: 1, module: "HOTEL" as never }),
        "RENTAL_MODULE_INVALID",
        400
      );
      await expectRentalError(
        rentalContractAccountingTx(tx, { companyId: 1, module: "HOTEL" as never, contractId: 1 }),
        "RENTAL_MODULE_INVALID",
        400
      );
    });
  });
});

describe("rentalContractAccountingTx", () => {
  it("reconciles due months against posted payments, deposits and expense links", async () => {
    await inRolledBackTx(async (tx) => {
      const w = await world(tx);
      const lease = await w.contract({ start: "2026-01-15", rent: 1000, guarantee: 2000, tenant: "Depot Co" });
      const tenantDep = await w.ledger("TENANT-DEP");
      const tenantDepSub = await w.ledger("tenant-dep-north");
      const cash = await w.ledger("CASH");

      const liveAccrual = await w.voucher("ACC-1", "2026-01-15");
      const deadAccrual = await w.voucher("ACC-3", "2026-03-15", [], { deleted: true });
      const jan = await month(tx, w, lease, [2026, 1], { expected: 1000, paid: 1000, accrual: liveAccrual });
      const feb = await month(tx, w, lease, [2026, 2], { expected: 0, paid: 500, advance: true });
      const mar = await month(tx, w, lease, [2026, 3], {
        expected: 1200,
        paid: 1500,
        accrual: deadAccrual,
        prepaid: true,
      });
      const may = await month(tx, w, lease, [2026, 5], { expected: 1000, paid: 1000 });

      const receipt = await w.voucher("RCPT-1", "2026-01-20");
      const marReceipt = await w.voucher("RCPT-3", "2026-03-20");
      const p1 = await payment(tx, w, lease, {
        ym: [2026, 1],
        amount: 1000,
        date: "2026-01-20",
        ledgerRowId: jan,
        voucherId: receipt,
        group: "g1",
      });
      const p2 = await payment(tx, w, lease, { ym: [2026, 2], amount: 400, date: "2026-02-20", ledgerRowId: feb });
      const p3 = await payment(tx, w, lease, {
        ym: [2026, 3],
        amount: 1500,
        date: "2026-03-20",
        ledgerRowId: mar,
        voucherId: marReceipt,
      });
      // Paid in advance through a voucher that was later made optional.
      const draftReceipt = await w.voucher("RCPT-5", "2026-04-10", [], { optional: true });
      await payment(tx, w, lease, {
        ym: [2026, 5],
        amount: 1000,
        date: "2026-04-10",
        ledgerRowId: may,
        voucherId: draftReceipt,
      });
      await payment(tx, w, lease, {
        ym: [2026, 4],
        amount: 1000,
        date: "2026-05-01",
        ledgerRowId: jan,
        status: "SCHEDULED",
      });
      await payment(tx, w, lease, { ym: [2026, 4], amount: 300, date: "2026-05-10", ledgerRowId: jan });
      await payment(tx, w, lease, { ym: [2026, 1], amount: 50, date: "2026-01-21", ledgerRowId: jan, currency: "EUR" });
      const guaranteeRow = await payment(tx, w, lease, {
        ym: [2026, 1],
        amount: 2000,
        date: "2026-01-15",
        ledgerRowId: null,
      });
      await payment(tx, w, lease, {
        ym: [2026, 2],
        amount: 99,
        date: "2026-02-21",
        ledgerRowId: feb,
        status: "CANCELLED",
      });

      const guar = await w.voucher(`GUAR-1-${lease.id}`, "2026-01-15", [
        { ledger: tenantDep, credit: 2000 },
        { ledger: cash, debit: 2000 },
      ]);
      await w.voucher(`GUAR-REFUND-2-${lease.id}`, "2026-04-01", [{ ledger: tenantDepSub, debit: 500 }]);
      await w.voucher(`GUAR-3-${lease.id}9`, "2026-04-01", [{ ledger: tenantDep, credit: 999 }]);
      await w.voucher(`GUAR-4-${lease.id}`, "2026-04-01", [{ ledger: tenantDep, credit: 999 }], { deleted: true });
      await w.voucher(`GUAR-5-${lease.id}`, "2026-04-01", [{ ledger: tenantDep, credit: 999 }], { optional: true });
      await w.voucher(`GUAR-6-${lease.id}`, "2026-05-01", [{ ledger: tenantDep, credit: 999 }]);
      await w.voucher(`DEP-${lease.id}`, "2026-04-01", [{ ledger: tenantDep, credit: 999 }]);

      const roof = await w.voucher("EXP-1", "2026-03-01");
      const retired = await w.voucher("EXP-2", "2026-03-01", [], { deleted: "2026-03-05T00:00:00Z" });
      // Deleted after the as-of date: still a live expense on that date.
      const laterDeleted = await w.voucher("EXP-4", "2026-03-01", [], { deleted: true });
      const voided = await w.voucher("EXP-3", "2026-03-01");
      const roofLink = await expenseLink(tx, w, lease, roof, 250);
      await expenseLink(tx, w, lease, retired, 100);
      await expenseLink(tx, w, lease, voided, 75, { voided: true });
      await expenseLink(tx, w, lease, laterDeleted, 30);
      await expenseLink(tx, w, lease, roof, 45, { taggedAt: "2026-05-01T00:00:00Z" });

      const report = await rentalContractAccountingTx(tx, {
        companyId: w.companyId,
        module: "PROPERTIES",
        contractId: lease.id,
        asOfDate: "2026-04-20",
      });

      expect(report).toMatchObject({
        companyId: w.companyId,
        module: "PROPERTIES",
        perspective: "LANDLORD",
        asOfDate: "2026-04-20",
        contract: {
          id: lease.id,
          unitId: lease.unitId,
          unitType: "WAREHOUSE",
          tenantName: "Depot Co",
          status: "ACTIVE",
          startDate: "2026-01-15",
          endDate: null,
          currency: "USD",
          monthlyRent: "1000.00",
          internal: false,
          linkedCompanyId: null,
        },
        totals: {
          expectedDue: "4200.00",
          postedAgainstDue: "2900.00",
          outstanding: "1600.00",
          // May paid in advance plus March's 300 overpayment.
          advanceFuturePeriods: "1300.00",
          scheduledNotPosted: "1000.00",
          maintenanceExpensesBaseUsd: "280.00",
          depositPledgeNative: "2000.00",
          depositBalanceEvidenceUsd: "1500.00",
        },
        limitations: { outstandingType: "OPERATING_RENT_AR" },
      });

      expect(report.periods).toEqual([
        {
          ledgerRowId: jan,
          year: 2026,
          month: 1,
          dueDate: "2026-01-15",
          expected: "1000.00",
          paid: "1000.00",
          outstanding: "0.00",
          overpayment: "0.00",
          scheduled: "0.00",
          postedPaymentIds: [p1],
          accrualVoucherId: liveAccrual,
          accrualStale: false,
          usedPrepaidAccount: false,
          usedAdvanceAccount: false,
          cachedPaid: "1000.00",
          cacheDifference: "0.00",
          status: "settled",
        },
        expect.objectContaining({
          ledgerRowId: feb,
          month: 2,
          // An unbilled (zero) month falls back to the current contract rent.
          expected: "1000.00",
          paid: "400.00",
          outstanding: "600.00",
          postedPaymentIds: [p2],
          accrualVoucherId: null,
          accrualStale: false,
          usedAdvanceAccount: true,
          cacheDifference: "100.00",
          status: "partial",
        }),
        expect.objectContaining({
          ledgerRowId: mar,
          month: 3,
          expected: "1200.00",
          paid: "1500.00",
          outstanding: "0.00",
          overpayment: "300.00",
          postedPaymentIds: [p3],
          accrualVoucherId: null,
          accrualStale: true,
          usedPrepaidAccount: true,
          status: "settled",
        }),
        expect.objectContaining({
          ledgerRowId: null,
          month: 4,
          dueDate: "2026-04-15",
          expected: "1000.00",
          paid: "0.00",
          scheduled: "1000.00",
          postedPaymentIds: [],
          cachedPaid: null,
          cacheDifference: null,
          status: "overdue",
        }),
      ]);

      expect(report.payments).toHaveLength(8);
      expect(report.payments[0]).toMatchObject({
        id: guaranteeRow,
        isGuaranteeActivity: true,
        ledgerRowId: null,
        voucherId: null,
      });
      expect(report.payments.find((p) => p.id === p1)).toEqual({
        id: p1,
        date: "2026-01-20",
        period: "2026-01",
        status: "POSTED",
        amount: "1000.00",
        currency: "USD",
        historicalRate: "1.000000",
        voucherId: receipt,
        voucherNumber: "RCPT-1",
        groupId: "g1",
        isGuaranteeActivity: false,
        ledgerRowId: jan,
      });
      expect(report.payments.some((p) => p.date === "2026-05-10")).toBe(false);
      expect(report.payments.some((p) => p.status === "SCHEDULED")).toBe(true);

      expect(report.guarantee).toEqual({
        contractPledgeNative: "2000.00",
        statementFlag: true,
        statedPostedNative: "2000.00",
        ledgerEvidenceUsd: "1500.00",
        vouchers: [
          {
            voucherId: guar,
            voucherNumber: `GUAR-1-${lease.id}`,
            date: "2026-01-15",
            currency: "USD",
            accountCode: "TENANT-DEP",
            signedUsd: "2000.00",
          },
          expect.objectContaining({
            voucherNumber: `GUAR-REFUND-2-${lease.id}`,
            accountCode: "tenant-dep-north",
            signedUsd: "-500.00",
          }),
        ],
      });

      expect(report.expenses).toEqual(
        expect.arrayContaining([
          {
            id: roofLink,
            voucherId: roof,
            voucherNumber: "EXP-1",
            category: "maintenance",
            amountUsd: "250.00",
            note: "roof",
            sourceStatus: "active",
          },
          expect.objectContaining({ voucherId: retired, sourceStatus: "retired", amountUsd: "100.00" }),
          expect.objectContaining({ voucherId: laterDeleted, sourceStatus: "active", amountUsd: "30.00" }),
        ])
      );
      expect(report.expenses).toHaveLength(3);

      expect(report.warnings).toEqual([
        "2 posted payment allocation(s) reference missing or retired vouchers; review their underlying posting.",
        "1 payment row(s) have a different currency from the contract and are excluded from native-currency rent totals.",
        "Some expense attribution vouchers were retired, reversed or made optional; their amounts are not included in the current maintenance total.",
        "At least one period has an accrual link to a missing or retired voucher.",
        "Stored paid_amount cache differs from effective posted payments; this page uses posted payment rows and does not repair the cache.",
        "The contract's current rent, unit ownership and status are not historical snapshots. Posted payments are date-filtered; past contract terms may differ.",
      ]);
    });
  });

  it("stops billing at the contract end and before the start", async () => {
    await inRolledBackTx(async (tx) => {
      const w = await world(tx);
      const ended = await w.contract({ start: "2026-01-31", end: "2026-04-10", status: "ENDED" });
      const report = await rentalContractAccountingTx(tx, {
        companyId: w.companyId,
        module: "PROPERTIES",
        contractId: ended.id,
        asOfDate: "2026-09-01",
      });
      // Billing on the 31st clamps to month end; April's due date is after the end.
      expect(report.periods.map((p) => p.dueDate)).toEqual(["2026-01-31", "2026-02-28", "2026-03-31"]);
      expect(report.totals.outstanding).toBe("3000.00");

      const future = await w.contract({ start: "2027-01-01" });
      const empty = await rentalContractAccountingTx(tx, {
        companyId: w.companyId,
        module: "PROPERTIES",
        contractId: future.id,
        asOfDate: "2026-09-01",
      });
      expect(empty.periods).toEqual([]);
      expect(empty.totals).toMatchObject({ expectedDue: "0.00", outstanding: "0.00", advanceFuturePeriods: "0.00" });
    });
  });

  it("uses today's business date by default and normalises currency codes", async () => {
    await inRolledBackTx(async (tx) => {
      const w = await world(tx);
      const today = await companyBusinessDate(w.companyId, tx);
      const lease = await w.contract({ start: today, currency: " eur ", rent: 80 });
      const row = await month(tx, w, lease, [Number(today.slice(0, 4)), Number(today.slice(5, 7))], {
        expected: 80,
        paid: 80,
      });
      await payment(tx, w, lease, {
        ym: [Number(today.slice(0, 4)), Number(today.slice(5, 7))],
        amount: 80,
        date: today,
        ledgerRowId: row,
        currency: "eur",
      });
      const report = await rentalContractAccountingTx(tx, {
        companyId: w.companyId,
        module: "PROPERTIES",
        contractId: lease.id,
      });
      expect(report.asOfDate).toBe(today);
      expect(report.contract.currency).toBe("EUR");
      expect(report.periods).toHaveLength(1);
      expect(report.periods[0]).toMatchObject({ paid: "80.00", status: "settled" });
      // The payment has no voucher, so only that warning applies.
      expect(report.warnings).toEqual([
        "1 posted payment allocation(s) reference missing or retired vouchers; review their underlying posting.",
      ]);
    });
  });

  it("flags tenant-side and shared leases and mismatched deposit accounts", async () => {
    await inRolledBackTx(async (tx) => {
      const w = await world(tx);
      const other = await world(tx);
      const tenantDep = await w.ledger("TENANT-DEP");
      const paidDep = await w.ledger("SEC-DEP-PAID");
      const paidDepSub = await w.ledger("SEC-DEP-PAID-HQ");

      const shop = await w.contract({ start: "2026-01-01", unitType: "SHOP", linkedCompanyId: other.companyId });
      await w.voucher(`GUAR-CASH-1-${shop.id}`, "2026-01-01", [
        { ledger: paidDep, debit: 700 },
        { ledger: tenantDep, credit: 50 },
      ]);
      await w.voucher(`GUAR-RENT-2-${shop.id}`, "2026-02-01", [{ ledger: paidDepSub, credit: 200 }]);
      const shopReport = await rentalContractAccountingTx(tx, {
        companyId: w.companyId,
        module: "PROPERTIES",
        contractId: shop.id,
        asOfDate: "2026-02-10",
      });
      expect(shopReport.perspective).toBe("TENANT");
      expect(shopReport.limitations.outstandingType).toBe("OPERATING_RENT_AP");
      // Deposit asset 700 − 200, plus a liability credit of 50.
      expect(shopReport.totals.depositBalanceEvidenceUsd).toBe("550.00");
      expect(shopReport.guarantee.vouchers.map((v) => v.signedUsd)).toEqual(["700.00", "50.00", "-200.00"]);
      expect(shopReport.warnings).toEqual(
        expect.arrayContaining([
          "Shared/intercompany rental: this report covers only the owning company's postings. Linked-company cash/accrual entries must be reconciled separately.",
          "This tenant-side lease has deposit postings to a landlord liability account; review the original guarantee accounting before relying on the balance.",
        ])
      );

      const warehouse = await w.contract({ start: "2026-01-01" });
      await w.voucher(`GUAR-1-${warehouse.id}`, "2026-01-01", [{ ledger: paidDepSub, debit: 10 }]);
      const landlordReport = await rentalContractAccountingTx(tx, {
        companyId: w.companyId,
        module: "PROPERTIES",
        contractId: warehouse.id,
        asOfDate: "2026-02-10",
      });
      expect(landlordReport.warnings).toContain(
        "This landlord-side lease has deposit postings to a tenant deposit-asset account; review the original guarantee accounting before relying on the balance."
      );
      expect(landlordReport.warnings.some((m) => m.startsWith("Shared/intercompany"))).toBe(false);
      expect(landlordReport.warnings.some((m) => m.startsWith("This tenant-side"))).toBe(false);
    });
  });

  it("reports reversed and optional expense vouchers as inactive", async () => {
    await inRolledBackTx(async (tx) => {
      const w = await world(tx);
      const lease = await w.contract({ start: "2026-01-01" });
      const reversedVoucher = await w.voucher("EXP-R", "2026-02-01");
      await w.voucher("EXP-R-REV", "2026-02-02", [], { reversalOf: reversedVoucher });
      const optionalVoucher = await w.voucher("EXP-O", "2026-02-01", [], { optional: true });
      await expenseLink(tx, w, lease, reversedVoucher, 40);
      await expenseLink(tx, w, lease, optionalVoucher, 60);
      const report = await rentalContractAccountingTx(tx, {
        companyId: w.companyId,
        module: "PROPERTIES",
        contractId: lease.id,
        asOfDate: "2026-03-10",
      });
      expect(report.expenses.map((e) => e.sourceStatus).sort()).toEqual(["optional", "reversed"]);
      expect(report.totals.maintenanceExpensesBaseUsd).toBe("0.00");
    });
  });

  it("refuses invalid ids and contracts from another company or module", async () => {
    await inRolledBackTx(async (tx) => {
      const w = await world(tx);
      const other = await world(tx);
      const foreign = await other.contract({ start: "2026-01-01" });
      const factory = await w.contract({ start: "2026-01-01", module: "FACTORY" });
      for (const contractId of [0, -1, 1.5]) {
        await expectRentalError(
          rentalContractAccountingTx(tx, { companyId: w.companyId, module: "PROPERTIES", contractId }),
          "RENTAL_CONTRACT_ID_INVALID",
          400
        );
      }
      for (const contractId of [foreign.id, factory.id]) {
        await expectRentalError(
          rentalContractAccountingTx(tx, { companyId: w.companyId, module: "PROPERTIES", contractId }),
          "RENTAL_CONTRACT_NOT_FOUND",
          404
        );
      }
      await expect(
        rentalContractAccountingTx(tx, {
          companyId: w.companyId,
          module: "FACTORY",
          contractId: factory.id,
          asOfDate: "2026-01-01",
        })
      ).resolves.toMatchObject({ module: "FACTORY", periods: [expect.objectContaining({ dueDate: "2026-01-01" })] });
    });
  });
});
