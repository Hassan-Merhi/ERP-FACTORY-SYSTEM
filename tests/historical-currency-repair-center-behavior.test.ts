import type { Pool, PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";

const mockPoolQuery = vi.hoisted(() => vi.fn());
const mockConnect = vi.hoisted(() => vi.fn());

vi.mock("../server/db", () => ({
  pool: {
    query: mockPoolQuery,
    connect: mockConnect,
  },
}));

const {
  applyHistoricalCurrencyRepairPlan,
  listHistoricalRepairCases,
  loadHistoricalRepairCase,
  planHistoricalCurrencyRepairs,
} = await import("../server/services/accounting/historicalCurrencyRepairCenter");

type RepairRow = Record<string, unknown>;
type QueryImpl = (text: string, params?: unknown[]) => Promise<{ rows: RepairRow[] }>;

function voucherRow(overrides: RepairRow = {}): RepairRow {
  return {
    id: 20,
    voucher_id: 30,
    voucher_date: "2026-01-10",
    voucher_currency: "EUR",
    transaction_currency: "EUR",
    transaction_debit_amount: "100",
    transaction_credit_amount: "0",
    base_debit_amount: "110",
    base_credit_amount: "0",
    historical_exchange_rate: "1.1",
    debit_amount: "100",
    credit_amount: "0",
    label: "Import invoice",
    ...overrides,
  };
}

function openingRow(overrides: RepairRow = {}): RepairRow {
  return {
    id: 41,
    label: "Opening row",
    raw_amount: "250",
    native_amount: "250",
    currency: "EUR",
    historical_rate: "1.1",
    base_amount: "275",
    side: "Dr",
    ...overrides,
  };
}

function queryResult(rows: RepairRow[]) {
  return Promise.resolve({ rows });
}

/**
 * A pg client double. The service only ever calls `query` and `release`, so the
 * mock exposes those with real types for assertions and is widened once at the
 * boundary rather than sprinkling `as any` at every call site.
 */
function fakeClient(impl: QueryImpl) {
  const query = vi.fn(impl);
  const release = vi.fn();
  return { query, release, client: { query, release } as unknown as PoolClient & Pool };
}

function rowsOnce(rows: RepairRow[]) {
  return fakeClient(() => queryResult(rows));
}

describe("historical currency repair behavior", () => {
  it("loads voucher entries with company and optional-voucher isolation", async () => {
    const { query, client } = rowsOnce([voucherRow()]);
    const result = await loadHistoricalRepairCase(7, "voucherEntry", 20, client);

    expect(result).toMatchObject({
      kind: "voucherEntry",
      id: 20,
      voucherId: 30,
      currency: "EUR",
      rawAmount: "100",
      currentBaseAmount: "110",
      transactionDebitAmount: "100",
      creditAmount: "0",
    });
    expect(result?.versionTag).toMatch(/^[a-f0-9]{64}$/);
    expect(query).toHaveBeenCalledWith(expect.stringContaining("v.company_id = $2"), [20, 7]);
    expect(query).toHaveBeenCalledWith(expect.stringContaining("v.optional = false"), [20, 7]);
  });

  it("loads each supported opening-balance entity and returns null for missing rows", async () => {
    for (const kind of ["ledger", "bank", "customer", "supplier", "employee", "fixedAsset"] as const) {
      const { query, client } = rowsOnce([openingRow({ label: kind })]);
      const result = await loadHistoricalRepairCase(7, kind, 41, client);
      expect(result).toMatchObject({
        kind,
        id: 41,
        label: kind,
        currency: "EUR",
        rawAmount: "250",
        currentRate: "1.1",
        currentBaseAmount: "275",
      });
      expect(query).toHaveBeenCalledWith(expect.stringContaining("target.id = $1"), [41, 7]);
    }

    const missing = await loadHistoricalRepairCase(7, "ledger", 999, rowsOnce([]).client);
    expect(missing).toBeNull();
  });

  it("lists unresolved voucher and opening-balance cases through their company-scoped queries", async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [{ id: 20 }] })
      .mockResolvedValueOnce({ rows: [{ kind: "ledger", id: 41 }] })
      .mockResolvedValueOnce({ rows: [voucherRow()] })
      .mockResolvedValueOnce({ rows: [openingRow()] });

    const result = await listHistoricalRepairCases(7);
    expect(result.map((item) => `${item.kind}:${item.id}`)).toEqual(["voucherEntry:20", "ledger:41"]);
    expect(mockPoolQuery.mock.calls[0][1]).toEqual([7]);
    expect(mockPoolQuery.mock.calls[1][1]).toEqual([7, 7]);
  });

  it("plans normalized voucher repairs, rejects empty batches, duplicate rows, and missing cases", async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [{ base_currency: "USD" }] })
      .mockResolvedValueOnce({ rows: [voucherRow()] });
    const plan = await planHistoricalCurrencyRepairs(7, [
      {
        kind: "voucherEntry",
        id: 20,
        currency: "EUR",
        historicalRate: "1.25",
        transactionDebitAmount: "100",
        transactionCreditAmount: "0",
        note: "approved correction",
      },
    ]);

    expect(plan.companyId).toBe(7);
    expect(plan.itemCount).toBe(1);
    expect(plan.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(plan.items[0].after).toMatchObject({
      transactionCurrency: "EUR",
      historicalExchangeRate: "1.2500000000",
      transactionDebitAmount: "100.000000",
    });

    await expect(planHistoricalCurrencyRepairs(7, [])).rejects.toThrow("At least one approved repair");

    mockPoolQuery
      .mockResolvedValueOnce({ rows: [{ base_currency: "USD" }] })
      .mockResolvedValueOnce({ rows: [voucherRow()] });
    await expect(
      planHistoricalCurrencyRepairs(7, [
        { kind: "voucherEntry", id: 20, currency: "EUR", historicalRate: 1.2 },
        { kind: "voucherEntry", id: 20, currency: "EUR", historicalRate: 1.2 },
      ])
    ).rejects.toThrow("Duplicate repair row");

    mockPoolQuery.mockResolvedValueOnce({ rows: [{ base_currency: "USD" }] }).mockResolvedValueOnce({ rows: [] });
    await expect(
      planHistoricalCurrencyRepairs(7, [{ kind: "ledger", id: 999, currency: "EUR", historicalRate: 1.2 }])
    ).rejects.toThrow("was not found");
  });

  it("plans opening balances with entity-specific side defaults", async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [{ base_currency: "USD" }] })
      .mockResolvedValueOnce({ rows: [openingRow({ side: null })] });

    const plan = await planHistoricalCurrencyRepairs(7, [
      {
        kind: "supplier",
        id: 41,
        currency: "CFA",
        historicalRate: "1.2",
        nativeAmount: "250",
      },
    ]);

    expect(plan.items[0].after).toMatchObject({
      nativeAmount: "250.000000",
      currency: "CFA",
      historicalRate: "1.2000000000",
      side: "Cr",
    });
  });

  it("applies a plan atomically and writes an audit row for each repaired item", async () => {
    // Build a genuine plan from the live row, then apply it against a database
    // whose row has not moved. The version tags must match for the apply to run.
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [{ base_currency: "USD" }] })
      .mockResolvedValueOnce({ rows: [voucherRow()] });
    const plan = await planHistoricalCurrencyRepairs(7, [
      { kind: "voucherEntry", id: 20, currency: "EUR", historicalRate: "1.2", note: "approved" },
    ]);

    const { query, release, client } = fakeClient((text) =>
      text.includes("voucher_entries ve") ? queryResult([voucherRow()]) : queryResult([])
    );
    mockConnect.mockResolvedValue(client);

    const result = await applyHistoricalCurrencyRepairPlan(plan, { userId: "u1", username: "admin" });

    expect(result).toEqual({ appliedCount: 1, fingerprint: plan.fingerprint });
    expect(query).toHaveBeenCalledWith("BEGIN");
    expect(query).toHaveBeenCalledWith(expect.stringContaining("UPDATE voucher_entries"), expect.any(Array));
    expect(query).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO audit_log"), expect.any(Array));
    expect(query).toHaveBeenCalledWith("COMMIT");
    expect(query).not.toHaveBeenCalledWith("ROLLBACK");
    expect(release).toHaveBeenCalled();

    // The UPDATE must carry the planned normalization, not the pre-repair values.
    const update = query.mock.calls.find(([text]) => String(text).includes("UPDATE voucher_entries"));
    expect(update?.[1]).toEqual([
      plan.items[0].after.transactionCurrency,
      plan.items[0].after.transactionDebitAmount,
      plan.items[0].after.transactionCreditAmount,
      plan.items[0].after.baseDebitAmount,
      plan.items[0].after.baseCreditAmount,
      plan.items[0].after.historicalExchangeRate,
      plan.items[0].after.rateConvention,
      plan.items[0].after.debitAmount,
      plan.items[0].after.creditAmount,
      20,
    ]);
  });

  it("rejects and rolls back a plan whose historical rate moved between preview and apply", async () => {
    // A genuine preview against the real row (historical rate 1.1) — the plan's
    // versionTag is the one the service computed, not a hand-written token.
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [{ base_currency: "USD" }] })
      .mockResolvedValueOnce({ rows: [voucherRow({ historical_exchange_rate: "1.1" })] });
    const plan = await planHistoricalCurrencyRepairs(7, [
      { kind: "voucherEntry", id: 20, currency: "EUR", historicalRate: "1.2", note: "approved" },
    ]);
    expect(plan.items[0].before.currentRate).toBe("1.1");

    // Someone else changed only the historical exchange rate before the apply ran.
    const { query, release, client } = fakeClient((text) =>
      text.includes("voucher_entries ve")
        ? queryResult([voucherRow({ historical_exchange_rate: "9.9" })])
        : queryResult([])
    );
    mockConnect.mockResolvedValue(client);

    await expect(applyHistoricalCurrencyRepairPlan(plan, { userId: "u1", username: "admin" })).rejects.toThrow(
      "changed after preview"
    );

    expect(query).toHaveBeenCalledWith("ROLLBACK");
    expect(query).not.toHaveBeenCalledWith("COMMIT");
    expect(query).not.toHaveBeenCalledWith(expect.stringContaining("UPDATE voucher_entries"), expect.any(Array));
    expect(query).not.toHaveBeenCalledWith(expect.stringContaining("INSERT INTO audit_log"), expect.any(Array));
    expect(release).toHaveBeenCalled();
  });
});
