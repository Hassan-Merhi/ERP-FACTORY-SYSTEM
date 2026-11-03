/**
 * The adapter-driven voucher lifecycle: input checks, idempotent replay, the
 * posted-only rule, mirrored reversal lines and the order of adapter calls for
 * a reversal and a replacement.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  replaceVoucherTx,
  reverseVoucherTx,
  VoucherLifecycleError,
  type LifecycleVoucherSnapshot,
  type VoucherLifecycleAdapter,
} from "../server/services/accounting/voucherLifecycleService";

const tx = { id: "tx" };
const source = { sourceType: "voucher-edit", sourceId: "77" } as never;

const snapshot = (id: number, over: Partial<LifecycleVoucherSnapshot["voucher"]> = {}): LifecycleVoucherSnapshot => ({
  voucher: {
    id,
    companyId: 3,
    voucherNumber: `JV-${id}`,
    voucherType: "Journal",
    voucherDate: "2026-10-01",
    totalAmount: "100.00",
    ...over,
  },
  entries: [
    { ledgerAccountId: 1, debitAmount: "100.50", creditAmount: null, narration: "Rent" },
    { customerId: 9, debitAmount: "0", creditAmount: "100.50" },
  ],
});

let calls: string[];
let adapter: VoucherLifecycleAdapter & Record<string, ReturnType<typeof vi.fn>>;

beforeEach(() => {
  calls = [];
  const track =
    <T>(name: string, value: T) =>
    async (input: unknown) => {
      calls.push(name);
      void input;
      return value;
    };
  adapter = {
    findOperation: vi.fn(track("findOperation", null)),
    lockVoucher: vi.fn(track("lockVoucher", snapshot(10))),
    createReversal: vi.fn(track("createReversal", snapshot(11))),
    reverseLinkedEffects: vi.fn(track("reverseLinkedEffects", undefined)),
    markReversed: vi.fn(track("markReversed", undefined)),
    recordOperation: vi.fn(track("recordOperation", undefined)),
    createReplacement: vi.fn(track("createReplacement", snapshot(12))),
  } as never;
});

const request = (over: Record<string, unknown> = {}) => ({
  tx,
  companyId: 3,
  voucherId: 10,
  reversalDate: "2026-10-20",
  reason: "Wrong account",
  idempotencyKey: "rev-1",
  actor: { userId: "u1" },
  source,
  ...over,
});

async function lifecycleError(work: Promise<unknown>) {
  const error = await work.then(
    () => null,
    (e: unknown) => e
  );
  expect(error).toBeInstanceOf(VoucherLifecycleError);
  expect((error as Error).name).toBe("VoucherLifecycleError");
  return error as VoucherLifecycleError;
}

describe("reverseVoucherTx", () => {
  it("posts mirrored lines, reverses linked effects and records the operation", async () => {
    const result = await reverseVoucherTx(adapter, request());
    expect(result).toEqual({
      originalVoucherId: 10,
      reversalVoucherId: 11,
      replacementVoucherId: null,
      state: "REVERSED",
      idempotent: false,
    });
    expect(calls).toEqual([
      "findOperation",
      "lockVoucher",
      "createReversal",
      "reverseLinkedEffects",
      "markReversed",
      "recordOperation",
    ]);
    expect(adapter.findOperation).toHaveBeenCalledWith({ tx, companyId: 3, idempotencyKey: "rev-1" });
    expect(adapter.lockVoucher).toHaveBeenCalledWith({ tx, companyId: 3, voucherId: 10 });
    expect(adapter.createReversal).toHaveBeenCalledWith({
      tx,
      original: snapshot(10),
      reversalDate: "2026-10-20",
      reason: "Wrong account",
      actor: { userId: "u1" },
      source,
      entries: [
        { ledgerAccountId: 1, debitAmount: "0", creditAmount: "100.5", narration: "Reversal: Rent" },
        { customerId: 9, debitAmount: "100.5", creditAmount: "0", narration: "Reversal of JV-10" },
      ],
    });
    expect(adapter.reverseLinkedEffects).toHaveBeenCalledWith({
      tx,
      original: snapshot(10),
      reversal: snapshot(11),
      actor: { userId: "u1" },
      reason: "Wrong account",
    });
    expect(adapter.markReversed).toHaveBeenCalledWith({ tx, originalVoucherId: 10, reversalVoucherId: 11 });
    expect(adapter.recordOperation).toHaveBeenCalledWith({
      tx,
      companyId: 3,
      idempotencyKey: "rev-1",
      operation: "REVERSE",
      result,
      actor: { userId: "u1" },
      reason: "Wrong account",
    });
  });

  it("replays a recorded operation without touching the voucher", async () => {
    adapter.findOperation.mockResolvedValue({
      originalVoucherId: 10,
      reversalVoucherId: 11,
      state: "REVERSED",
      idempotent: false,
    });
    await expect(reverseVoucherTx(adapter, request({ actor: undefined }))).resolves.toEqual({
      originalVoucherId: 10,
      reversalVoucherId: 11,
      state: "REVERSED",
      idempotent: true,
    });
    expect(adapter.lockVoucher).not.toHaveBeenCalled();
    expect(adapter.createReversal).not.toHaveBeenCalled();
  });

  it("uses an empty actor when none is given", async () => {
    await reverseVoucherTx(adapter, request({ actor: undefined }));
    expect(adapter.createReversal.mock.calls[0][0].actor).toEqual({});
    expect(adapter.recordOperation.mock.calls[0][0].actor).toEqual({});
  });

  it("requires a reason, date, key and a valid target", async () => {
    for (const [over, message] of [
      [{ reason: "  " }, "reason is required"],
      [{ reason: null }, "reason is required"],
      [{ reversalDate: "" }, "reversalDate is required"],
      [{ idempotencyKey: undefined }, "idempotencyKey is required"],
    ] as const) {
      const error = await lifecycleError(reverseVoucherTx(adapter, request(over)));
      expect(error).toMatchObject({ code: "VOUCHER_LIFECYCLE_INPUT_REQUIRED", message });
    }
    for (const over of [{ companyId: 0 }, { companyId: 1.5 }, { voucherId: 2.5 }]) {
      expect((await lifecycleError(reverseVoucherTx(adapter, request(over)))).code).toBe(
        "VOUCHER_LIFECYCLE_TARGET_INVALID"
      );
    }
    expect(adapter.findOperation).not.toHaveBeenCalled();
  });

  it("refuses a missing, already reversed or replaced voucher", async () => {
    adapter.lockVoucher.mockResolvedValueOnce(null);
    expect((await lifecycleError(reverseVoucherTx(adapter, request()))).code).toBe("VOUCHER_NOT_FOUND");
    for (const over of [
      { lifecycleState: "REVERSED" as const },
      { lifecycleState: "REPLACED" as const },
      { reversalVoucherId: 4 },
    ]) {
      adapter.lockVoucher.mockResolvedValueOnce(snapshot(10, over));
      expect((await lifecycleError(reverseVoucherTx(adapter, request()))).code).toBe("VOUCHER_ALREADY_REVERSED");
    }
    adapter.lockVoucher.mockResolvedValueOnce(snapshot(10, { lifecycleState: "POSTED", reversalVoucherId: null }));
    await expect(reverseVoucherTx(adapter, request())).resolves.toMatchObject({ state: "REVERSED" });
    expect(adapter.createReversal).toHaveBeenCalledTimes(1);
  });

  it("refuses negative or non-numeric line amounts before posting anything", async () => {
    for (const entry of [
      { debitAmount: "-1", creditAmount: "0" },
      { debitAmount: "0", creditAmount: "-0.01" },
      { debitAmount: "Infinity", creditAmount: "0" },
      { debitAmount: "0", creditAmount: "NaN" },
    ]) {
      const original = snapshot(10);
      original.entries = [original.entries[0], entry];
      adapter.lockVoucher.mockResolvedValueOnce(original);
      const error = await lifecycleError(reverseVoucherTx(adapter, request()));
      expect(error).toMatchObject({
        code: "VOUCHER_REVERSAL_AMOUNT_INVALID",
        message: "Entry 2 has an invalid amount",
      });
    }
    expect(adapter.createReversal).not.toHaveBeenCalled();
  });
});

describe("replaceVoucherTx", () => {
  it("reverses the original, posts the replacement and links all three", async () => {
    const payload = { lines: [] };
    const req = request({ replacementPayload: payload, idempotencyKey: "rep-1" });
    const result = await replaceVoucherTx(adapter, req as never);
    expect(result).toEqual({
      originalVoucherId: 10,
      reversalVoucherId: 11,
      replacementVoucherId: 12,
      state: "REPLACED",
      idempotent: false,
    });
    expect(calls).toEqual([
      "findOperation",
      "lockVoucher",
      "createReversal",
      "reverseLinkedEffects",
      "createReplacement",
      "markReversed",
      "recordOperation",
    ]);
    expect(adapter.createReplacement).toHaveBeenCalledWith({
      tx,
      original: snapshot(10),
      reversal: snapshot(11),
      request: req,
    });
    expect(adapter.markReversed).toHaveBeenCalledWith({
      tx,
      originalVoucherId: 10,
      reversalVoucherId: 11,
      replacementVoucherId: 12,
    });
    expect(adapter.recordOperation).toHaveBeenCalledWith(
      expect.objectContaining({ operation: "REPLACE", idempotencyKey: "rep-1", result })
    );
    expect(adapter.createReversal.mock.calls[0][0].entries[0]).toMatchObject({ creditAmount: "100.5" });
  });

  it("replays a recorded replacement and needs a replacement adapter", async () => {
    adapter.findOperation.mockResolvedValue({
      originalVoucherId: 10,
      reversalVoucherId: 11,
      replacementVoucherId: 12,
      state: "REPLACED",
      idempotent: false,
    });
    await expect(
      replaceVoucherTx(adapter, request({ replacementPayload: {}, actor: undefined }) as never)
    ).resolves.toMatchObject({
      idempotent: true,
      replacementVoucherId: 12,
    });
    expect(adapter.createReplacement).not.toHaveBeenCalled();

    adapter.findOperation.mockResolvedValue(null);
    await replaceVoucherTx(adapter, request({ replacementPayload: {}, actor: undefined }) as never);
    expect(adapter.recordOperation.mock.calls[0][0].actor).toEqual({});

    delete (adapter as Partial<VoucherLifecycleAdapter>).createReplacement;
    const error = await lifecycleError(replaceVoucherTx(adapter, request({ replacementPayload: {} }) as never));
    expect(error).toMatchObject({
      code: "VOUCHER_REPLACEMENT_UNSUPPORTED",
      message: "Replacement adapter is not configured",
    });
  });
});
