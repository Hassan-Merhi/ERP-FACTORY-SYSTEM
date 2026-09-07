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

function voucherRow(overrides: Record<string, unknown> = {}) {
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

function openingRow(overrides: Record<string, unknown> = {}) {
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

function queryResult(rows: unknown[]) {
  return Promise.resolve({ rows });
}

describe("historical currency repair behavior", () => {
  it("loads voucher entries with company and optional-voucher isolation", async () => {
    const client = { query: vi.fn().mockReturnValue(queryResult([voucherRow()])) } as any;
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
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining("v.company_id = $2"), [20, 7]);
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining("v.optional = false"), [20, 7]);
  });

  it("loads each supported opening-balance entity and returns null for missing rows", async () => {
    for (const kind of ["ledger", "bank", "customer", "supplier", "employee", "fixedAsset"] as const) {
      const client = { query: vi.fn().mockReturnValue(queryResult([openingRow({ label: kind })])) } as any;
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
      expect(client.query).toHaveBeenCalledWith(expect.stringContaining("target.id = $1"), [41, 7]);
    }

    const missing = await loadHistoricalRepairCase(7, "ledger", 999, {
      query: vi.fn().mockReturnValue(queryResult([])),
    } as any);
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
    const currentRow = voucherRow();
    const previewClient = { query: vi.fn().mockReturnValue(queryResult([currentRow])) };
    const loaded = await loadHistoricalRepairCase(7, "voucherEntry", 20, previewClient as any);
    expect(loaded).not.toBeNull();

    const client = { query: vi.fn() as any, release: vi.fn() };
    client.query.mockImplementation((text: string) => {
      if (text.includes("voucher_entries ve")) return queryResult([currentRow]);
      return queryResult([]);
    });
    mockConnect.mockResolvedValue(client);
    const current = await loadHistoricalRepairCase(7, "voucherEntry", 20, client);
    expect(current?.versionTag).toBe(loaded?.versionTag);

    const plan = {
      companyId: 7,
      createdAt: "2026-02-01T00:00:00.000Z",
      itemCount: 1,
      fingerprint: "fingerprint",
      items: [
        {
          input: {
            kind: "voucherEntry" as const,
            id: 20,
            currency: "EUR",
            historicalRate: "1.2",
            note: "approved",
          },
          before: loaded!,
          after: {
            transactionCurrency: "EUR",
            transactionDebitAmount: "100",
            transactionCreditAmount: "0",
            baseDebitAmount: "120",
            baseCreditAmount: "0",
            historicalExchangeRate: "1.2",
            rateConvention: "BASE_PER_TRANSACTION",
            debitAmount: "120",
            creditAmount: "0",
          },
        },
      ],
    };
    const result = await applyHistoricalCurrencyRepairPlan(plan, { userId: "u1", username: "admin" });
    expect(result).toEqual({ appliedCount: 1, fingerprint: "fingerprint" });
    expect(client.query).toHaveBeenCalledWith("BEGIN");
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining("UPDATE voucher_entries"), expect.any(Array));
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO audit_log"), expect.any(Array));
    expect(client.query).toHaveBeenCalledWith("COMMIT");
    expect(client.release).toHaveBeenCalled();
  });

  it("rolls back when the current snapshot has changed after preview", async () => {
    const client = { query: vi.fn(), release: vi.fn() };
    client.query.mockImplementation((text: string) => {
      if (text.includes("voucher_entries ve")) return queryResult([voucherRow({ historical_exchange_rate: "9.9" })]);
      return queryResult([]);
    });
    mockConnect.mockResolvedValue(client);

    const plan: any = {
      companyId: 7,
      itemCount: 1,
      fingerprint: "stale",
      items: [
        {
          input: { kind: "voucherEntry", id: 20, currency: "EUR", historicalRate: "1.2" },
          before: {
            kind: "voucherEntry",
            id: 20,
            label: "Import invoice",
            currency: "EUR",
            rawAmount: "100",
            currentRate: "1.1",
            currentBaseAmount: "110",
            voucherId: 30,
            voucherDate: "2026-01-10",
            debitAmount: "100",
            creditAmount: "0",
            transactionDebitAmount: "100",
            transactionCreditAmount: "0",
            versionTag: "old",
          },
          after: {},
        },
      ],
    };

    await expect(applyHistoricalCurrencyRepairPlan(plan, { userId: "u1", username: "admin" })).rejects.toThrow(
      "changed after preview"
    );
    expect(client.query).toHaveBeenCalledWith("ROLLBACK");
    expect(client.release).toHaveBeenCalled();
  });
});
