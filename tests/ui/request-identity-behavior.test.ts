/**
 * Stable request identities for protected accounting and Phase 5 voucher
 * writes. A retried write must reuse the identity of the first attempt (even
 * after a reload) until the client sees a definite outcome, so the server can
 * replay it instead of posting it twice. These cases pin the reload path,
 * damaged or unavailable storage, the uncertain-outcome hold, and which
 * routes are protected.
 */
import type * as AccountingModule from "@/lib/accountingRequestIdentity";
import type * as Phase5Module from "@/lib/phase5VoucherRequestIdentity";

const ACCOUNTING_KEY = "erp_pending_accounting_request_ids_v2";
const PHASE5_KEY = "erp_pending_phase5_voucher_request_ids_v1";

async function load() {
  vi.resetModules();
  const accounting: typeof AccountingModule = await import("@/lib/accountingRequestIdentity");
  const phase5: typeof Phase5Module = await import("@/lib/phase5VoucherRequestIdentity");
  return { accounting, phase5 };
}

const idOf = (value: unknown) => (value as { clientRequestId?: string }).clientRequestId;

const realRandomUuid = Object.getOwnPropertyDescriptor(globalThis.crypto, "randomUUID");
function withoutRandomUuid() {
  Object.defineProperty(globalThis.crypto, "randomUUID", { configurable: true, value: undefined });
}

beforeEach(() => localStorage.clear());
afterEach(() => {
  vi.restoreAllMocks();
  if (realRandomUuid) Object.defineProperty(globalThis.crypto, "randomUUID", realRandomUuid);
});

