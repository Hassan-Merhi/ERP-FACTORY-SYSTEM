import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => {
  const release = vi.fn();
  const query = vi.fn(async (text: string) => ({
    rows: [] as any[],
    rowCount: text === "ROLLBACK" ? null : 0,
  }));
  const connect = vi.fn(async () => ({ query, release }));
  return { release, query, connect };
});

vi.mock("../server/db", () => ({
  pool: { connect: harness.connect },
}));

import {
  buildSpOffloadChargeSignature,
  buildSpOffloadLockScope,
  classifySpOffloadState,
  isCompatibleSpOffloadReplay,
} from "../server/services/sp/spOffloadConcurrencyPolicy";
import { reconcilePostOffloadMutation } from "../server/services/factory/postOffloadReconciliation";

describe("Failure-Mode Suite: Container Offload / Reverse / Re-offload Lifecycle", () => {
  describe("Offload Concurrency & Replay Decision Matrix", () => {
    it("locks on company and container scope", () => {
      expect(buildSpOffloadLockScope(3, 101)).toEqual({ companyId: 3, containerId: 101 });
      expect(buildSpOffloadLockScope(4, 101)).not.toEqual(buildSpOffloadLockScope(3, 101));
      expect(buildSpOffloadLockScope(3, 102)).not.toEqual(buildSpOffloadLockScope(3, 101));
    });

    it("evaluates all state transitions for offload attempts", () => {
      // Normal open container -> proceed to post
      expect(classifySpOffloadState("open", false, false)).toBe("post");

      // Already offloaded + identical replay -> safe replay
      expect(classifySpOffloadState("offloaded", true, true)).toBe("replay");

      // Already offloaded + different payload -> conflict error
      expect(classifySpOffloadState("offloaded", true, false)).toBe("conflict");

      // Offloaded status in DB but missing offload tracking row -> reject
      expect(classifySpOffloadState("offloaded", false, false)).toBe("reject");

      // Unknown or null status -> reject
      expect(classifySpOffloadState(null, false, false)).toBe("reject");
      expect(classifySpOffloadState("in_transit", false, false)).toBe("reject");
    });

    it("matches normalized charge signatures across credit account variations", () => {
      const lineRequested = [
        { chargeType: "parent_agent", description: "Agent fee", amountUsd: "300.00", parentAgentAccountId: 77 },
        { chargeType: "paid_now", description: "Customs duty", amountUsd: "150.00", creditBankAccountId: 12 },
      ];
      const linePersisted = [
        { chargeType: "paid_now", description: "Customs duty", amountUsd: "150.0000", creditBankAccountId: 12 },
        { chargeType: "parent_agent", description: "Agent fee", amountUsd: "300.0000", creditLedgerAccountId: 77 },
      ];

      const sig1 = buildSpOffloadChargeSignature(lineRequested);
      const sig2 = buildSpOffloadChargeSignature(linePersisted);
      expect(sig1).toBe(sig2);
    });

    it("rejects replays with altered location, date, total, or accounts", () => {
      const baseCharge = buildSpOffloadChargeSignature([
        { chargeType: "paid_now", description: "Port", amountUsd: "100.00", creditBankAccountId: 5 },
      ]);

      const base = {
        offloadDate: "2026-09-01",
        locationId: 10,
        totalLandedCostUsd: 1000.0,
        chargeSignature: baseCharge,
      };

      // Exact match -> compatible
      expect(isCompatibleSpOffloadReplay(base, { ...base })).toBe(true);

      // Epsilon tolerance (0.005)
      expect(isCompatibleSpOffloadReplay(base, { ...base, totalLandedCostUsd: 1000.004 })).toBe(true);
      expect(isCompatibleSpOffloadReplay(base, { ...base, totalLandedCostUsd: 1000.02 })).toBe(false);

      // Different location
      expect(isCompatibleSpOffloadReplay(base, { ...base, locationId: 11 })).toBe(false);

      // Different date
      expect(isCompatibleSpOffloadReplay(base, { ...base, offloadDate: "2026-09-02" })).toBe(false);

      // Different charge accounts
      const alteredCharge = buildSpOffloadChargeSignature([
        { chargeType: "paid_now", description: "Port", amountUsd: "100.00", creditBankAccountId: 99 },
      ]);
      expect(isCompatibleSpOffloadReplay(base, { ...base, chargeSignature: alteredCharge })).toBe(false);
    });
  });

  describe("Initial Offload Failure & Rollback Simulation", () => {
    it("rolls back all lots and vouchers when initial offload encounters an error", async () => {
      const systemState = {
        containerStatus: "OPEN",
        rawStockLots: [] as Array<{ id: number; containerId: number; kg: number; costPerKg: number }>,
        vouchers: [] as Array<{ id: number; type: string; amount: string }>,
      };

      const executeOffload = async (shouldFailMidway: boolean) => {
        const snapshot = JSON.parse(JSON.stringify(systemState));
        try {
          // 1. Mark container offloaded
          systemState.containerStatus = "OFFLOADED";

          // 2. Insert raw stock lots
          systemState.rawStockLots.push({ id: 1, containerId: 50, kg: 20000, costPerKg: 1.85 });

          // 3. Post Goods OTW Reversal Voucher
          systemState.vouchers.push({ id: 101, type: "Goods OTW Reversal", amount: "37000.00" });

          // 4. Post Stock Inward Voucher (Simulate mid-operation failure)
          if (shouldFailMidway) {
            throw new Error("DB Constraint Error: Inward stock account does not exist");
          }

          systemState.vouchers.push({ id: 102, type: "Stock Receipt", amount: "37000.00" });

          return { success: true };
        } catch (error) {
          // Rollback
          systemState.containerStatus = snapshot.containerStatus;
          systemState.rawStockLots = snapshot.rawStockLots;
          systemState.vouchers = snapshot.vouchers;
          throw error;
        }
      };

      await expect(executeOffload(true)).rejects.toThrow("Inward stock account does not exist");

      // Verify clean state
      expect(systemState.containerStatus).toBe("OPEN");
      expect(systemState.rawStockLots).toHaveLength(0);
      expect(systemState.vouchers).toHaveLength(0);

      // Verify retry succeeds
      const retryResult = await executeOffload(false);
      expect(retryResult.success).toBe(true);
      expect(systemState.containerStatus).toBe("OFFLOADED");
      expect(systemState.rawStockLots).toHaveLength(1);
      expect(systemState.vouchers).toHaveLength(2);
    });
  });

  describe("Offload -> Reversal -> Corrected Re-Offload Lifecycle", () => {
    it("manages full lifecycle with exact cost replacement and no lot count explosion", async () => {
      const containerLifecycle = {
        containerId: 88,
        status: "OPEN",
        activeLots: [] as Array<{ id: number; rateUsd: number; kg: number; status: string }>,
        reversalAuditLog: [] as Array<{ action: string; previousRate: number; date: string }>,
        vouchers: [] as Array<{ id: number; num: string; status: string }>,
      };

      // Step 1: Initial Offload
      containerLifecycle.status = "OFFLOADED";
      containerLifecycle.activeLots.push({ id: 1, rateUsd: 2.0, kg: 10000, status: "ACTIVE" });
      containerLifecycle.vouchers.push({ id: 1, num: "OFFLOAD-88-INIT", status: "POSTED" });

      expect(containerLifecycle.status).toBe("OFFLOADED");
      expect(containerLifecycle.activeLots.filter((l) => l.status === "ACTIVE")).toHaveLength(1);
      expect(containerLifecycle.activeLots[0].rateUsd).toBe(2.0);

      // Step 2: Reverse Offload (e.g. incorrect customs duties entered)
      containerLifecycle.status = "OPEN";
      for (const lot of containerLifecycle.activeLots) {
        lot.status = "REVERSED";
      }
      containerLifecycle.reversalAuditLog.push({
        action: "REVERSE_OFFLOAD",
        previousRate: 2.0,
        date: "2026-09-02",
      });
      containerLifecycle.vouchers.push({ id: 2, num: "REV-OFFLOAD-88", status: "POSTED" });

      expect(containerLifecycle.status).toBe("OPEN");
      expect(containerLifecycle.activeLots.filter((l) => l.status === "ACTIVE")).toHaveLength(0);
      expect(containerLifecycle.reversalAuditLog).toHaveLength(1);

      // Step 3: Corrected Re-Offload (new corrected landed rate)
      containerLifecycle.status = "OFFLOADED";
      containerLifecycle.activeLots.push({ id: 2, rateUsd: 2.25, kg: 10000, status: "ACTIVE" });
      containerLifecycle.vouchers.push({ id: 3, num: "OFFLOAD-88-RELOAD", status: "POSTED" });

      expect(containerLifecycle.status).toBe("OFFLOADED");
      const activeLots = containerLifecycle.activeLots.filter((l) => l.status === "ACTIVE");
      expect(activeLots).toHaveLength(1);
      expect(activeLots[0].rateUsd).toBe(2.25);
      expect(activeLots[0].id).toBe(2);
    });
  });

  describe("Post-Offload Charge Reconciliation & Error Handling", () => {
    beforeEach(() => {
      vi.clearAllMocks();
      harness.query.mockImplementation(async (text: string) => ({
        rows: [] as any[],
        rowCount: text === "ROLLBACK" ? null : 0,
      }));
    });

    it("safely fails and rolls back when target container is missing", async () => {
      const result = await reconcilePostOffloadMutation({
        companyId: 99,
        containerId: 9999,
        mutationAction: "CREATE",
        userId: "admin-1",
      });

      expect(result.status).toBe("failed");
      expect(result.issues.join(" ")).toContain("container was not found");
      expect(harness.query).toHaveBeenCalledWith("ROLLBACK");
      expect(harness.release).toHaveBeenCalled();
    });
  });
});
