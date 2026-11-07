import { describe, expect, it } from "vitest";
import { isCreateOnlyWriteBlocked } from "../server/services/security/createOnlyWritePolicy";

describe("Phase 3 Create Only global API boundary", () => {
  it("preserves existing role behavior", () => {
    for (const role of ["Developer", "Admin", "Owner", "Manager", "POS", "View Only", "ERP Tester"]) {
      expect(isCreateOnlyWriteBlocked(role, "DELETE", "/api/vouchers/1")).toBe(false);
    }
  });

  it("denies unreviewed writes including POSTs that mutate old state", () => {
    for (const [method, path] of [
      ["POST", "/api/vouchers/123/reverse"],
      ["POST", "/api/factory/containers/8/reverse-offload"],
      ["POST", "/api/factory/payrolls/generate-bulk"],
      ["PATCH", "/api/suppliers/7"],
      ["DELETE", "/api/suppliers/7"],
      ["POST", "/api/suppliers/bulk-delete"],
      ["POST", "/api/stock-items/import"],
      ["PATCH", "/api/factory/bales/8/status"],
      ["POST", "/api/suppliers/9"],
      ["TRACE", "/api/suppliers"],
    ] as const) {
      expect(isCreateOnlyWriteBlocked("Create Only", method, path)).toBe(true);
    }
  });

  it("allows only reviewed new-record endpoint to reach its own handler guard", () => {
    expect(isCreateOnlyWriteBlocked("Create Only", "POST", "/api/suppliers")).toBe(false);
    expect(isCreateOnlyWriteBlocked("Create Only", "GET", "/api/suppliers")).toBe(false);
  });

  it("does not block authentication or passive session lifecycle operations", () => {
    for (const [method, path] of [
      ["POST", "/api/auth/logout"],
      ["POST", "/api/auth/set-company"],
      ["PATCH", "/api/user-presence"],
      ["POST", "/api/screen-feed/control/tab-heartbeat"],
    ] as const) {
      expect(isCreateOnlyWriteBlocked("Create Only", method, path)).toBe(false);
    }
  });

  it("cannot bypass via a similarly named route or case variant", () => {
    expect(isCreateOnlyWriteBlocked("Create Only", "POST", "/api/suppliers/")).toBe(true);
    expect(isCreateOnlyWriteBlocked("Create Only", "POST", "/api/suppliers/import")).toBe(true);
    expect(isCreateOnlyWriteBlocked("Create Only", "PUT", "/api/suppliers")).toBe(true);
  });
});
