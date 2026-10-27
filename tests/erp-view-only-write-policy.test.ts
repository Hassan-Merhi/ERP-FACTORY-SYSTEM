import { describe, expect, it } from "vitest";
import { isViewOnlyWriteBlocked } from "../server/services/security/viewOnlyWritePolicy";

describe("ERP and Factory View Only API write boundary", () => {
  const businessWrites = [
    ["POST", "/api/vouchers"],
    ["PUT", "/api/vouchers/42"],
    ["PATCH", "/api/containers/42/tracking"],
    ["POST", "/api/containers/42/offload"],
    ["POST", "/api/factory/offload"],
    ["DELETE", "/api/stock-items/42"],
    ["POST", "/api/git/containers/import-excel"],
    ["POST", "/api/git/send-containers-whatsapp"],
    ["POST", "/api/transporter-statement/42/reallocate"],
    ["DELETE", "/api/auth/passkey/42"],
    ["POST", "/api/auth/passkey/register/verify"],
    ["POST", "/api/erp-user-page-access/42"],
  ];
  it.each(businessWrites)("denies %s %s", (method, path) => {
    expect(isViewOnlyWriteBlocked("View Only", method, path)).toBe(true);
  });
  it("allows read-only reporting without widening permissions", () => {
    expect(isViewOnlyWriteBlocked("View Only", "GET", "/api/git/containers")).toBe(false);
    expect(isViewOnlyWriteBlocked("View Only", "GET", "/api/stats/net-profit")).toBe(false);
    expect(isViewOnlyWriteBlocked("View Only", "HEAD", "/api/health/ready")).toBe(false);
    expect(isViewOnlyWriteBlocked("View Only", "GET", "/api/user-company-roles")).toBe(false);
  });
  it("keeps specific session and passive transport writes, but no other auth writes", () => {
    for (const path of ["/api/auth/logout", "/api/auth/set-company", "/api/auth/confirm-password"]) {
      expect(isViewOnlyWriteBlocked("View Only", "POST", path)).toBe(false);
    }
    expect(isViewOnlyWriteBlocked("View Only", "POST", "/api/auth/new-admin-action")).toBe(true);
    expect(isViewOnlyWriteBlocked("View Only", "POST", "/api/screen-feed")).toBe(false);
    expect(isViewOnlyWriteBlocked("View Only", "POST", "/api/screen-feed/admin")).toBe(true);
    expect(isViewOnlyWriteBlocked("View Only", "POST", "/api/screen-feed/control/tab-heartbeat")).toBe(false);
  });
  it("does not change full-access roles", () => {
    expect(isViewOnlyWriteBlocked("Admin", "DELETE", "/api/vouchers/42")).toBe(false);
    expect(isViewOnlyWriteBlocked("Manager", "POST", "/api/factory/offload")).toBe(false);
  });
});
