import Decimal from "decimal.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => {
  const tables = {
    factoryContainers: {
      name: "factoryContainers",
      id: "factoryContainers.id",
      companyId: "factoryContainers.companyId",
    },
    factoryOffloadAdditionalCharges: {
      name: "factoryOffloadAdditionalCharges",
      id: "factoryOffloadAdditionalCharges.id",
      companyId: "factoryOffloadAdditionalCharges.companyId",
      deletedAt: "factoryOffloadAdditionalCharges.deletedAt",
    },
    factorySuppliers: {
      name: "factorySuppliers",
      id: "factorySuppliers.id",
      companyId: "factorySuppliers.companyId",
      currentRawMaterialCostPerKgUsd: "factorySuppliers.currentRawMaterialCostPerKgUsd",
    },
    factoryDaybookEntries: { name: "factoryDaybookEntries", id: "factoryDaybookEntries.id" },
    vouchers: { name: "vouchers", id: "vouchers.id" },
    voucherEntries: { name: "voucherEntries", id: "voucherEntries.id", voucherId: "voucherEntries.voucherId" },
    accountingPostingRequests: {
      name: "accountingPostingRequests",
      companyId: "accountingPostingRequests.companyId",
      idempotencyKey: "accountingPostingRequests.idempotencyKey",
      sourceType: "accountingPostingRequests.sourceType",
      sourceId: "accountingPostingRequests.sourceId",
      requestFingerprint: "accountingPostingRequests.requestFingerprint",
      voucherId: "accountingPostingRequests.voucherId",
    },
    auditLog: { name: "auditLog", id: "auditLog.id" },
  };
  const selectResults: unknown[][] = [];
  const returningResults: unknown[][] = [];
  const insertedValues: Array<{ table: unknown; values: unknown }> = [];
  const updatedValues: Array<{ table: unknown; values: unknown }> = [];
  const deletedTables: unknown[] = [];

  const tx = {
    execute: vi.fn(async () => []),
    select: vi.fn(() => {
      const result = selectResults.shift() ?? [];
      const builder = {
        where: () => builder,
        for: async () => result,
        limit: async () => result,
        then: (resolve: (value: unknown[]) => unknown, reject: (reason: unknown) => unknown) =>
          Promise.resolve(result).then(resolve, reject),
      };
      return { from: () => builder };
    }),
    insert: vi.fn((table: unknown) => ({
      values: vi.fn((values: unknown) => {
        insertedValues.push({ table, values });
        const result = returningResults.shift() ?? [];
        return {
          returning: vi.fn(async () => result),
          then: (resolve: (value: undefined) => unknown) => Promise.resolve(undefined).then(resolve),
        };
      }),
    })),
    update: vi.fn((table: unknown) => ({
      set: vi.fn((values: unknown) => ({
        where: vi.fn(async () => {
          updatedValues.push({ table, values });
        }),
      })),
    })),
    delete: vi.fn((table: unknown) => ({
      where: vi.fn(async () => {
        deletedTables.push(table);
      }),
    })),
  };

  return {
    tables,
    tx,
    selectResults,
    returningResults,
    insertedValues,
    updatedValues,
    deletedTables,
    loadCostInputs: vi.fn(),
    loadActiveCharges: vi.fn(),
    computeRemainingFraction: vi.fn(),
    computeCorrectContainerCost: vi.fn(),
    getSupplierRateForUpdate: vi.fn(),
    getAuthoritativeSupplierRemainingKg: vi.fn(),
    cascadeContainerCostChange: vi.fn(),
    writeDaybookEntry: vi.fn(),
    assertNoLaterSupplierCostEvents: vi.fn(),
    resolveLegacyPostOffloadAccountingLinks: vi.fn(),
    updateContainerCost: vi.fn(),
    postFactoryVoucherTx: vi.fn(),
    retireVouchersTx: vi.fn(),
    editPostedFactoryVoucherTx: vi.fn(async (_tx: unknown, _input: unknown, edit: () => Promise<unknown>) => edit()),
  };
});