describe("accounting request identity", () => {
  const journal = { amount: 10, lines: [1, 2] };

  it("reuses a pending identity after a reload and forgets it once released", async () => {
    const first = await load();
    const id = idOf(first.accounting.attachAccountingRequestIdentity("POST", "/api/vouchers/journal", journal));
    expect(id).toBeTruthy();

    const reloaded = await load();
    expect(
      idOf(reloaded.accounting.attachAccountingRequestIdentity("POST", "/api/vouchers/journal?x=1", journal))
    ).toBe(id);

    reloaded.accounting.releaseAccountingRequestIdentity("POST", "/api/vouchers/journal", journal);
    expect(
      idOf(reloaded.accounting.attachAccountingRequestIdentity("POST", "/api/vouchers/journal", journal))
    ).not.toBe(id);
  });

  it("holds an uncertain outcome until a definite one is seen, across reloads", async () => {
    const { accounting } = await load();
    const id = idOf(accounting.attachAccountingRequestIdentity("POST", "/api/vouchers", journal));
    accounting.markAccountingRequestOutcomeUncertain("POST", "/api/vouchers", journal);

    const reloaded = (await load()).accounting;
    reloaded.releaseAccountingRequestIdentity("POST", "/api/vouchers", journal);
    expect(idOf(reloaded.attachAccountingRequestIdentity("POST", "/api/vouchers", journal))).toBe(id);

    reloaded.releaseAccountingRequestIdentity("POST", "/api/vouchers", journal, true);
    expect(idOf(reloaded.attachAccountingRequestIdentity("POST", "/api/vouchers", journal))).not.toBe(id);
  });

  it("ignores marks and releases for unknown or unprotected requests", async () => {
    const { accounting } = await load();
    accounting.markAccountingRequestOutcomeUncertain("POST", "/api/vouchers", { never: "sent" });
    accounting.markAccountingRequestOutcomeUncertain("GET", "/api/vouchers", journal);
    accounting.releaseAccountingRequestIdentity("GET", "/api/vouchers", journal);

    expect(localStorage.getItem(ACCOUNTING_KEY)).toBeNull();
  });

  it.each([
    ["not JSON", "{"],
    ["not a list", JSON.stringify({ a: 1 })],
    [
      "damaged entries",
      JSON.stringify([
        "x",
        ["only-key"],
        [1, { requestId: "a", createdAt: 1 }],
        ["k", null],
        ["k", { requestId: 5, createdAt: 1 }],
      ]),
    ],
  ])("starts clean from storage that is %s", async (_label, raw) => {
    localStorage.setItem(ACCOUNTING_KEY, raw);
    const { accounting } = await load();

    expect(idOf(accounting.attachAccountingRequestIdentity("POST", "/api/vouchers", journal))).toBeTruthy();
  });

  it("still works in memory when storage refuses writes, and without randomUUID", async () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    withoutRandomUuid();
    const { accounting } = await load();

    const id = idOf(accounting.attachAccountingRequestIdentity("POST", "/api/vouchers", journal));
    expect(id).toMatch(/^accounting-\d+-/);
    expect(idOf(accounting.attachAccountingRequestIdentity("POST", "/api/vouchers", journal))).toBe(id);
  });

  it("keeps a caller-supplied identity", async () => {
    const { accounting } = await load();
    const data = { ...journal, clientRequestId: "mine" };

    expect(accounting.attachAccountingRequestIdentity("POST", "/api/vouchers", data)).toBe(data);
  });

  it.each([
    ["POST", "/api/vouchers/journal-entries", { a: 1 }, true],
    ["POST", "/api/vouchers/journal", { optional: true }, false],
    ["POST", "/api/vouchers/payment-receipt", { voucherType: "Receipt" }, true],
    ["POST", "/api/vouchers/payment-receipt", { voucherType: "Contra" }, false],
    ["POST", "/api/vouchers/with-entries", { voucher: { a: 1 } }, true],
    ["POST", "/api/vouchers/with-entries", { voucher: { optional: true } }, false],
    ["POST", "/api/vouchers/with-entries", { entries: [] }, false],
    ["POST", "/api/inter-company-transfers", {}, true],
    ["POST", "/api/stock-transfers", { voucherId: 3 }, false],
    ["POST", "/api/stock-transfers", {}, true],
    ["POST", "/api/payroll/pay-worker", {}, true],
    ["POST", "/api/factory/employees/9/withdraw", {}, true],
    ["POST", "/api/factory/worker-bonuses/9/pay", {}, true],
    ["POST", "/api/offloads/9/toggle-optional", {}, true],
    ["POST", "/api/factory/containers/9/reverse-offload", {}, true],
    ["POST", "/api/factory/workers/9/bulk-repay-advances", {}, true],
    ["POST", "/api/factory/advances/9/repayments", {}, true],
    ["POST", "/api/factory/advances/9/notes", {}, false],
    ["PATCH", "/api/payroll/runs/9", { action: "pay" }, true],
    ["PATCH", "/api/payroll/runs/9", { action: "rename" }, false],
    ["PATCH", "/api/factory/payrolls/9/fix-accounting", {}, true],
    ["PATCH", "/api/factory/payrolls/9", {}, false],
    ["DELETE", "/api/payroll/pay-worker", {}, false],
    ["POST", "/api/payroll/pay-worker", [1], false],
  ])("%s %s %j protected: %s", async (method, url, data, expected) => {
    const { accounting } = await load();
    expect(accounting.isProtectedAccountingRequest(method, url, data)).toBe(expected);
  });

  it("reads the 409 outcome code and decides when an identity may be released", async () => {
    const { accounting } = await load();
    const json = (status: number, body: string) => new Response(body, { status });

    expect(await accounting.accountingResponseCode(json(200, "{}"))).toBeUndefined();
    expect(await accounting.accountingResponseCode(json(409, '{"code":"DUPLICATE"}'))).toBe("DUPLICATE");
    expect(await accounting.accountingResponseCode(json(409, "not json"))).toBeUndefined();
    expect(await accounting.accountingResponseCode(json(409, '{"code":7}'))).toBeUndefined();

    expect(accounting.shouldReleaseAccountingRequestIdentity(201)).toBe(true);
    expect(accounting.shouldReleaseAccountingRequestIdentity(422)).toBe(true);
    expect(accounting.shouldReleaseAccountingRequestIdentity(409, "DUPLICATE")).toBe(true);
    expect(accounting.shouldReleaseAccountingRequestIdentity(409)).toBe(false);
    expect(accounting.shouldReleaseAccountingRequestIdentity(409, "ACCOUNTING_REQUEST_OUTCOME_UNCERTAIN")).toBe(false);
    expect(accounting.shouldReleaseAccountingRequestIdentity(503)).toBe(false);
  });
});

