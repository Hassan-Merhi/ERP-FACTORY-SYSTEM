import { describe, expect, it, vi } from "vitest";
import { insertVoucherWithEntries, insertVoucherWithEntriesTx } from "./voucherPostingService";

const SOURCE = {
  sourceType: "voucher-posting-service-test",
  sourceId: "fixture",
  idempotencyKey: "voucher-posting-service-test:fixture",
};

function makeTransaction() {
  const calls: unknown[] = [];
  const returning = vi
    .fn()
    .mockResolvedValueOnce([{ id: 91, voucherNumber: "JV-1" }])
    .mockResolvedValueOnce([{ id: 1 }, { id: 2 }]);
  const values = vi.fn((value: unknown) => {
    calls.push(value);
    return { returning };
  });
  const insert = vi.fn(() => ({ values }));
  return { tx: { insert }, calls, insert };
}

describe("voucherPostingService", () => {
  it("preserves voucher source metadata and batches entry insertion", async () => {
    const { tx, calls, insert } = makeTransaction();

    const result = await insertVoucherWithEntriesTx(
      tx,
      {
        companyId: 4,
        voucherNumber: "JV-1",
        voucherType: "Journal",
        voucherDate: "2026-07-19",
        totalAmount: "25.00",
        sourceModule: "ERP",
      },
      [
        { ledgerAccountId: 10, debitAmount: "25.00", creditAmount: "0" },
        { ledgerAccountId: 11, debitAmount: "0", creditAmount: "25.00" },
      ],
      SOURCE
    );

    expect(result.voucher).toMatchObject({ id: 91 });
    expect(insert).toHaveBeenCalledTimes(2);
    expect(calls[0]).toMatchObject({ sourceModule: "ERP" });
    expect(calls[1]).toEqual([
      expect.objectContaining({ voucherId: 91, ledgerAccountId: 10 }),
      expect.objectContaining({ voucherId: 91, ledgerAccountId: 11 }),
    ]);
  });

  it("persists dual-currency linkage fields and returns without an entry insert for an empty voucher", async () => {
    const { tx, calls, insert } = makeTransaction();

    const result = await insertVoucherWithEntriesTx(
      tx,
      {
        companyId: 4,
        voucherNumber: "JV-2",
        voucherType: "Journal",
        voucherDate: "2026-07-20",
        totalAmount: "0",
        currency: "EUR",
        exchangeRate: "0.92",
        effectiveDate: "2026-07-19",
      },
      [],
      SOURCE
    );

    expect(result.entries).toEqual([]);
    expect(insert).toHaveBeenCalledTimes(1);
    expect(calls[0]).toMatchObject({
      currency: "EUR",
      exchangeRate: "0.92",
      effectiveDate: "2026-07-19",
      description: null,
      optional: false,
    });
  });

  it("owns the transaction boundary in the database wrapper", async () => {
    const { tx } = makeTransaction();
    const transaction = vi.fn(async (callback) => callback(tx));

    const result = await insertVoucherWithEntries(
      { transaction },
      {
        companyId: 4,
        voucherNumber: "JV-3",
        voucherType: "Journal",
        voucherDate: "2026-07-21",
        totalAmount: "0",
      },
      [],
      SOURCE
    );

    expect(transaction).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ voucher: { id: 91 }, entries: [] });
  });

  it("rejects a caller that does not supply a complete source identity", async () => {
    const { tx, insert } = makeTransaction();

    await expect(
      insertVoucherWithEntriesTx(
        tx,
        {
          companyId: 4,
          voucherNumber: "JV-NO-SOURCE",
          voucherType: "Journal",
          voucherDate: "2026-07-21",
          totalAmount: "0",
        },
        [],
        { sourceType: "test", sourceId: "", idempotencyKey: "missing-source-id" }
      )
    ).rejects.toThrow(/sourceId is required/);
    expect(insert).not.toHaveBeenCalled();
  });

  it.each([undefined, { id: 0 }])("rejects an invalid persisted voucher result", async (voucher) => {
    const tx = {
      insert: vi.fn(() => ({
        values: vi.fn(() => ({ returning: vi.fn(async () => [voucher]) })),
      })),
    };

    await expect(
      insertVoucherWithEntriesTx(
        tx,
        {
          companyId: 4,
          voucherNumber: "JV-BAD",
          voucherType: "Journal",
          voucherDate: "2026-07-21",
          totalAmount: "0",
        },
        [],
        SOURCE
      )
    ).rejects.toThrow(/voucher/i);
  });

  it.each([undefined, "", "   "])("refuses to insert a voucher with no number (%s)", async (voucherNumber) => {
    const { tx, calls } = makeTransaction();

    await expect(
      insertVoucherWithEntriesTx(
        tx,
        {
          companyId: 4,
          voucherNumber: voucherNumber as unknown as string,
          voucherType: "Journal",
          voucherDate: "2026-07-21",
          totalAmount: "0",
        },
        [],
        SOURCE
      )
    ).rejects.toThrow(/voucherNumber is required/);
    expect(calls).toHaveLength(0);
  });

  it("marks the voucher as engine-posted, trims the number and carries the reversal link", async () => {
    const { tx, calls } = makeTransaction();

    await insertVoucherWithEntriesTx(
      tx,
      {
        companyId: 4,
        voucherNumber: "  JV-4-2026-000001 ",
        voucherType: "Journal",
        voucherDate: "2026-07-22",
        totalAmount: "0",
        reversalOfVoucherId: 77,
      },
      [],
      SOURCE
    );
    await insertVoucherWithEntriesTx(
      makeTransaction().tx,
      { companyId: 4, voucherNumber: "JV-2", voucherType: "Journal", voucherDate: "2026-07-22", totalAmount: "0" },
      [],
      SOURCE
    );

    expect(calls[0]).toMatchObject({
      voucherNumber: "JV-4-2026-000001",
      postedByEngine: true,
      reversalOfVoucherId: 77,
    });
  });

  it("defaults omitted entry amounts and targets, and refuses an absent identity field", async () => {
    const { tx, calls } = makeTransaction();

    await insertVoucherWithEntriesTx(
      tx,
      { companyId: 4, voucherNumber: "JV-5", voucherType: "Journal", voucherDate: "2026-07-23", totalAmount: "0" },
      [{ bankAccountId: 3 }],
      SOURCE
    );
    expect(calls[1]).toEqual([
      expect.objectContaining({ ledgerAccountId: null, bankAccountId: 3, debitAmount: "0", creditAmount: "0" }),
    ]);

    await expect(
      insertVoucherWithEntriesTx(
        makeTransaction().tx,
        { companyId: 4, voucherNumber: "JV-6", voucherType: "Journal", voucherDate: "2026-07-23", totalAmount: "0" },
        [],
        { sourceType: "test", sourceId: "x" } as unknown as typeof SOURCE
      )
    ).rejects.toThrow(/idempotencyKey is required/);
  });
});
