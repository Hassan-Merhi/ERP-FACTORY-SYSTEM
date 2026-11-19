/**
 * Which browser requests carry an accounting request identity, and how long
 * the identity is kept (client/src/lib/accountingRequestIdentity.ts).
 *
 * A protected write keeps one identity until the browser sees a definite
 * outcome, so a retried or double-clicked write is replayed by the server
 * instead of posting twice. The identity survives a reload through
 * localStorage. Getting the list of protected requests wrong either posts
 * twice (missing route) or blocks an unrelated request (extra route).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type IdentityModule = typeof import("../client/src/lib/accountingRequestIdentity");
const MODULE = "../client/src/lib/accountingRequestIdentity";
const STORAGE_KEY = "erp_pending_accounting_request_ids_v2";

/** A fresh copy of the module, so its in-memory map and storage hydration start over. */
async function freshModule(): Promise<IdentityModule> {
  vi.resetModules();
  return import(MODULE);
}

function memoryStorage(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("isProtectedAccountingRequest", () => {
  let rules: IdentityModule;
  beforeEach(async () => {
    rules = await freshModule();
  });

  const journal = { voucherDate: "2026-07-25", entries: [] };

  it.each([
    ["POST", "/api/vouchers/journal", journal],
    ["post", "/api/vouchers/journal?draft=0", journal],
    ["POST", "/api/vouchers/journal-entries", journal],
    ["POST", "/api/vouchers/payment-receipt", { voucherType: "Payment" }],
    ["POST", "/api/vouchers/payment-receipt", { voucherType: "Receipt" }],
    ["POST", "/api/vouchers", { voucherType: "Sales" }],
    ["POST", "/api/vouchers/with-entries", { voucher: { voucherNumber: "A-1" }, entries: [] }],
    ["POST", "/api/simple-company-transfer", {}],
    ["POST", "/api/inter-company-transfers", {}],
    ["POST", "/api/stock-transfers", { items: [] }],
    ["POST", "/api/stock-transfers", { voucherId: null }],
    ["POST", "/api/salary-advances", {}],
    ["POST", "/api/factory/pos/sale", {}],
    ["POST", "/api/factory/employees/12/deposit", {}],
    ["POST", "/api/factory/employees/12/withdraw", {}],
    ["POST", "/api/factory/worker-bonuses/7/pay", {}],
    ["POST", "/api/offloads/3/toggle-optional", {}],
    ["POST", "/api/factory/containers/9/reverse-offload", {}],
    ["POST", "/api/factory/workers/4/bulk-repay-advances", {}],
    ["POST", "/api/factory/advances/5/repayments", {}],
    ["PATCH", "/api/payroll/runs/8", { action: "pay" }],
    ["patch", "/api/factory/payrolls/2/mark-paid", {}],
    ["PATCH", "/api/factory/payrolls/2/fix-accounting", {}],
  ])("protects %s %s", (method, url, data) => {
    expect(rules.isProtectedAccountingRequest(method, url, data)).toBe(true);
  });

  it.each([
    ["GET", "/api/vouchers/journal", journal, "a read"],
    ["PUT", "/api/vouchers/journal", journal, "another verb"],
    ["POST", "/api/vouchers/journal", { ...journal, optional: true }, "an optional journal"],
    ["POST", "/api/vouchers/journal", null, "no body"],
    ["POST", "/api/vouchers/journal", [journal], "an array body"],
    ["POST", "/api/vouchers/payment-receipt", { voucherType: "Contra" }, "another voucher type"],
    ["POST", "/api/vouchers/payment-receipt", { voucherType: "Payment", optional: true }, "an optional payment"],
    ["POST", "/api/vouchers", { optional: true }, "an optional direct voucher"],
    ["POST", "/api/vouchers/with-entries", { voucher: { optional: true } }, "an optional generic voucher"],
    ["POST", "/api/vouchers/with-entries", { voucher: "A-1" }, "a generic voucher without its voucher"],
    ["POST", "/api/vouchers/with-entries", { voucher: null }, "a null voucher"],
    ["POST", "/api/stock-transfers", { voucherId: 42 }, "a stock transfer that already has its voucher"],
    ["POST", "/api/factory/employees/12/deposit/extra", {}, "a longer path"],
    ["POST", "/api/factory/employees//deposit", {}, "an empty id"],
    ["POST", "/api/factory/worker-bonuses/7/pay/now", {}, "a longer bonus path"],
    ["PATCH", "/api/factory/worker-bonuses/7/pay", {}, "the bonus path with PATCH"],
    ["POST", "/api/offloads/3/toggle-optional/x", {}, "a longer offload path"],
    ["POST", "/api/factory/containers/9/reverse-offload/x", {}, "a longer reversal path"],
    ["POST", "/api/factory/workers/4/bulk-repay-advances/x", {}, "a longer repay path"],
    ["POST", "/api/factory/advances/5/repayments/x", {}, "a longer repayments path"],
    ["PATCH", "/api/payroll/runs/8", { action: "approve" }, "a payroll run that is not paid"],
    ["PATCH", "/api/payroll/runs/8/lines", { action: "pay" }, "a payroll sub-path"],
    ["POST", "/api/payroll/runs/8", { action: "pay" }, "the payroll path with POST"],
    ["PATCH", "/api/factory/payrolls/2/delete", {}, "another payroll action"],
    ["POST", "/api/factory/payrolls/2/mark-paid", {}, "the payroll action with POST"],
    ["PATCH", "/api/salary-advances", {}, "an operational path with PATCH"],
    ["POST", "/api/factory/pos/sale", "text", "an operational write without an object body"],
    ["DELETE", "/api/inter-company-transfers", {}, "a transfer delete"],
    ["POST", "/api/simple-company-transfer", null, "a transfer without a body"],
  ])("leaves %s %s alone (%s)", (method, url, data) => {
    expect(rules.isProtectedAccountingRequest(method, url, data)).toBe(false);
  });
});

describe("the identity's lifecycle", () => {
  let rules: IdentityModule;
  beforeEach(async () => {
    rules = await freshModule();
  });

  const url = "/api/vouchers/journal";
  const payload = () => ({ voucherDate: "2026-07-25", entries: [{ amount: "10" }] });
  const idOf = (value: unknown) => (value as { clientRequestId: string }).clientRequestId;

  it("adds nothing to a request that is not protected", () => {
    const body = { name: "x" };
    expect(rules.attachAccountingRequestIdentity("POST", "/api/customers", body)).toBe(body);
  });

  it("gives the same payload the same identity until it is released, whatever the query string", () => {
    const first = idOf(rules.attachAccountingRequestIdentity("POST", url, payload()));
    expect(idOf(rules.attachAccountingRequestIdentity("POST", `${url}?retry=1`, payload()))).toBe(first);

    rules.releaseAccountingRequestIdentity("POST", url, payload());
    expect(idOf(rules.attachAccountingRequestIdentity("POST", url, payload()))).not.toBe(first);
  });

  it("keeps an uncertain identity until a definite outcome releases it", () => {
    const first = idOf(rules.attachAccountingRequestIdentity("POST", url, payload()));
    rules.markAccountingRequestOutcomeUncertain("POST", url, payload());

    rules.releaseAccountingRequestIdentity("POST", url, payload());
    expect(idOf(rules.attachAccountingRequestIdentity("POST", url, payload()))).toBe(first);

    rules.releaseAccountingRequestIdentity("POST", url, payload(), true);
    expect(idOf(rules.attachAccountingRequestIdentity("POST", url, payload()))).not.toBe(first);
  });

  it("ignores marking or releasing a request it never tagged", () => {
    rules.markAccountingRequestOutcomeUncertain("POST", url, payload());
    rules.markAccountingRequestOutcomeUncertain("POST", "/api/customers", {});
    rules.releaseAccountingRequestIdentity("POST", "/api/customers", {});
    const first = idOf(rules.attachAccountingRequestIdentity("POST", url, payload()));
    rules.releaseAccountingRequestIdentity("POST", url, payload());
    expect(idOf(rules.attachAccountingRequestIdentity("POST", url, payload()))).not.toBe(first);
  });

  it("keeps an identity the caller already set", () => {
    const body = { ...payload(), clientRequestId: "offline-replay-1" };
    expect(rules.attachAccountingRequestIdentity("POST", url, body)).toBe(body);
    const blank = { ...payload(), clientRequestId: "   " };
    expect(idOf(rules.attachAccountingRequestIdentity("POST", url, blank))).not.toBe("   ");
  });

  it("falls back to a generated identity without crypto.randomUUID", async () => {
    vi.stubGlobal("crypto", {});
    const withoutUuid = await freshModule();
    expect(idOf(withoutUuid.attachAccountingRequestIdentity("POST", url, payload()))).toMatch(
      /^accounting-\d+-[a-z0-9]+$/
    );
  });
});

describe("reading the server's answer", () => {
  let rules: IdentityModule;
  beforeEach(async () => {
    rules = await freshModule();
  });

  const response = (status: number, body: string) => new Response(body, { status });

  it("reads the code of a 409 and nothing else", async () => {
    expect(
      await rules.accountingResponseCode(response(409, JSON.stringify({ code: "ACCOUNTING_PERIOD_CLOSED" })))
    ).toBe("ACCOUNTING_PERIOD_CLOSED");
    expect(await rules.accountingResponseCode(response(409, JSON.stringify({ code: 7 })))).toBeUndefined();
    expect(await rules.accountingResponseCode(response(409, JSON.stringify(["code"])))).toBeUndefined();
    expect(await rules.accountingResponseCode(response(409, "not json"))).toBeUndefined();
    expect(await rules.accountingResponseCode(response(400, JSON.stringify({ code: "X" })))).toBeUndefined();
  });

  it("leaves the response readable after looking at its code", async () => {
    const answer = response(409, JSON.stringify({ code: "X", message: "m" }));
    await rules.accountingResponseCode(answer);
    expect(await answer.json()).toEqual({ code: "X", message: "m" });
  });

  it("releases on success and definite client errors only", () => {
    expect(rules.shouldReleaseAccountingRequestIdentity(200)).toBe(true);
    expect(rules.shouldReleaseAccountingRequestIdentity(399)).toBe(true);
    expect(rules.shouldReleaseAccountingRequestIdentity(400)).toBe(true);
    expect(rules.shouldReleaseAccountingRequestIdentity(499)).toBe(true);
    expect(rules.shouldReleaseAccountingRequestIdentity(409, "ACCOUNTING_PERIOD_CLOSED")).toBe(true);
    expect(rules.shouldReleaseAccountingRequestIdentity(199)).toBe(false);
    expect(rules.shouldReleaseAccountingRequestIdentity(500)).toBe(false);
    expect(rules.shouldReleaseAccountingRequestIdentity(409)).toBe(false);
    expect(rules.shouldReleaseAccountingRequestIdentity(409, "ACCOUNTING_REQUEST_OUTCOME_UNCERTAIN")).toBe(false);
  });
});

describe("keeping identities across a reload", () => {
  const url = "/api/vouchers/journal";
  const payload = { voucherDate: "2026-07-25", entries: [{ amount: "10" }] };
  const key = `POST:${url}:${JSON.stringify(payload)}`;

  it("saves a new identity and reuses it after the page loads again", async () => {
    const storage = memoryStorage();
    vi.stubGlobal("localStorage", storage);
    const before = await freshModule();
    const first = (before.attachAccountingRequestIdentity("POST", url, payload) as { clientRequestId: string })
      .clientRequestId;
    const saved = JSON.parse(storage.store.get(STORAGE_KEY) as string);
    expect(saved).toEqual([[key, { requestId: first, createdAt: expect.any(Number) }]]);

    const after = await freshModule();
    expect(
      (after.attachAccountingRequestIdentity("POST", url, payload) as { clientRequestId: string }).clientRequestId
    ).toBe(first);
  });

  it("restores the uncertain flag, and only a real true", async () => {
    vi.stubGlobal(
      "localStorage",
      memoryStorage({
        [STORAGE_KEY]: JSON.stringify([
          [key, { requestId: "kept-1", createdAt: 1, outcomeUncertain: true }],
          [`POST:${url}:{"other":1}`, { requestId: "kept-2", createdAt: 1, outcomeUncertain: "yes" }],
        ]),
      })
    );
    const rules = await freshModule();

    rules.releaseAccountingRequestIdentity("POST", url, payload);
    expect(
      (rules.attachAccountingRequestIdentity("POST", url, payload) as { clientRequestId: string }).clientRequestId
    ).toBe("kept-1");
    rules.releaseAccountingRequestIdentity("POST", url, { other: 1 });
    expect(
      (rules.attachAccountingRequestIdentity("POST", url, { other: 1 }) as { clientRequestId: string }).clientRequestId
    ).not.toBe("kept-2");
  });

  it("skips malformed saved entries and keeps the good ones", async () => {
    vi.stubGlobal(
      "localStorage",
      memoryStorage({
        [STORAGE_KEY]: JSON.stringify([
          "not an entry",
          [key],
          [42, { requestId: "x", createdAt: 1 }],
          [`POST:${url}:{"a":1}`, "not an object"],
          [`POST:${url}:{"b":1}`, { requestId: 5, createdAt: 1 }],
          [`POST:${url}:{"c":1}`, { requestId: "x", createdAt: "1" }],
          [key, { requestId: "good", createdAt: 1 }],
        ]),
      })
    );
    const rules = await freshModule();
    const id = (body: Record<string, unknown>) =>
      (rules.attachAccountingRequestIdentity("POST", url, body) as { clientRequestId: string }).clientRequestId;

    expect(id(payload)).toBe("good");
    for (const other of [{ a: 1 }, { b: 1 }, { c: 1 }]) expect(id(other)).not.toBe("x");
  });

  it("starts empty when the saved value is not a list, or not JSON", async () => {
    for (const raw of [JSON.stringify({ not: "a list" }), "{broken"]) {
      vi.stubGlobal("localStorage", memoryStorage({ [STORAGE_KEY]: raw }));
      const rules = await freshModule();
      expect(
        (rules.attachAccountingRequestIdentity("POST", url, payload) as { clientRequestId: string }).clientRequestId
      ).toMatch(/\S/);
    }
  });

  it("keeps working in memory when storage throws", async () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("quota");
      },
    });
    const rules = await freshModule();
    const first = (rules.attachAccountingRequestIdentity("POST", url, payload) as { clientRequestId: string })
      .clientRequestId;
    expect(
      (rules.attachAccountingRequestIdentity("POST", url, payload) as { clientRequestId: string }).clientRequestId
    ).toBe(first);
  });
});