describe("Phase 5 voucher request identity", () => {
  const path = "/api/credit-notes";
  const note = { b: [{ z: 1, a: 2 }], a: "x" };
  const reordered = { a: "x", b: [{ a: 2, z: 1 }], clientRequestId: "" };

  it("gives the same identity to the same payload in any key order, across reloads", async () => {
    const { phase5 } = await load();
    const id = idOf(phase5.attachPhase5VoucherRequestIdentity("post", path, note));

    const reloaded = (await load()).phase5;
    expect(idOf(reloaded.attachPhase5VoucherRequestIdentity("POST", `${path}?draft=1`, reordered))).toBe(id);
    expect(idOf(reloaded.attachPhase5VoucherRequestIdentity("POST", path, { ...note, a: "y" }))).not.toBe(id);
  });

  it("holds an uncertain outcome until a definite one is seen", async () => {
    const { phase5 } = await load();
    const id = idOf(phase5.attachPhase5VoucherRequestIdentity("POST", path, note));
    phase5.markPhase5VoucherRequestOutcomeUncertain("POST", path, note);

    const reloaded = (await load()).phase5;
    reloaded.releasePhase5VoucherRequestIdentity("POST", path, note);
    expect(idOf(reloaded.attachPhase5VoucherRequestIdentity("POST", path, note))).toBe(id);
    reloaded.releasePhase5VoucherRequestIdentity("POST", path, note, true);
    expect(idOf(reloaded.attachPhase5VoucherRequestIdentity("POST", path, note))).not.toBe(id);
  });

  it("leaves other requests and caller identities alone", async () => {
    const { phase5 } = await load();
    const read = { a: 1 };
    const own = { a: 1, clientRequestId: "mine" };

    expect(phase5.attachPhase5VoucherRequestIdentity("GET", path, read)).toBe(read);
    expect(phase5.attachPhase5VoucherRequestIdentity("POST", path, own)).toBe(own);
    phase5.markPhase5VoucherRequestOutcomeUncertain("GET", path, read);
    phase5.markPhase5VoucherRequestOutcomeUncertain("POST", path, { unseen: true });
    phase5.releasePhase5VoucherRequestIdentity("GET", path, read);
    expect(localStorage.getItem(PHASE5_KEY)).toBeNull();
  });

  it.each([
    ["not JSON", "{"],
    ["not a list", "{}"],
    ["damaged entries", JSON.stringify(["x", ["k"], [1, {}], ["k", null], ["k", { requestId: "a" }]])],
  ])("starts clean from storage that is %s", async (_label, raw) => {
    localStorage.setItem(PHASE5_KEY, raw);
    const { phase5 } = await load();

    expect(idOf(phase5.attachPhase5VoucherRequestIdentity("POST", path, note))).toBeTruthy();
  });

  it("still works when storage refuses writes, and without randomUUID", async () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    withoutRandomUuid();
    const { phase5 } = await load();

    const id = idOf(phase5.attachPhase5VoucherRequestIdentity("POST", path, note));
    expect(id).toMatch(/^voucher-op-\d+-/);
    expect(idOf(phase5.attachPhase5VoucherRequestIdentity("POST", path, note))).toBe(id);
  });

  it("uses the accounting release rule", async () => {
    const { phase5 } = await load();
    expect(phase5.shouldReleasePhase5VoucherRequestIdentity(200)).toBe(true);
    expect(phase5.shouldReleasePhase5VoucherRequestIdentity(409)).toBe(false);
  });
});
