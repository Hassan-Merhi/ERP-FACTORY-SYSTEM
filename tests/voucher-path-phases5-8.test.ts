import { afterEach, describe, expect, it, vi } from "vitest";

import {
  attachPhase5VoucherRequestIdentity,
  markPhase5VoucherRequestOutcomeUncertain,
  releasePhase5VoucherRequestIdentity,
  shouldReleasePhase5VoucherRequestIdentity,
} from "../client/src/lib/phase5VoucherRequestIdentity";
import voucherReview from "../config/voucher-write-evidence-review.json";
import {
  auditWriteEvidence,
  PHASE5_OPERATIONAL_REQUEST_BOUNDARY_WRITERS,
  PHASE6_SPECIAL_PURPOSE_COMPLETED_WRITERS,
} from "../scripts/audit-write-evidence.mjs";
import {
  PHASE6_DETERMINISTIC_SPECIAL_PATHS,
  PHASE6_INTRINSIC_REPLAY_SAFE_WRITERS,
  isPhase5OperationalVoucherRequest,
  isPhase6DeterministicSpecialRequest,
} from "../shared/voucherPathIdentityPolicy";
import {
  deterministicPhase6RequestIdentity,
  resolveVoucherPathCompanyId,
} from "../server/services/accounting/voucherPathPhase5to6Boundary";

const PHASE5_WRITERS = [
  "server/routes/containers/offload/create.ts",
  "server/routes/creditNoteRoutes.ts",
  "server/routes/factory/containers/create.ts",
  "server/routes/factory/containers/delete.ts",
  "server/routes/factory/containers/other-charges.ts",
  "server/routes/factory/containers/update.ts",
  "server/routes/factory/customer-orders/orderChargesRoutes.ts",
  "server/routes/factory/factoryTransporterRoutes.ts",
  "server/routes/factory/raw-stock/rawStockAdjRoutes.ts",
  "server/routes/factory/raw-stock/rawStockOffloadRoutes.ts",
  "server/routes/factory/raw-stock/rawStockReverseOffloadRoute.ts",
  "server/routes/payroll/worker-stats-advances/advanceAdminRoutes.ts",
  "server/routes/payroll/worker-stats-advances/advancesRoutes.ts",
  "server/routes/rental/shared/accrual.ts",
  "server/routes/rental/shared/auto-transfer.ts",
  "server/routes/rental/units-contracts/contract-end.ts",
  "server/routes/rental/units-contracts/guarantees.ts",
  "server/routes/sp/spLifecycleRoutes.ts",
  "server/routes/sp/spOffloadLifecycleRoutes.ts",
  "server/routes/sp/spOffloadRoutes.ts",
  "server/routes/sp/spOpeningStockRoutes.ts",
  "server/routes/sp/spSalesRoutes.ts",
] as const;

const PHASE6_DETERMINISTIC_WRITERS = [
  "server/routes/admin/adminPoFixRoutes.ts",
  "server/routes/creditSalesImportRoutes.ts",
  "server/routes/exchangeRateRoutes.ts",
  "server/routes/posImportRoutes.ts",
  "server/routes/sp-migration/spMigrationSetupRoutes.ts",
  "server/routes/stockTransferImportRoutes.ts",
] as const;

const PHASE6_INTRINSIC_WRITERS = [
  "server/routes/erp-payroll/runs-migration.ts",
  "server/routes/factory/docs-users/companyImportRoutes.ts",
  "server/routes/payroll/worker-statement/backfill.ts",
  "server/routes/rental/rentalAccrualConfigRoutes.ts",
] as const;

const PHASE5_REPRESENTATIVE_ROUTES = [
  ["POST", "/api/containers/42/offload"],
  ["POST", "/api/credit-notes"],
  ["POST", "/api/factory/containers"],
  ["PATCH", "/api/factory/containers/42"],
  ["DELETE", "/api/factory/containers/42"],
  ["POST", "/api/factory/containers/42/other-charges/sync"],
  ["POST", "/api/factory/containers/42/reverse-offload"],
  ["POST", "/api/factory/customer-orders/42/charges"],
  ["POST", "/api/factory/transporters/42/charges"],
  ["POST", "/api/factory/transporters/42/payments"],
  ["POST", "/api/factory/raw-stock/offload"],
  ["POST", "/api/factory/advances/bulk"],
  ["POST", "/api/factory/workers/42/advances"],
  ["POST", "/api/erp/rental/contracts/42/end"],
  ["PATCH", "/api/properties/rental/contracts/42"],
  ["POST", "/api/factory/rental/re-accrue"],
  ["POST", "/api/sp/sales"],
  ["PATCH", "/api/sp/offloads/42"],
] as const;

const originalLocalStorageDescriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");

afterEach(() => {
  vi.restoreAllMocks();
  if (originalLocalStorageDescriptor) {
    Object.defineProperty(globalThis, "localStorage", originalLocalStorageDescriptor);
  } else {
    Reflect.deleteProperty(globalThis, "localStorage");
  }
});

function installMemoryStorage(): Map<string, string> {
  const values = new Map<string, string>();
  const localStorage = {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key: string) => values.get(key) ?? null,
    key: (index: number) => [...values.keys()][index] ?? null,
    removeItem: (key: string) => values.delete(key),
    setItem: (key: string, value: string) => values.set(key, value),
  } as Storage;
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: localStorage });
  return values;
}

describe("Voucher path review phases 5-8", () => {
  it("closes the remaining 22 operational writers exactly", () => {
    expect(voucherReview.summary.operationalWithoutRequestIdentity).toBe(0);
    expect(voucherReview.summary.phase5OperationalCompleted).toBe(22);
    expect(voucherReview.completed["phase-5-operational-writers"].files).toEqual(PHASE5_WRITERS);
    expect([...PHASE5_OPERATIONAL_REQUEST_BOUNDARY_WRITERS]).toEqual(PHASE5_WRITERS);
  });

  it("classifies all 11 special-purpose writers as deterministic or intrinsically replay-safe", () => {
    expect(voucherReview.summary.migrationImportRepair).toBe(0);
    expect(voucherReview.summary.phase6SpecialPurposeCompleted).toBe(10);
    expect(voucherReview.completed["phase-6-deterministic-source-writers"].files).toEqual(PHASE6_DETERMINISTIC_WRITERS);
    expect(voucherReview.completed["phase-6-intrinsic-replay-safe-writers"].files).toEqual(PHASE6_INTRINSIC_WRITERS);
    expect(PHASE6_INTRINSIC_REPLAY_SAFE_WRITERS).toEqual(PHASE6_INTRINSIC_WRITERS);
    expect([...PHASE6_SPECIAL_PURPOSE_COMPLETED_WRITERS].sort()).toEqual(
      [...PHASE6_DETERMINISTIC_WRITERS, ...PHASE6_INTRINSIC_WRITERS].sort()
    );
  });

  it("protects representative operations from every Phase 5 family", () => {
    for (const [method, pathname] of PHASE5_REPRESENTATIVE_ROUTES) {
      expect(isPhase5OperationalVoucherRequest(method, pathname), `${method} ${pathname}`).toBe(true);
    }
    expect(isPhase5OperationalVoucherRequest("GET", "/api/sp/sales")).toBe(false);
    expect(isPhase5OperationalVoucherRequest("POST", "/api/sp/migration/opening-balance")).toBe(false);
    expect(isPhase5OperationalVoucherRequest("POST", "/api/factory/advances/cash-adjustment")).toBe(false);
  });

  it("reuses one Phase 5 identity for double-click/concurrent replay and allows a new identical business request after success", () => {
    installMemoryStorage();
    const payload = { amount: "125.00", accountId: 9 };
    const first = attachPhase5VoucherRequestIdentity("POST", "/api/credit-notes", payload) as {
      clientRequestId: string;
    };
    const simultaneous = attachPhase5VoucherRequestIdentity("POST", "/api/credit-notes", payload) as {
      clientRequestId: string;
    };
    expect(simultaneous.clientRequestId).toBe(first.clientRequestId);

    releasePhase5VoucherRequestIdentity("POST", "/api/credit-notes", first, true);
    const distinctRequest = attachPhase5VoucherRequestIdentity("POST", "/api/credit-notes", payload) as {
      clientRequestId: string;
    };
    expect(distinctRequest.clientRequestId).not.toBe(first.clientRequestId);
    releasePhase5VoucherRequestIdentity("POST", "/api/credit-notes", distinctRequest, true);
  });

  it("retains Phase 5 identity across lost/uncertain responses", () => {
    installMemoryStorage();
    const payload = { receivedKg: "500", containerId: 42 };
    const first = attachPhase5VoucherRequestIdentity("POST", "/api/factory/raw-stock/offload", payload) as {
      clientRequestId: string;
    };
    markPhase5VoucherRequestOutcomeUncertain("POST", "/api/factory/raw-stock/offload", first);
    releasePhase5VoucherRequestIdentity("POST", "/api/factory/raw-stock/offload", first);

    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 24 * 60 * 60 * 1000);
    const retry = attachPhase5VoucherRequestIdentity("POST", "/api/factory/raw-stock/offload", payload) as {
      clientRequestId: string;
    };
    expect(retry.clientRequestId).toBe(first.clientRequestId);
    expect(shouldReleasePhase5VoucherRequestIdentity(409, "ACCOUNTING_REQUEST_OUTCOME_UNCERTAIN")).toBe(false);
    expect(shouldReleasePhase5VoucherRequestIdentity(500)).toBe(false);
    releasePhase5VoucherRequestIdentity("POST", "/api/factory/raw-stock/offload", retry, true);
  });

  it("derives restart-stable deterministic Phase 6 source identities", () => {
    for (const pathname of Object.keys(PHASE6_DETERMINISTIC_SPECIAL_PATHS)) {
      expect(isPhase6DeterministicSpecialRequest("POST", pathname), pathname).toBe(true);
    }

    const first = deterministicPhase6RequestIdentity("POST", "/api/pos-import/import", 7, {
      saleDate: "2026-08-17",
      locationId: 3,
      items: [{ barcode: "A1", quantity: 2, rate: 10 }],
    });
    const reordered = deterministicPhase6RequestIdentity("POST", "/api/pos-import/import", 7, {
      items: [{ rate: 10, quantity: 2, barcode: "A1" }],
      locationId: 3,
      saleDate: "2026-08-17",
    });
    const otherCompany = deterministicPhase6RequestIdentity("POST", "/api/pos-import/import", 8, {
      saleDate: "2026-08-17",
      locationId: 3,
      items: [{ barcode: "A1", quantity: 2, rate: 10 }],
    });

    expect(first).toBe(reordered);
    expect(otherCompany).not.toBe(first);
    expect(first).toMatch(/^import:pos-sales:7:/);
  });

  it("lets an explicit import/repair run id distinguish intentional later runs while keeping reruns stable", () => {
    const a1 = deterministicPhase6RequestIdentity("POST", "/api/stock-transfer-import/import", 4, {
      sourceRunId: "batch-2026-08-17-a",
      items: [{ barcode: "X", quantity: 1 }],
    });
    const a2 = deterministicPhase6RequestIdentity("POST", "/api/stock-transfer-import/import", 4, {
      items: [{ quantity: 999, barcode: "DIFFERENT" }],
      sourceRunId: "batch-2026-08-17-a",
    });
    const b = deterministicPhase6RequestIdentity("POST", "/api/stock-transfer-import/import", 4, {
      sourceRunId: "batch-2026-08-17-b",
      items: [{ barcode: "X", quantity: 1 }],
    });

    expect(a1).toBe(a2);
    expect(a1).not.toBe(b);
    expect(a1).toBe("import:stock-transfer:4:batch-2026-08-17-a");
  });

  it("simulates rerunning the same deterministic import without increasing voucher count", () => {
    const completed = new Set<string>();
    let voucherCount = 0;
    const execute = (key: string | null) => {
      if (!key) throw new Error("missing deterministic source key");
      if (completed.has(key)) return;
      voucherCount += 1;
      completed.add(key);
    };

    const key = deterministicPhase6RequestIdentity("POST", "/api/credit-sales-import/import", 12, {
      importBatchId: "credit-sales-001",
      customerId: 88,
      items: [{ barcode: "SKU-1", quantity: 3, rate: 5 }],
    });
    execute(key);
    execute(key);
    expect(voucherCount).toBe(1);
  });

  it("scopes target-company identity from authenticated server-owned context", () => {
    const factoryReq = {
      path: "/api/factory/raw-stock/offload",
      session: { userId: 1, currentCompanyId: 2, factoryCompanyId: 3 },
      body: {},
    } as unknown as Parameters<typeof resolveVoucherPathCompanyId>[0];
    const spMigrationReq = {
      path: "/api/sp/migration/opening-balance",
      session: { userId: 1, currentCompanyId: 2 },
      body: { targetCompanyId: 9 },
    } as unknown as Parameters<typeof resolveVoucherPathCompanyId>[0];

    expect(resolveVoucherPathCompanyId(factoryReq)).toBe(3);
    expect(resolveVoucherPathCompanyId(spMigrationReq)).toBe(9);
  });

  it("closes the final write-evidence targets and rejects unreviewed direct creators", () => {
    const audit = auditWriteEvidence();
    expect(voucherReview.summary.initialReviewed).toBe(81);
    expect(voucherReview.summary.unreviewed).toBe(0);
    expect(voucherReview.summary.operationalWithoutRequestIdentity).toBe(0);
    expect(voucherReview.summary.migrationImportRepair).toBe(0);
    expect(audit.unapprovedDirectVoucherCreation).toEqual([]);
    expect(audit.voucherWritesWithoutRequestIdentity.sort()).toEqual(
      [...voucherReview.reviewed["explicit-replay-guard"].files].sort()
    );
  });
});
