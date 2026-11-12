import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  matchNormalIntercompanyVoucher,
  type NormalVoucherPolicy,
} from "../server/services/intercompany/normalVoucherMatching";
import { INTERCOMPANY_CANONICAL_DESTINATIONS } from "../client/src/pages/intercompany/intercompanyLegacyNavigation";

const pair: NormalVoucherPolicy = {
  id: 44, relationshipType: "container_trade",
  sourceCompanyId: 10, destinationCompanyId: 20, tradeEnabled: true,
  sourceReceivableAccountId: 101, destinationPayableAccountId: 202, destinationSupplierId: 303,
};
function matching(
  companyId: number, voucherType: string, accountType: string, accountId: number,
  overrides: {
    policies?: NormalVoucherPolicy[];
    entries?: { accountType: string; accountId: number }[];
    paymentAccount?: { accountType: string; accountId: number };
  } = {}
) {
  return matchNormalIntercompanyVoucher({
    companyId, voucherType,
    paymentAccount: overrides.paymentAccount ?? { accountType: "bank", accountId: 888 },
    entries: overrides.entries ?? [{ accountType, accountId }],
    policies: overrides.policies ?? [pair],
  });
}

describe("Phase 6 normal voucher linked-account auto-mirror", () => {
  it("detects destination supplier and payable aliases without doubling liability", () => {
    expect(matching(20, "Payment", "supplier", 303)?.role).toBe("destination-payment");
    expect(matching(20, "Payment", "ledger", 202)?.role).toBe("destination-payment");
  });
  it("detects Properties linked receivable on a normal Receipt", () => {
    expect(matching(10, "Receipt", "ledger", 101)).toEqual({
      relationshipId: 44, sourceCompanyId: 10, destinationCompanyId: 20, role: "source-receipt",
    });
  });
  it("leaves non-linked suppliers and unrelated companies alone", () => {
    expect(matching(20, "Payment", "supplier", 999)).toBeNull();
    expect(matching(10, "Receipt", "ledger", 500)).toBeNull();
    expect(matching(21, "Payment", "supplier", 303)).toBeNull();
    expect(matching(20, "Payment", "supplier", 303, { policies: [] })).toBeNull();
  });
  it("refuses opposite-direction or ambiguous postings", () => {
    expect(() => matching(20, "Receipt", "supplier", 303)).toThrow("Reverse an existing transfer");
    expect(() => matching(10, "Payment", "ledger", 101)).toThrow("Reverse an existing transfer");
    expect(() => matching(20, "Payment", "supplier", 303, { policies: [pair, { ...pair, id: 45 }] }))
      .toThrow("exactly one linked company entry");
  });
  it("requires actual bank/cash and forbids multiple entries in a single mirrored transfer", () => {
    expect(() => matching(20, "Payment", "supplier", 303, {
      paymentAccount: { accountType: "ledger", accountId: 202 },
    })).toThrow("cash or bank account");
    expect(() => matching(20, "Payment", "supplier", 303, {
      entries: [{ accountType: "supplier", accountId: 303 }, { accountType: "supplier", accountId: 999 }],
    })).toThrow("exactly one linked company entry");
    expect(() => matching(20, "Payment", "supplier", 303, {
      paymentAccount: { accountType: "supplier", accountId: 777 },
    })).toThrow("actual active cash ledger or bank");
  });
  it("never falls through when the mapped trading relation was disabled", () => {
    expect(() => matching(20, "Payment", "supplier", 303, {
      policies: [{ ...pair, tradeEnabled: false }],
    })).toThrow("disabled");
  });
  it("intercepts before both ordinary endpoints and blocks offline or partial posting", () => {
    const registry = readFileSync("server/routes/voucherRoutes.ts", "utf8");
    const route = readFileSync("server/routes/vouchers/normalIntercompanyVoucherRoutes.ts", "utf8");
    const save = readFileSync("client/src/pages/vouchers/useVoucherSaveMutation.ts", "utf8");
    expect(registry.indexOf("registerNormalIntercompanyVoucherRoutes(app);"))
      .toBeLessThan(registry.indexOf("registerCentralPaymentReceiptCreateRoute(app);"));
    expect(registry.indexOf("registerNormalIntercompanyVoucherRoutes(app);"))
      .toBeLessThan(registry.indexOf("registerVoucherPaymentRoutes(app);"));
    expect(route).toContain("confirmMirroredPayment({");
    expect(route).toContain("isPhase9LanPrimary()");
    expect(route).toContain("req.body.optional === true");
    expect(route).toContain('sourceModule === "INTERCOMPANY_CONTAINER"');
    expect(save).toContain('apiRequestPrivileged("POST", endpoint, mirroredPayload)');
    expect(save).toContain("attachAccountingRequestIdentity");
  });
  it("has no separate Intercompany tab and redirects old links into normal Payment", () => {
    const page = readFileSync("client/src/pages/Vouchers.tsx", "utf8");
    const sidebar = readFileSync("client/src/pages/vouchers/voucherSidebarGroups.ts", "utf8");
    expect(page).toContain("normalIntercompany.details");
    expect(page).toContain("normalIntercompany.buildMirror()");
    expect(page).not.toContain('activeTab === "intercompany"');
    expect(sidebar).not.toContain('key: "intercompany"');
    expect(INTERCOMPANY_CANONICAL_DESTINATIONS.propertiesVouchers).toBe("/properties/vouchers?tab=payment");
    expect(INTERCOMPANY_CANONICAL_DESTINATIONS.erpVouchers).toBe("/vouchers?tab=payment");
  });
});
