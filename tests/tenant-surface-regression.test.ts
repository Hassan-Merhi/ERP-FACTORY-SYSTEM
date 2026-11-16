import type { SQL } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";

import { runWithCompanyRequestRuntimeContext } from "../server/services/security/companyRequestRuntimeContext";
import { assertTransactionCompanyScope } from "../server/services/security/transactionCompanyScope";

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
