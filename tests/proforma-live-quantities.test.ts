import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { usesLiveMasterProforma } from "../server/routes/factory/customer-orders/proformaPlan";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

describe("open loading proforma quantity synchronization", () => {
  it("uses current master amounts for ordinary, unfinished loadings", () => {
    expect(usesLiveMasterProforma("LOADING", false)).toBe(true);
    expect(usesLiveMasterProforma("DRAFT", false)).toBe(true);
    expect(usesLiveMasterProforma("PENDING_VERIFICATION", false)).toBe(true);
  });

  it("never substitutes master quantities for remaining-only continuations", () => {
    expect(usesLiveMasterProforma("LOADING", true)).toBe(false);
    expect(usesLiveMasterProforma("DRAFT", true)).toBe(false);
  });

  it("freezes verified, finalized, and cancelled history", () => {
    expect(usesLiveMasterProforma("VERIFIED", false)).toBe(false);
    expect(usesLiveMasterProforma("FINALIZED", false)).toBe(false);
    expect(usesLiveMasterProforma("CANCELLED", false)).toBe(false);
  });

  it("tracks JNAH 000 HMD10027 after master changes from 1 to 3", () => {
    const master = 3;
    const oldExpected = 1;
    const loaded = 1;
    expect(oldExpected - loaded).toBe(0);
    const expected = usesLiveMasterProforma("LOADING", false) ? master : oldExpected;
    expect(expected - loaded).toBe(2);
  });

  it("protects the shared comparison, scan, list, and finalize paths", () => {
    const verify = read("server/routes/factory/customer-orders/verify-recover/verification-summary.ts");
    const capacity = read("server/routes/factory/customer-orders/proformaCapacity.ts");
    const list = read("server/routes/factory/customer-orders/orderCrudRoutes.ts");
    const finalize = read("server/routes/factory/customer-orders/finalize-loading/loading.ts");
    const lines = read("server/routes/factory/customer-proformas/lines.ts");
    expect(verify).toContain("usesLiveMasterProforma(order.status, continuation)");
    expect(capacity).toContain("co.status IN ('DRAFT', 'LOADING', 'PENDING_VERIFICATION')");
    expect(capacity).toContain("NOT (\${liveMasterPlan})");
    expect(list).toContain("proformaExpectedBales: sql<string>\`CASE WHEN \${liveMasterPlan}");
    expect(finalize).toContain("usesLiveMasterProforma(order.status, continuation)");
    expect(lines).toContain("SET expected_qty = \${updated.quantity}");
    expect(lines).toContain("event.description LIKE 'Continuation of loading #%'");
  });
});
