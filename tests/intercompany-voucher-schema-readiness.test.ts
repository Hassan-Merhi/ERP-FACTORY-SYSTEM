import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

const execute = vi.hoisted(() => vi.fn());
vi.mock("../server/db", () => ({ db: { execute } }));

import { hasIntercompanyVoucherPoliciesTable } from "../server/lib/intercompanyTradeAvailability";

describe("optional intercompany policy table on normal voucher routes", () => {
  it("does not cache absence, propagates DB failures, and starts enforcing after installation", async () => {
    execute
      .mockResolvedValueOnce({ rows: [{ present: false }] })
      .mockRejectedValueOnce(new Error("database unavailable"))
      .mockResolvedValueOnce({ rows: [{ present: true }] });

    expect(await hasIntercompanyVoucherPoliciesTable()).toBe(false);
    await expect(hasIntercompanyVoucherPoliciesTable()).rejects.toThrow("database unavailable");
    expect(await hasIntercompanyVoucherPoliciesTable()).toBe(true);
    expect(await hasIntercompanyVoucherPoliciesTable()).toBe(true);
    expect(execute).toHaveBeenCalledTimes(3);
  });

  it("checks schema before matching and rejects explicit mirrored posting without it", () => {
    const route = readFileSync("server/routes/vouchers/normalIntercompanyVoucherRoutes.ts", "utf8");
    expect(route.indexOf("await hasIntercompanyVoucherPoliciesTable()")).toBeLessThan(
      route.indexOf(".from(intercompanyRelationshipPolicies)")
    );
    expect(route).toContain("return { identity, match: null, policyTableAvailable: false }");
    expect(route).toContain('if (!policyTableAvailable && req.body?.intercompanyMirror != null)');
    expect(route).toContain('"IC_VOUCHER_SCHEMA_UNAVAILABLE"');
    expect(route).toContain("return next()");
    expect(route).toContain('sourceModule === "INTERCOMPANY_CONTAINER"');
  });
});