vi.mock("../shared/schema", () => harness.tables);
vi.mock("@shared/schema", () => harness.tables);
vi.mock("drizzle-orm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("drizzle-orm")>();
  return {
    ...actual,
    and: (...conditions: unknown[]) => conditions,
    eq: (column: unknown, value: unknown) => ({ column, value }),
    isNull: (column: unknown) => ({ column, value: null }),
  };
});
vi.mock("../server/services/factory/rawStockCostCascade", () => ({
  cascadeContainerCostChange: harness.cascadeContainerCostChange,
}));
vi.mock("../server/services/factory/raw-stock-recalc", () => ({
  computeCorrectContainerCost: harness.computeCorrectContainerCost,
}));
vi.mock("../server/services/factory/rawStockLockedRate", () => ({
  getAuthoritativeSupplierRemainingKg: harness.getAuthoritativeSupplierRemainingKg,
}));
vi.mock("../server/routes/factory/_helpers", () => ({ writeDaybookEntry: harness.writeDaybookEntry }));
vi.mock("../server/services/factory/post-offload-charge/legacy-links", () => ({
  assertNoLaterSupplierCostEvents: harness.assertNoLaterSupplierCostEvents,
  getSupplierRateForUpdate: harness.getSupplierRateForUpdate,
  resolveLegacyPostOffloadAccountingLinks: harness.resolveLegacyPostOffloadAccountingLinks,
  updateContainerCost: harness.updateContainerCost,
}));
vi.mock("../server/services/factory/post-offload-charge/loaders", () => ({
  computeRemainingFraction: harness.computeRemainingFraction,
  loadActiveCharges: harness.loadActiveCharges,
  loadCostInputs: harness.loadCostInputs,
}));

// Phase 22 (C): the charge voucher is posted through the engine (postFactoryVoucherTx),
// an in-place edit runs inside editPostedFactoryVoucherTx (audited; 409 when the
// period is closed) and a reversed charge's voucher is retired.
vi.mock("../server/services/factory/factoryVoucherPosting", () => ({
  postFactoryVoucherTx: harness.postFactoryVoucherTx,
}));
vi.mock("../server/services/factory/factoryVoucherCorrection", () => ({
  editPostedFactoryVoucherTx: harness.editPostedFactoryVoucherTx,
}));
vi.mock("../server/services/accounting/voucherRetirement", () => ({
  retireVouchersTx: harness.retireVouchersTx,
}));

import { applyPostOffloadChargeMutation } from "../server/services/factory/post-offload-charge/apply";

const container = {
  id: 9,
  companyId: 4,
  containerNumber: "CNT-9",
  supplierId: 77,
  ratePerKgUsd: "10",
};
const oldCost = { totalUsd: 1000, costPerKg: 10, costPerKgUsd: 10, fxUnresolved: false };
const newCost = { totalUsd: 1120, costPerKg: 11.2, costPerKgUsd: 11.2, fxUnresolved: false };
const chargeData = {
  description: "Port handling",
  amount: 60,
  currencyCode: "EUR",
  fxRateToUsd: 2,
  fxRateConfirmed: true,
  fxRateDate: "2026-08-11",
  ledgerAccountId: 55,
  supplierId: null,
};

