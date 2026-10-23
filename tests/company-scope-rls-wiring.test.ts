import { describe, expect, it, vi } from "vitest";

describe("company-scope RLS startup wiring", () => {
  it("applies and verifies the company-scope RLS readiness migration against PostgreSQL", async () => {
    const { ensureCompanyScopeRlsReadiness } = await import("../server/companyScopeRlsBridge.mjs");

    await expect(ensureCompanyScopeRlsReadiness()).resolves.toBeUndefined();
  });

  it("does not replay the migration's table locks once the database already matches it", async () => {
    // Replaying 0016 on every boot took ACCESS EXCLUSIVE locks on vouchers and
    // voucher_entries and deadlocked against the instance still serving traffic.
    const { ensureCompanyScopeRlsReadiness } = await import("../server/companyScopeRlsBridge.mjs");
    const logged = vi.spyOn(console, "log");
    try {
      await ensureCompanyScopeRlsReadiness();
      const verified = logged.mock.calls
        .map(([line]) => String(line))
        .find((line) => line.includes("Company-scope RLS fail-closed readiness verified"));
      expect(JSON.parse(verified!)).toMatchObject({ migrationApplied: false });
    } finally {
      logged.mockRestore();
    }
  });
});
