import { describe, expect, it, vi } from "vitest";

import { runSpSupplierVoucherStartup } from "../server/routes/sp/spSupplierVoucherStartup";

// Wave 16 (A): startup installs the link trigger only. The global supplier
// link repair it also ran (rewriting posted vouchers of every company with no
// audit) is now the Owner preview/apply, so these tests no longer expect it.
describe("SP supplier voucher startup scope", () => {
  it("runs the trigger setup inside explicit maintenance scope and repairs nothing", async () => {
    let maintenanceActive = false;
    const ensureTrigger = vi.fn(async () => {
      expect(maintenanceActive).toBe(true);
    });
    const runMaintenanceScope = vi.fn(async (reason: string, callback: () => Promise<void>) => {
      expect(reason).toBe("sp-supplier-voucher-sync-startup");
      maintenanceActive = true;
      try {
        return await callback();
      } finally {
        maintenanceActive = false;
      }
    });

    await expect(runSpSupplierVoucherStartup({ ensureTrigger, runMaintenanceScope })).resolves.toBeUndefined();

    expect(ensureTrigger).toHaveBeenCalledTimes(1);
    expect(runMaintenanceScope).toHaveBeenCalledTimes(1);
    expect(maintenanceActive).toBe(false);
  });

  it("keeps startup failures visible instead of bypassing tenant isolation", async () => {
    const failure = new Error("supplier trigger setup failed");
    const ensureTrigger = vi.fn(async () => {
      throw failure;
    });

    await expect(
      runSpSupplierVoucherStartup({
        ensureTrigger,
        runMaintenanceScope: async (_reason, callback) => callback(),
      })
    ).rejects.toBe(failure);

    expect(ensureTrigger).toHaveBeenCalledTimes(1);
  });
});