describe("post-offload charge mutation positive paths", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    harness.selectResults.splice(0);
    harness.returningResults.splice(0);
    harness.insertedValues.splice(0);
    harness.updatedValues.splice(0);
    harness.deletedTables.splice(0);
    harness.loadCostInputs.mockResolvedValue({ commissionRecord: null, otherChargeRows: [] });
    harness.computeRemainingFraction.mockResolvedValue({
      dReceivedKg: new Decimal(100),
      dRemainingKg: new Decimal(40),
      dFraction: new Decimal("0.4"),
    });
    harness.getSupplierRateForUpdate.mockResolvedValue("5.00000000");
    harness.getAuthoritativeSupplierRemainingKg.mockResolvedValue(200);
    harness.cascadeContainerCostChange.mockResolvedValue({ updatedRawStockRows: 2 });
    harness.writeDaybookEntry.mockResolvedValue({ id: 301 });
    harness.postFactoryVoucherTx.mockResolvedValue({ voucher: { id: 51 }, entries: [], replayed: false });
    harness.resolveLegacyPostOffloadAccountingLinks.mockImplementation(
      async (_tx: unknown, _companyId: number, _containerId: number, charge: unknown) => charge
    );
  });

  it("creates a charge, cascades its exact remaining-stock value, and links balanced accounting/daybook evidence", async () => {
    harness.selectResults.push([container], [{ rate: "5.24000000" }]);
    harness.loadActiveCharges.mockResolvedValue([]);
    harness.computeCorrectContainerCost.mockReturnValueOnce(oldCost).mockReturnValueOnce(newCost);
    harness.returningResults.push([{ id: 41, ...chargeData }]);

    const result = await applyPostOffloadChargeMutation(harness.tx, {
      action: "CREATE",
      companyId: 4,
      containerId: 9,
      txDate: "2026-08-11",
      userId: "user-7",
      chargeData,
      accountingCtx: { voucherCompanyId: 4, chargesPayableAcctId: 88 },
    } as never);

    expect(result).toMatchObject({
      chargeId: 41,
      action: "CREATE",
      oldContainerCostPerKgUsd: 10,
      newContainerCostPerKgUsd: 11.2,
      supplierLockedRateBefore: "5.00000000",
      supplierLockedRateAfter: "5.24000000",
      supplierRemainingKg: 200,
      remainingFraction: "0.40000000",
      fullContainerValueDeltaUsd: "120.000000",
      supplierInventoryValueDeltaUsd: "48.000000",
    });
    expect(harness.cascadeContainerCostChange).toHaveBeenCalledWith(
      harness.tx,
      expect.objectContaining({ supplierInventoryValueDeltaUsdOverride: expect.objectContaining({}) }),
      { includeCompletedBatches: true }
    );
    expect(harness.writeDaybookEntry).toHaveBeenCalledWith(
      harness.tx,
      expect.objectContaining({
        txType: "OTHER_CHARGE",
        referenceId: 9,
        amountCurrency: 60,
      })
    );
    expect(harness.postFactoryVoucherTx).toHaveBeenCalledWith(
      harness.tx,
      expect.objectContaining({
        companyId: 4,
        currency: "EUR",
        fxRateToUsd: "2",
        source: { sourceType: "factory-post-offload-charge", sourceId: "4:9:41", phase: "voucher" },
        lines: [
          expect.objectContaining({ ledgerAccountId: 88, debit: "60" }),
          expect.objectContaining({ ledgerAccountId: 55, credit: "60" }),
        ],
      })
    );
    const numberOf = harness.postFactoryVoucherTx.mock.calls[0][1].voucherNumber as (generation: number) => string;
    expect(numberOf(1)).toBe("FACTORY-POC-9-41-1");
    expect(harness.updatedValues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          table: harness.tables.factoryOffloadAdditionalCharges,
          values: expect.objectContaining({ daybookEntryId: 301, voucherId: 51 }),
        }),
      ])
    );
  });

  it("edits a linked charge in place and recreates its exact voucher entries", async () => {
    const existing = {
      id: 41,
      version: 2,
      createdAt: "2026-08-01",
      supplierLockedRateBefore: "4.9",
      daybookEntryId: 301,
      voucherId: 51,
    };
    harness.selectResults.push([container], [existing], [{ rate: "5.08000000" }], [{ companyId: 4 }]);
    harness.loadActiveCharges
      .mockResolvedValueOnce([{ id: 41, amount: "50" }])
      .mockResolvedValueOnce([{ id: 41, amount: "60" }]);
    harness.computeCorrectContainerCost.mockReturnValueOnce(oldCost).mockReturnValueOnce(newCost);

    const result = await applyPostOffloadChargeMutation(harness.tx, {
      action: "EDIT",
      companyId: 4,
      containerId: 9,
      chargeId: 41,
      expectedVersion: 2,
      txDate: "2026-08-11",
      userId: "user-7",
      chargeData,
      accountingCtx: { voucherCompanyId: 4, chargesPayableAcctId: 88 },
    } as never);

    expect(result).toMatchObject({ action: "EDIT", chargeId: 41, fullContainerValueDeltaUsd: "120.000000" });
    expect(harness.deletedTables).toContain(harness.tables.voucherEntries);
    expect(harness.updatedValues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ table: harness.tables.factoryDaybookEntries }),
        expect.objectContaining({ table: harness.tables.vouchers }),
      ])
    );
    expect(harness.editPostedFactoryVoucherTx).toHaveBeenCalledWith(
      harness.tx,
      expect.objectContaining({ companyId: 4, voucherIds: [51], newVoucherDate: "2026-08-11" }),
      expect.any(Function)
    );
    const rebuilt = harness.insertedValues.filter(({ table }) => table === harness.tables.voucherEntries);
    expect(rebuilt).toHaveLength(1);
    expect(rebuilt[0].values).toHaveLength(2);
  });

  it("repairs missing daybook/accounting links during an edit and credits the selected supplier", async () => {
    const existing = {
      id: 41,
      version: 1,
      createdAt: "2026-08-01",
      supplierLockedRateBefore: "4.9",
      daybookEntryId: null,
      voucherId: null,
    };
    const supplierCharge = { ...chargeData, ledgerAccountId: null, supplierId: 66 };
    harness.selectResults.push([container], [existing], [{ rate: "5.08000000" }]);
    harness.loadActiveCharges
      .mockResolvedValueOnce([{ id: 41, amount: "50" }])
      .mockResolvedValueOnce([{ id: 41, amount: "60" }]);
    harness.computeCorrectContainerCost.mockReturnValueOnce(oldCost).mockReturnValueOnce(newCost);
    harness.postFactoryVoucherTx.mockResolvedValue({ voucher: { id: 52 }, entries: [], replayed: false });
    harness.writeDaybookEntry.mockResolvedValue({ id: 303 });

    const result = await applyPostOffloadChargeMutation(harness.tx, {
      action: "EDIT",
      companyId: 4,
      containerId: 9,
      chargeId: 41,
      expectedVersion: 1,
      txDate: "2026-08-11",
      userId: "user-7",
      chargeData: supplierCharge,
      accountingCtx: { voucherCompanyId: 4, chargesPayableAcctId: 88 },
    } as never);

    expect(result).toMatchObject({ action: "EDIT", chargeId: 41 });
    expect(harness.writeDaybookEntry).toHaveBeenCalledWith(
      harness.tx,
      expect.objectContaining({
        referenceId: 9,
        amountCurrency: 60,
      })
    );
    expect(harness.postFactoryVoucherTx).toHaveBeenCalledWith(
      harness.tx,
      expect.objectContaining({
        currency: "EUR",
        source: { sourceType: "factory-post-offload-charge", sourceId: "4:9:41", phase: "voucher" },
        lines: [
          expect.objectContaining({ ledgerAccountId: 88, debit: "60" }),
          expect.objectContaining({ factorySupplierId: 66, credit: "60" }),
        ],
      })
    );
    expect(harness.updatedValues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          table: harness.tables.factoryOffloadAdditionalCharges,
          values: expect.objectContaining({ daybookEntryId: 303, voucherId: 52 }),
        }),
      ])
    );
  });

  it("undoes a charge once with a negative cost cascade, voucher tombstone, and exact reversing daybook entry", async () => {
    const existing = {
      id: 41,
      version: 3,
      createdAt: "2026-08-01",
      deletedAt: null,
      description: "Port handling",
      supplierLockedRateBefore: "4.9",
      voucherId: 51,
      daybookEntryId: 301,
      reversalDaybookEntryId: null,
    };
    harness.selectResults.push(
      [container],
      [existing],
      [{ rate: "4.76000000" }],
      [{ companyId: 4 }],
      [{ currencyCode: "EUR", amountCurrency: "60", fxRateToUsd: "2", amountUsd: "120" }]
    );
    harness.loadActiveCharges.mockResolvedValue([{ id: 41, amount: "60" }]);
    harness.computeCorrectContainerCost.mockReturnValueOnce(newCost).mockReturnValueOnce(oldCost);
    harness.writeDaybookEntry.mockResolvedValue({ id: 302 });

    const result = await applyPostOffloadChargeMutation(harness.tx, {
      action: "UNDO",
      companyId: 4,
      containerId: 9,
      chargeId: 41,
      expectedVersion: 3,
      txDate: "2026-08-11",
      userId: "user-7",
    } as never);

    expect(result).toMatchObject({
      action: "UNDO",
      chargeId: 41,
      fullContainerValueDeltaUsd: "-120.000000",
      supplierInventoryValueDeltaUsd: "-48.000000",
      reversalDaybookEntryId: 302,
    });
    // The voucher is retired (audited, number and identity released), not tombstoned in place.
    expect(harness.retireVouchersTx).toHaveBeenCalledWith(
      harness.tx,
      expect.objectContaining({ companyId: 4, voucherIds: [51], reason: "post-offload-charge-reversed" })
    );
    expect(harness.writeDaybookEntry).toHaveBeenCalledWith(
      harness.tx,
      expect.objectContaining({
        description: expect.stringContaining("REVERSAL"),
        amountCurrency: -60,
        amountUsd: -120,
      })
    );
    expect(harness.updatedValues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          table: harness.tables.factoryOffloadAdditionalCharges,
          values: expect.objectContaining({ reversalDaybookEntryId: 302 }),
        }),
      ])
    );
  });

  it("rebuilds a legacy supplier-rate snapshot without changing canonical container costs", async () => {
    const legacyCharge = {
      id: 41,
      amount: "60",
      fxRateToUsd: "2",
      version: 1,
      createdAt: "2026-08-01",
      supplierLockedRateBefore: null,
    };
    harness.selectResults.push([container], [legacyCharge]);

    const result = await applyPostOffloadChargeMutation(harness.tx, {
      action: "LEGACY_REBUILD",
      companyId: 4,
      containerId: 9,
      chargeId: 41,
      expectedVersion: 1,
      legacyBaselineRate: "4.5",
      txDate: "2026-08-11",
      userId: "user-7",
    } as never);

    expect(result).toMatchObject({
      action: "LEGACY_REBUILD",
      supplierLockedRateAfter: "4.74000000",
      fullContainerValueDeltaUsd: "120.000000",
      supplierInventoryValueDeltaUsd: "48.000000",
      cascadeResult: null,
    });
    expect(harness.assertNoLaterSupplierCostEvents).toHaveBeenCalledOnce();
    expect(harness.updatedValues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ table: harness.tables.factorySuppliers }),
        expect.objectContaining({
          table: harness.tables.factoryOffloadAdditionalCharges,
          values: expect.objectContaining({ supplierLockedRateBefore: "4.5", supplierLockedRateAfter: "4.74000000" }),
        }),
      ])
    );
  });

  it("returns the persisted reversal for an already-undone retry without cascading again", async () => {
    harness.selectResults.push([container], [{ id: 41, deletedAt: new Date(), reversalDaybookEntryId: 302 }]);

    const result = await applyPostOffloadChargeMutation(harness.tx, {
      action: "UNDO",
      companyId: 4,
      containerId: 9,
      chargeId: 41,
      txDate: "2026-08-11",
      userId: "user-7",
    } as never);

    expect(result).toMatchObject({ action: "UNDO", alreadyUndone: true, reversalDaybookEntryId: 302 });
    expect(harness.cascadeContainerCostChange).not.toHaveBeenCalled();
  });
});
