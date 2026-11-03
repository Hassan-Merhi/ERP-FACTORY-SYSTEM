/**
 * Read-only Rental open items: input checks, the contract scope, due months
 * up to the earlier of the contract end and the as-of date, expected amounts
 * from the monthly ledger or the contract, POSTED payment matching,
 * prepayments and the single-currency rule. The transaction is a fake that
 * answers the service's queries in order.
 */
import { describe, expect, it } from "vitest";
import { loadRentalOpenItemsTx } from "../server/services/rental/rentalOpenItemsService";
import { OpenItemError } from "../server/services/accounting/partyOpenItemService";

function fakeTx(contract: Record<string, unknown> | null, months: unknown[] = [], payments: unknown[] = []) {
  const results = [[], contract ? [contract] : [], months, payments];
  const calls: unknown[] = [];
  return {
    calls,
    tx: {
      execute: async (query: unknown) => {
        calls.push(query);
        return { rows: results[calls.length - 1] ?? [] };
      },
    } as never,
  };
}

const contract = (over: Record<string, unknown> = {}) => ({
  id: 7,
  company_id: 3,
  linked_company_id: null,
  module: "ERP",
  currency: " usd ",
  rental_amount: "1000.00",
  start_date: "2026-01-15",
  end_date: null,
  ...over,
});
const input = (over: Record<string, unknown> = {}) => ({
  companyId: 3,
  contractId: 7,
  module: "ERP" as const,
  asOfDate: "2026-04-20",
  ...over,
});

async function openItemError(work: Promise<unknown>) {
  const error = await work.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(OpenItemError);
  return error as OpenItemError & { code: string; status: number };
}

describe("loadRentalOpenItemsTx", () => {
  it("rejects invalid ids, modules and dates before querying", async () => {
    for (const over of [
      { companyId: 0 },
      { companyId: 1.5 },
      { contractId: -1 },
      { contractId: Number.NaN },
      { module: "SHOP" },
    ]) {
      const { tx, calls } = fakeTx(contract());
      expect(await openItemError(loadRentalOpenItemsTx(tx, input(over) as never))).toMatchObject({
        code: "RENTAL_OPEN_ITEMS_INVALID",
        status: 400,
      });
      expect(calls).toHaveLength(0);
    }
    for (const asOfDate of ["2026-4-20", "2026-02-30", "not a date"]) {
      const { tx } = fakeTx(contract());
      expect(await openItemError(loadRentalOpenItemsTx(tx, input({ asOfDate })))).toMatchObject({
        code: "RENTAL_OPEN_ITEMS_DATE_INVALID",
        status: 400,
      });
    }
  });

  it("refuses a contract outside the company", async () => {
    const { tx } = fakeTx(null);
    expect(await openItemError(loadRentalOpenItemsTx(tx, input()))).toMatchObject({
      code: "RENTAL_CONTRACT_NOT_FOUND",
      status: 404,
    });
  });

  it("lists each due month as settled, partial or open and totals them", async () => {
    const { tx, calls } = fakeTx(
      contract(),
      [
        { id: 11, year: 2026, month: 2, expected_amount: "1200.00" },
        { id: 12, year: 2026, month: 3, expected_amount: "0" },
      ],
      [
        { id: 21, for_year: 2026, for_month: 1, amount: "1000.00", payment_date: "2026-01-15", currency: "USD" },
        { id: 22, for_year: 2026, for_month: 2, amount: "500.00", payment_date: "2026-02-20", currency: null },
        { id: 23, for_year: 2026, for_month: 2, amount: "100.00", payment_date: "2026-02-21", currency: "usd" },
        { id: 24, for_year: 2026, for_month: 6, amount: "250.00", payment_date: "2026-04-01", currency: "USD" },
      ]
    );
    const result = await loadRentalOpenItemsTx(tx, input());
    expect(calls).toHaveLength(4);
    expect(result).toEqual({
      companyId: 3,
      module: "ERP",
      contractId: 7,
      currency: "USD",
      asOfDate: "2026-04-20",
      items: [
        {
          contractId: 7,
          ledgerRowId: null,
          year: 2026,
          month: 1,
          dueDate: "2026-01-15",
          expectedAmount: "1000.00",
          paidAmount: "1000.00",
          outstandingAmount: "0.00",
          paymentIds: [21],
          status: "settled",
        },
        {
          contractId: 7,
          ledgerRowId: 11,
          year: 2026,
          month: 2,
          dueDate: "2026-02-15",
          expectedAmount: "1200.00",
          paidAmount: "600.00",
          outstandingAmount: "600.00",
          paymentIds: [22, 23],
          status: "partial",
        },
        {
          contractId: 7,
          ledgerRowId: 12,
          year: 2026,
          month: 3,
          dueDate: "2026-03-15",
          expectedAmount: "1000.00",
          paidAmount: "0.00",
          outstandingAmount: "1000.00",
          paymentIds: [],
          status: "open",
        },
        {
          contractId: 7,
          ledgerRowId: null,
          year: 2026,
          month: 4,
          dueDate: "2026-04-15",
          expectedAmount: "1000.00",
          paidAmount: "0.00",
          outstandingAmount: "1000.00",
          paymentIds: [],
          status: "open",
        },
      ],
      totals: {
        expected: "4200.00",
        paidAgainstDue: "1600.00",
        outstanding: "2600.00",
        advanceForOtherMonths: "250.00",
      },
    });
  });

  it("stops at the contract end and never shows an overpayment as negative", async () => {
    const { tx } = fakeTx(
      contract({ end_date: "2026-02-28", currency: null }),
      [],
      [{ id: 31, for_year: 2026, for_month: 2, amount: "1500.00", payment_date: "2026-02-15", currency: "USD" }]
    );
    const result = await loadRentalOpenItemsTx(tx, input());
    expect(result.currency).toBe("USD");
    expect(result.items.map((i) => [i.month, i.outstandingAmount, i.status])).toEqual([
      [1, "1000.00", "open"],
      [2, "0.00", "settled"],
    ]);
    expect(result.totals).toMatchObject({ outstanding: "1000.00", paidAgainstDue: "1500.00" });
  });

  it("uses the as-of date when the contract ends later, and a blank currency means USD", async () => {
    const { tx } = fakeTx(contract({ end_date: "2027-01-01", currency: "  ", start_date: "2026-04-25" }));
    const result = await loadRentalOpenItemsTx(tx, input());
    expect(result).toMatchObject({ currency: "USD", items: [], totals: { expected: "0.00", outstanding: "0.00" } });
  });

  it("refuses a payment in another currency", async () => {
    const { tx } = fakeTx(
      contract({ currency: "ZMW" }),
      [],
      [{ id: 41, for_year: 2026, for_month: 1, amount: "10", payment_date: "2026-01-20", currency: "USD" }]
    );
    expect(await openItemError(loadRentalOpenItemsTx(tx, input()))).toMatchObject({
      code: "RENTAL_OPEN_ITEMS_CURRENCY_INCONSISTENT",
      message: "This contract contains payments in a different currency; manual currency reconciliation is required",
    });
  });
});
