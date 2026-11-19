import { describe, expect, it } from "vitest";

import { replayAuthorizationContext } from "../server/services/accounting/replayAuthorizationContext";
import {
  resolveVoucherPathCompanyId,
  voucherPathRequestFingerprint,
} from "../server/services/accounting/voucherPathTransitionBoundary";
import { isPhase5OperationalVoucherRequest } from "../shared/voucherPathIdentityPolicy";

describe("Phase 5 endpoint-level voucher coverage", () => {
  it("protects both customer-order charge voucher writers", () => {
    expect(isPhase5OperationalVoucherRequest("POST", "/api/factory/customer-orders/42/charges")).toBe(true);
    expect(isPhase5OperationalVoucherRequest("POST", "/api/factory/customer-orders/42/charges/relink-vouchers")).toBe(
      true
    );
  });

  it("claims an explicitly authorized body company instead of the selected factory company", () => {
    const request = {
      path: "/api/factory/workers/42/advances",
      body: { companyId: 91 },
      session: { userId: 7, currentCompanyId: 12, factoryCompanyId: 34 },
    } as unknown as Parameters<typeof resolveVoucherPathCompanyId>[0];

    expect(resolveVoucherPathCompanyId(request)).toBe(91);
  });

  it("keeps SP migration opening balance scoped to its target company", () => {
    const request = {
      path: "/api/sp/migration/opening-balance",
      body: { companyId: 12, targetCompanyId: 77 },
      session: { userId: 7, currentCompanyId: 12 },
    } as unknown as Parameters<typeof resolveVoucherPathCompanyId>[0];

    expect(resolveVoucherPathCompanyId(request)).toBe(77);
  });

  it("changes the replay fingerprint when authorization-relevant context changes", () => {
    const baseRequest = {
      session: {
        userId: 7,
        currentRole: "Admin",
        currentCompanyId: 12,
        currentLocationId: 3,
        canDeleteRecords: true,
      },
      user: {
        id: 7,
        role: "Admin",
        assignedLocationId: 3,
        canDeleteRecords: true,
      },
    } as unknown as Parameters<typeof replayAuthorizationContext>[0];
    const changedRequest = {
      session: {
        userId: 7,
        currentRole: "POS",
        currentCompanyId: 12,
        currentLocationId: 3,
        canDeleteRecords: false,
      },
      user: {
        id: 7,
        role: "POS",
        assignedLocationId: 3,
        canDeleteRecords: false,
      },
    } as unknown as Parameters<typeof replayAuthorizationContext>[0];

    const original = voucherPathRequestFingerprint(
      "POST",
      "/api/credit-notes",
      { amount: "10.00" },
      replayAuthorizationContext(baseRequest)
    );
    const changed = voucherPathRequestFingerprint(
      "POST",
      "/api/credit-notes",
      { amount: "10.00" },
      replayAuthorizationContext(changedRequest)
    );

    expect(changed).not.toBe(original);
  });

  it("changes the replay fingerprint when a structured permission collection changes", () => {
    const withCreatePermission = {
      session: { userId: 7, currentRole: "Admin", currentCompanyId: 12 },
      user: { id: 7, role: "Admin", permissions: ["act_create_voucher", "act_view_voucher"] },
    } as unknown as Parameters<typeof replayAuthorizationContext>[0];
    const withoutCreatePermission = {
      session: { userId: 7, currentRole: "Admin", currentCompanyId: 12 },
      user: { id: 7, role: "Admin", permissions: ["act_view_voucher"] },
    } as unknown as Parameters<typeof replayAuthorizationContext>[0];

    const permitted = voucherPathRequestFingerprint(
      "POST",
      "/api/vouchers",
      { amount: "10.00" },
      replayAuthorizationContext(withCreatePermission)
    );
    const revoked = voucherPathRequestFingerprint(
      "POST",
      "/api/vouchers",
      { amount: "10.00" },
      replayAuthorizationContext(withoutCreatePermission)
    );

    expect(revoked).not.toBe(permitted);
  });
});
