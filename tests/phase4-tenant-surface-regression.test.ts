import type { SQL } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";

import { runWithCompanyRequestRuntimeContext } from "../server/services/security/companyRequestRuntimeContext";
import {
  assertTransactionCompanyScope,
  isCompanyInRequestScope,
} from "../server/services/security/transactionCompanyScope";

const surfaces = [
  { name: "ERP", role: "Admin", path: "/api/vouchers" },
  { name: "Factory", role: "Manager", path: "/api/factory/offloads" },
  { name: "POS", role: "POS", path: "/api/pos/sales" },
  // Capacitor/mobile clients use the same authenticated API routes after their
  // origin has passed the mobile CORS/CSRF admission layer. Tenant enforcement
  // must therefore remain identical to the browser ERP client.
  { name: "mobile", role: "Normal User", path: "/api/stock-items" },
] as const;

describe("Phase 4 tenant scope across application surfaces", () => {
  for (const surface of surfaces) {
    it(`${surface.name} keeps PostgreSQL scope bound to the canonical request company`, async () => {
      const execute = vi.fn(async (_query: SQL) => undefined);
      const context = {
        userId: `phase-4-${surface.name.toLowerCase()}`,
        companyId: 71,
        role: surface.role,
        developerBypass: false,
        method: "POST",
        path: surface.path,
      };

      await expect(
        runWithCompanyRequestRuntimeContext(context, () => assertTransactionCompanyScope({ execute }, 71))
      ).resolves.toBe(71);
      expect(execute).toHaveBeenCalledTimes(1);

      execute.mockClear();
      await expect(
        runWithCompanyRequestRuntimeContext(context, () => assertTransactionCompanyScope({ execute }, 72))
      ).rejects.toMatchObject({ code: "TRANSACTION_COMPANY_SCOPE_INVALID" });
      expect(execute).not.toHaveBeenCalled();
    });
  }
});

describe("isCompanyInRequestScope", () => {
  const context = {
    userId: "phase-4-scope-check",
    companyId: 71,
    authorizedCompanyIds: [73],
    role: "Admin",
    developerBypass: false,
    method: "PUT",
    path: "/api/vouchers/1",
  };

  it("allows the request's company and its membership-checked secondary companies only", () => {
    runWithCompanyRequestRuntimeContext(context, () => {
      expect(isCompanyInRequestScope(71)).toBe(true);
      expect(isCompanyInRequestScope(73)).toBe(true);
      expect(isCompanyInRequestScope(72)).toBe(false);
    });
  });

  it("allows any company outside an HTTP request, as background work asserts its own", () => {
    expect(isCompanyInRequestScope(72)).toBe(true);
  });

  it("agrees with assertTransactionCompanyScope and never touches the transaction itself", async () => {
    const execute = vi.fn(async (_query: SQL) => undefined);
    await runWithCompanyRequestRuntimeContext(context, async () => {
      expect(isCompanyInRequestScope(72)).toBe(false);
      await expect(assertTransactionCompanyScope({ execute }, 72)).rejects.toMatchObject({
        code: "TRANSACTION_COMPANY_SCOPE_INVALID",
      });
      await expect(assertTransactionCompanyScope({ execute }, 73)).resolves.toBe(73);
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
