/**
 * Access control for settling GC Sales Cash out of Hassan Dakik Equity.
 *
 * This operation moves partner capital, so it must carry the owner-withdrawal
 * permission rather than the sales-entry one. The endpoint path contains the
 * substring "sales", which the generic rule in `classifyPermission` would
 * otherwise claim — ordering inside that function is what makes the explicit
 * classification win, so the assertions here drive the real function rather
 * than inspecting the file that defines it.
 */
import type { Request } from "express";
import { describe, expect, it } from "vitest";
import { classifyPermission } from "./spAccessControl";

function classify(path: string, method: string) {
  return classifyPermission({ path, method } as Pick<Request, "path" | "method">);
}

const EQUITY_SETTLEMENT = "/golden-coast/equity-sales-cash-settlement";

describe("Golden Coast equity settlement permission classification", () => {
  it("requires the owner-withdrawal permission, never sales entry", () => {
    expect(classify(EQUITY_SETTLEMENT, "POST")).toBe("sp_owner_withdrawal");
    expect(classify(EQUITY_SETTLEMENT, "POST")).not.toBe("sp_sales_create");
  });

  it("classifies it the same way as the Phase 9 owner withdrawal beside it", () => {
    expect(classify(EQUITY_SETTLEMENT, "POST")).toBe(
      classify("/golden-coast/phase9/hassan-savings-withdrawal", "POST")
    );
  });

  it("still lets an ordinary sales write fall through to sales entry", () => {
    // Proves the explicit rule is targeted rather than swallowing the generic
    // one, which a mis-ordered or over-broad match would break.
    expect(classify("/sales", "POST")).toBe("sp_sales_create");
    expect(classify("/sales/123/lines", "POST")).toBe("sp_sales_create");
  });

  it("leaves the readiness GET as an ordinary view", () => {
    expect(classify(`${EQUITY_SETTLEMENT}/readiness`, "GET")).toBe("sp_view");
  });
});
