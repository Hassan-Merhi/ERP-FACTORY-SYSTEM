import Decimal from "decimal.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  factoryContainerCommissions,
  factoryContainerOtherCharges,
  factoryContainers,
  factoryOffloadAdditionalCharges,
  factoryRawStock,
  factorySuppliers,
} from "@shared/schema";

type Row = Record<string, unknown>;

const deps = vi.hoisted(() => ({
  tables: new Map<unknown, unknown[]>(),
  scopeRows: [] as unknown[],
  scopeParams: [] as unknown[],
  clientQueries: [] as string[],
  released: 0,
  replay: vi.fn(),
  fx: vi.fn(),
  remainingKg: vi.fn(),
  lockedRate: vi.fn(),
  cost: vi.fn(),
}));

vi.mock("../server/db", async (importOriginal) => {
  const select = () => ({
    from: (table: unknown) => {
      const chain = {
        where: () => chain,
        orderBy: () => chain,
        then: (resolve: (rows: unknown[]) => unknown, reject: (e: unknown) => unknown) =>
          Promise.resolve(deps.tables.get(table) ?? []).then(resolve, reject),
      };
      return chain;
    },
  });
  return {
    ...(await importOriginal<typeof import("../server/db")>()),
    db: { select },
    pool: {
      query: async (_sql: string, params: unknown[]) => {
        deps.scopeParams.push(params);
        return { rows: deps.scopeRows };
      },
      connect: async () => ({
        query: async (sql: string) => {
          deps.clientQueries.push(sql);
          return { rows: [] };
        },
        release: () => {
          deps.released += 1;
        },
      }),
    },
  };
});
vi.mock("../server/services/factory/historicalCostReplay", () => ({
  previewHistoricalCostReplayWithExecutor: (...args: unknown[]) => deps.replay(...args),
}));
vi.mock("../server/services/factory/factoryFxRateReadOnly", () => ({
  getFxRateToUsdReadOnly: (...args: unknown[]) => deps.fx(...args),
}));
vi.mock("../server/services/factory/rawStockLockedRate", () => ({
  getAuthoritativeSupplierRemainingKg: (...args: unknown[]) => deps.remainingKg(...args),
  getLockedSupplierRateReadOnly: (...args: unknown[]) => deps.lockedRate(...args),
}));
vi.mock("../server/services/factory/raw-stock-recalc", () => ({
  computeCorrectContainerCost: (...args: unknown[]) => deps.cost(...args),
}));

import {
  InvalidPostOffloadImpactPreviewError,
  StalePostOffloadImpactPreviewError,
  computePostOffloadImpactRequestFingerprint,
  normalizePostOffloadImpactCharges,
  preparePostOffloadImpactPreview,
  verifyPostOffloadImpactPreview,
} from "../server/services/factory/postOffloadImpactPreview";
import { REPAIR_TOKEN_TTL_MS, signRepairToken } from "../server/services/factory/repairToken";

const BASE_TOTAL_USD = 10_000;
const KG = 20_000;

function container(over: Row = {}): Row {
  return {
    id: 11,
    companyId: 3,
    containerNumber: "MSKU1234567",
    status: "OFFLOADED",
    supplierId: 5,
    currencyCode: "EUR",
    fxRateToUsd: "1.10",
    fxRateToUsdOffload: "1.20",
    fxRateConfirmed: true,
    fxRateDateOffload: "2026-09-30",
    deletedAt: null,
    ...over,
  };
}

function seed(over: { container?: Row | null; rawStock?: Row[]; charges?: Row[]; supplier?: Row[] } = {}) {
  deps.tables.clear();
  deps.tables.set(factoryContainers, over.container === null ? [] : [container(over.container)]);
  deps.tables.set(
    factoryOffloadAdditionalCharges,
    over.charges ?? [
      { id: 2, amount: "50" },
      { id: 1, amount: "25" },
    ]
  );
  deps.tables.set(factoryContainerCommissions, [{ id: 9 }, { id: 4 }]);
  deps.tables.set(factoryContainerOtherCharges, [{ id: 7 }]);
  deps.tables.set(
    factoryRawStock,
    over.rawStock ?? [
      { id: 1, receivedKg: "12000", usedKg: "3000" },
      { id: 2, receivedKg: "8000", usedKg: "7000" },
    ]
  );
  deps.tables.set(factorySuppliers, over.supplier ?? [{ id: 5, rate: "0.5", updatedAt: null }]);
}

const usdCharge = { description: " Port storage ", amount: "100", currencyCode: "usd" };
const baseInput = {
  companyId: 3,
  userId: "u-1",
  containerId: 11,
  transactionDate: "2026-10-01",
  charges: [usdCharge],
};

beforeEach(() => {
  seed();
  deps.scopeRows = [
    {
      supplier_owned_sources: "4",
      affected_source_rows: "9",
      affected_batches: "3",
      open_batches: "1",
      completed_batches: "2",
      available_bales: "15",
      finalized_bales_excluded: "6",
    },
  ];
  deps.scopeParams = [];
  deps.clientQueries = [];
  deps.released = 0;
  deps.replay.mockReset().mockResolvedValue({
    supplierRows: [{ supplierId: 5, safeToRepair: true, reasons: [] }],
    financialImpact: { allSafetyGatesPassed: true },
  });
  deps.fx.mockReset().mockResolvedValue("0.00075");
  deps.remainingKg.mockReset().mockResolvedValue(4000);
  deps.lockedRate.mockReset().mockResolvedValue({ rate: new Decimal("0.5") });
  // Sum the extra charges in USD on top of a fixed base cost so the projected
  // totals reveal which synthetic rows and FX rates the preview produced.
  deps.cost.mockReset().mockImplementation((_c: Row, charges: Row[]) => {
    const extra = charges
      .filter((charge) => Number(charge.id) < 0)
      .reduce(
        (sum, charge) => sum.plus(new Decimal(String(charge.amount)).times(String(charge.fxRateToUsd))),
        new Decimal(0)
      );
    const totalUsd = new Decimal(BASE_TOTAL_USD).plus(extra).toNumber();
    return { costPerKg: 0, costPerKgUsd: totalUsd / KG, totalCost: totalUsd, totalUsd, fxUnresolved: false };
  });
});

describe("normalizePostOffloadImpactCharges", () => {
  it("requires at least one charge", () => {
    expect(() => normalizePostOffloadImpactCharges([])).toThrow("At least one post-offload charge is required.");
    expect(() => normalizePostOffloadImpactCharges("x")).toThrow(InvalidPostOffloadImpactPreviewError);
  });

  it("rejects bad amounts and currency codes with the charge position", () => {
    expect(() => normalizePostOffloadImpactCharges([{ amount: "1" }, { amount: "abc" }])).toThrow(
      "Charge 2 has an invalid amount."
    );
    expect(() => normalizePostOffloadImpactCharges([{ amount: "0" }])).toThrow(
      "Charge 1 amount must be greater than zero."
    );
    expect(() => normalizePostOffloadImpactCharges([{ amount: "-3" }])).toThrow("greater than zero");
    expect(() => normalizePostOffloadImpactCharges([{ amount: "Infinity" }])).toThrow("greater than zero");
    expect(() => normalizePostOffloadImpactCharges([null])).toThrow("Charge 1 amount must be greater than zero.");
    expect(() => normalizePostOffloadImpactCharges([{ amount: "5", currencyCode: "US" }])).toThrow(
      "Charge 1 has an invalid currency code."
    );
    expect(() => normalizePostOffloadImpactCharges([{ amount: "5", currencyCode: "U$D" }])).toThrow(
      "invalid currency code"
    );
  });

  it("normalises descriptions, amounts, currencies and ids", () => {
    expect(
      normalizePostOffloadImpactCharges([
        { amount: 12.5, currencyCode: " eur ", description: "  ", ledgerAccountId: "7", supplierId: 0 },
        { amount: "3", ledgerAccountId: "", supplierId: "12abc" },
        { amount: "1", description: "Crane", ledgerAccountId: -4, supplierId: null },
      ])
    ).toEqual([
      {
        description: "Post-offload charge",
        amount: "12.500000",
        currencyCode: "EUR",
        ledgerAccountId: 7,
        supplierId: null,
      },
      {
        description: "Post-offload charge",
        amount: "3.000000",
        currencyCode: "USD",
        ledgerAccountId: null,
        supplierId: 12,
      },
      { description: "Crane", amount: "1.000000", currencyCode: "USD", ledgerAccountId: null, supplierId: null },
    ]);
  });

  it("fingerprints the normalised request so cosmetic differences match", () => {
    const a = computePostOffloadImpactRequestFingerprint({
      containerId: 11,
      transactionDate: " 2026-10-01 ",
      charges: [{ amount: "100", currencyCode: "usd" }],
    });
    const b = computePostOffloadImpactRequestFingerprint({
      containerId: 11,
      transactionDate: "2026-10-01",
      charges: [{ amount: 100.0, currencyCode: "USD", description: "Post-offload charge" }],
    });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(
      computePostOffloadImpactRequestFingerprint({
        containerId: 12,
        transactionDate: "2026-10-01",
        charges: [{ amount: 100 }],
      })
    ).not.toBe(a);
    expect(() =>
      computePostOffloadImpactRequestFingerprint({
        containerId: 11,
        transactionDate: "01/10/2026",
        charges: [{ amount: 1 }],
      })
    ).toThrow("A valid transaction date is required for preview.");
  });
});

describe("preparePostOffloadImpactPreview", () => {
  it("projects container cost, supplier rate and scope for a USD charge", async () => {
    const result = await preparePostOffloadImpactPreview(baseInput);
    expect(result.dryRun).toBe(true);
    expect(result.expiresInMs).toBe(REPAIR_TOKEN_TTL_MS);
    expect(typeof result.confirmationToken).toBe("string");
    // Remaining 10,000 of 20,000 kg → half of the 100 USD delta stays in
    // inventory, spread over 4,000 supplier kg: 0.5 + 50 / 4000.
    expect(result.preview).toEqual({
      containerId: 11,
      containerNumber: "MSKU1234567",
      supplierId: 5,
      transactionDate: "2026-10-01",
      chargeCount: 1,
      currentContainerCostPerKgUsd: expect.stringMatching(/^0\.50*$/),
      projectedContainerCostPerKgUsd: expect.stringMatching(/^0\.5050*$/),
      currentContainerTotalUsd: expect.stringMatching(/^10000(\.0+)?$/),
      projectedContainerTotalUsd: expect.stringMatching(/^10100(\.0+)?$/),
      fullContainerValueDeltaUsd: "100.000000",
      containerReceivedKg: expect.stringMatching(/^20000(\.0+)?$/),
      containerRemainingKg: expect.stringMatching(/^10000(\.0+)?$/),
      remainingFraction: "0.50000000",
      supplierRemainingKg: expect.stringMatching(/^4000(\.0+)?$/),
      supplierLockedRateBefore: expect.stringMatching(/^0\.50*$/),
      supplierLockedRateProjected: expect.stringMatching(/^0\.51250*$/),
      supplierInventoryValueDeltaUsd: "50.000000",
      historicalReplaySafe: true,
      historicalReplayBlockedReasons: [],
      scope: {
        supplierOwnedSources: 4,
        affectedSourceRows: 9,
        affectedBatches: 3,
        openBatches: 1,
        completedBatches: 2,
        availableBales: 15,
        finalizedBalesExcluded: 6,
      },
    });

    const [, projectedCharges, commission, otherCharges] = deps.cost.mock.calls[1] as [Row, Row[], Row, Row[]];
    expect(projectedCharges.map((c) => c.id)).toEqual([2, 1, -1]);
    expect(projectedCharges[2]).toMatchObject({
      companyId: 3,
      containerId: 11,
      description: "Port storage",
      amount: "100.000000",
      currencyCode: "USD",
      fxRateToUsd: "1.00000000",
      fxRateConfirmed: true,
      fxRateDate: "2026-10-01",
      createdByUserId: "u-1",
      updatedByUserId: "u-1",
      voucherId: null,
      version: 1,
      createdAt: new Date("2026-10-01T00:00:00.000Z"),
    });
    expect(commission).toEqual({ id: 9 });
    expect(otherCharges).toEqual([{ id: 7 }]);
    expect(deps.scopeParams).toEqual([[3, 5]]);
    expect(deps.clientQueries).toEqual([
      "BEGIN",
      "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
      "COMMIT",
    ]);
    expect(deps.released).toBe(1);
    expect(deps.fx).not.toHaveBeenCalled();
  });

  it("uses the confirmed offload rate for the container currency and a looked-up rate otherwise", async () => {
    const result = await preparePostOffloadImpactPreview({
      ...baseInput,
      charges: [
        { amount: "100", currencyCode: "EUR" },
        { amount: "40000", currencyCode: "CDF" },
      ],
    });
    const synthetic = (deps.cost.mock.calls[1][1] as Row[]).filter((c) => Number(c.id) < 0);
    expect(synthetic).toEqual([
      expect.objectContaining({ id: -1, currencyCode: "EUR", fxRateToUsd: "1.20000000", fxRateDate: "2026-09-30" }),
      expect.objectContaining({ id: -2, currencyCode: "CDF", fxRateToUsd: "0.00075000", fxRateDate: "2026-10-01" }),
    ]);
    expect(deps.fx).toHaveBeenCalledWith(3, "CDF", "2026-10-01");
    // 100 × 1.2 + 40,000 × 0.00075 = 150 USD.
    expect(result.preview.fullContainerValueDeltaUsd).toBe("150.000000");
    expect(result.preview.chargeCount).toBe(2);
  });

  it("falls back to the base container rate and the transaction date for the container currency", async () => {
    seed({ container: { fxRateToUsdOffload: null, fxRateToUsd: "1.05", fxRateDateOffload: null } });
    await preparePostOffloadImpactPreview({ ...baseInput, charges: [{ amount: "10", currencyCode: "eur" }] });
    expect((deps.cost.mock.calls[1][1] as Row[]).at(-1)).toMatchObject({
      fxRateToUsd: "1.05000000",
      fxRateDate: "2026-10-01",
    });
  });

  it("refuses when an FX rate cannot be resolved", async () => {
    deps.fx.mockResolvedValueOnce(null);
    await expect(
      preparePostOffloadImpactPreview({ ...baseInput, charges: [{ amount: "1", currencyCode: "GBP" }] })
    ).rejects.toThrow("Cannot resolve FX rate for GBP on 2026-10-01. Add the FX rate first.");

    deps.fx.mockResolvedValueOnce("-1");
    await expect(
      preparePostOffloadImpactPreview({ ...baseInput, charges: [{ amount: "1", currencyCode: "GBP" }] })
    ).rejects.toThrow("Cannot resolve FX rate for GBP");

    seed({ container: { fxRateConfirmed: false } });
    await expect(preparePostOffloadImpactPreview(baseInput)).rejects.toThrow(InvalidPostOffloadImpactPreviewError);

    deps.cost.mockReturnValueOnce({ costPerKg: 0, costPerKgUsd: 0, totalCost: 0, totalUsd: 0, fxUnresolved: true });
    seed();
    await expect(preparePostOffloadImpactPreview(baseInput)).rejects.toThrow(
      "FX rate unresolved for container MSKU1234567."
    );
  });

  it("looks up the rate for a foreign charge on a USD container", async () => {
    seed({ container: { currencyCode: "USD", fxRateConfirmed: false } });
    deps.fx.mockResolvedValueOnce("1.3");
    // USD containers always resolve; a EUR charge is then looked up.
    await expect(
      preparePostOffloadImpactPreview({ ...baseInput, charges: [{ amount: "1", currencyCode: "EUR" }] })
    ).resolves.toMatchObject({ preview: { fullContainerValueDeltaUsd: "1.300000" } });
  });

  it("rejects missing, deleted or not-yet-received containers and bad dates", async () => {
    await expect(preparePostOffloadImpactPreview({ ...baseInput, transactionDate: "2026-1-1" })).rejects.toThrow(
      "A valid transaction date is required for preview."
    );
    seed({ container: null });
    await expect(preparePostOffloadImpactPreview(baseInput)).rejects.toThrow("Container not found.");
    seed({ container: { status: "IN_TRANSIT" } });
    await expect(preparePostOffloadImpactPreview(baseInput)).rejects.toThrow(
      "Post-offload impact preview is only available for received containers."
    );
    seed({ container: { status: "PARTIALLY_RECEIVED" } });
    await expect(preparePostOffloadImpactPreview(baseInput)).resolves.toMatchObject({ dryRun: true });
  });

  it("skips supplier work for a container without a supplier", async () => {
    seed({ container: { supplierId: null } });
    const { preview } = await preparePostOffloadImpactPreview(baseInput);
    expect(preview).toMatchObject({
      supplierId: null,
      supplierRemainingKg: expect.stringMatching(/^0(\.0+)?$/),
      supplierLockedRateBefore: null,
      supplierLockedRateProjected: null,
      historicalReplaySafe: true,
      historicalReplayBlockedReasons: [],
      scope: {
        supplierOwnedSources: 0,
        affectedSourceRows: 0,
        affectedBatches: 0,
        openBatches: 0,
        completedBatches: 0,
        availableBales: 0,
        finalizedBalesExcluded: 0,
      },
    });
    expect(deps.remainingKg).not.toHaveBeenCalled();
    expect(deps.lockedRate).not.toHaveBeenCalled();
    expect(deps.scopeParams).toEqual([]);
    expect(deps.clientQueries).toEqual([]);
  });

  it("uses the container rate when the supplier has no remaining stock", async () => {
    deps.remainingKg.mockResolvedValue(0);
    deps.lockedRate.mockResolvedValue({ rate: null });
    const { preview } = await preparePostOffloadImpactPreview(baseInput);
    expect(preview.supplierLockedRateBefore).toBeNull();
    expect(preview.supplierLockedRateProjected).toMatch(/^0\.5050*$/);
  });

  it("clamps remaining stock at zero and handles containers with nothing received", async () => {
    seed({ rawStock: [{ id: 1, receivedKg: "100", usedKg: "150" }] });
    let { preview } = await preparePostOffloadImpactPreview(baseInput);
    expect(preview.containerRemainingKg).toMatch(/^0(\.0+)?$/);
    expect(preview.remainingFraction).toBe("0.00000000");
    expect(preview.supplierInventoryValueDeltaUsd).toBe("0.000000");

    // A negative used figure (a reversed issue) never pushes more than the
    // whole delta into inventory.
    seed({ rawStock: [{ id: 1, receivedKg: "1000", usedKg: "-200" }] });
    ({ preview } = await preparePostOffloadImpactPreview(baseInput));
    expect(preview.remainingFraction).toBe("1.00000000");
    expect(preview.supplierInventoryValueDeltaUsd).toBe("100.000000");

    seed({ rawStock: [{ id: 1, receivedKg: null, usedKg: null }] });
    ({ preview } = await preparePostOffloadImpactPreview(baseInput));
    expect(preview.containerReceivedKg).toMatch(/^0(\.0+)?$/);
    expect(preview.remainingFraction).toBe("0.00000000");
  });

  it("defaults missing or unparsable scope counts to zero", async () => {
    deps.scopeRows = [{ supplier_owned_sources: "abc", affected_batches: "2" }];
    let { preview } = await preparePostOffloadImpactPreview(baseInput);
    expect(preview.scope).toEqual({
      supplierOwnedSources: 0,
      affectedSourceRows: 0,
      affectedBatches: 2,
      openBatches: 0,
      completedBatches: 0,
      availableBales: 0,
      finalizedBalesExcluded: 0,
    });
    deps.scopeRows = [];
    ({ preview } = await preparePostOffloadImpactPreview(baseInput));
    expect(preview.scope.affectedBatches).toBe(0);
  });

  it("reports supplier and company-wide historical replay blockers", async () => {
    deps.replay.mockResolvedValue({
      supplierRows: [
        { supplierId: 4, safeToRepair: false, reasons: ["OTHER"] },
        { supplierId: 5, safeToRepair: false, reasons: ["Z_REASON", "A_REASON"] },
      ],
      financialImpact: { allSafetyGatesPassed: false },
    });
    let { preview } = await preparePostOffloadImpactPreview(baseInput);
    expect(preview.historicalReplaySafe).toBe(false);
    expect(preview.historicalReplayBlockedReasons).toEqual([
      "A_REASON",
      "COMPANY_WIDE_HISTORICAL_REPLAY_SAFETY_GATE_FAILED",
      "Z_REASON",
    ]);

    deps.replay.mockResolvedValue({ supplierRows: [], financialImpact: { allSafetyGatesPassed: false } });
    ({ preview } = await preparePostOffloadImpactPreview(baseInput));
    expect(preview.historicalReplaySafe).toBe(false);
    expect(preview.historicalReplayBlockedReasons).toEqual(["COMPANY_WIDE_HISTORICAL_REPLAY_SAFETY_GATE_FAILED"]);

    deps.replay.mockResolvedValue({ supplierRows: [{ supplierId: 5, safeToRepair: false }] });
    ({ preview } = await preparePostOffloadImpactPreview(baseInput));
    expect(preview.historicalReplaySafe).toBe(false);
    expect(preview.historicalReplayBlockedReasons).toEqual([]);

    deps.replay.mockResolvedValue({ supplierRows: [] });
    ({ preview } = await preparePostOffloadImpactPreview(baseInput));
    expect(preview.historicalReplaySafe).toBe(true);
  });

  it("rolls back and reports the failure when the replay preview throws", async () => {
    deps.replay.mockRejectedValueOnce(Object.assign(new Error("lock"), { code: "40001" }));
    let { preview } = await preparePostOffloadImpactPreview(baseInput);
    expect(preview.historicalReplaySafe).toBe(false);
    expect(preview.historicalReplayBlockedReasons).toEqual(["40001"]);
    expect(deps.clientQueries.at(-1)).toBe("ROLLBACK");
    expect(deps.released).toBe(1);

    deps.replay.mockRejectedValueOnce(new Error("replay crashed"));
    ({ preview } = await preparePostOffloadImpactPreview(baseInput));
    expect(preview.historicalReplayBlockedReasons).toEqual(["replay crashed"]);

    deps.replay.mockRejectedValueOnce("boom");
    ({ preview } = await preparePostOffloadImpactPreview(baseInput));
    expect(preview.historicalReplayBlockedReasons).toEqual(["HISTORICAL_REPLAY_PREVIEW_FAILED"]);
    expect(deps.released).toBe(3);
  });
});

describe("verifyPostOffloadImpactPreview", () => {
  async function issue() {
    const prepared = await preparePostOffloadImpactPreview(baseInput);
    return { ...baseInput, token: prepared.confirmationToken, preview: prepared.preview };
  }

  it("accepts an unchanged preview and returns the reviewed summary", async () => {
    const { preview, ...input } = await issue();
    await expect(verifyPostOffloadImpactPreview(input)).resolves.toEqual(preview);
    // Cosmetic request differences still match the reviewed request.
    await expect(
      verifyPostOffloadImpactPreview({ ...input, charges: [{ ...usdCharge, amount: "100.00", currencyCode: "USD" }] })
    ).resolves.toEqual(preview);
  });

  it("rejects tampered, malformed and foreign tokens", async () => {
    const { preview: _preview, ...input } = await issue();
    await expect(verifyPostOffloadImpactPreview({ ...input, token: undefined })).rejects.toThrow(
      InvalidPostOffloadImpactPreviewError
    );
    await expect(verifyPostOffloadImpactPreview({ ...input, token: `${input.token}x` })).rejects.toThrow(
      /Invalid confirmation token/
    );

    const wrongKind = signRepairToken({ kind: "OTHER", version: 1, expiresAt: Date.now() + 60_000 });
    await expect(verifyPostOffloadImpactPreview({ ...input, token: wrongKind })).rejects.toThrow(
      "Unsupported post-offload impact preview token."
    );
    const wrongVersion = signRepairToken({
      kind: "POST_OFFLOAD_IMPACT_PREVIEW_V1",
      version: 2,
      expiresAt: Date.now() + 60_000,
    });
    await expect(verifyPostOffloadImpactPreview({ ...input, token: wrongVersion })).rejects.toThrow(
      "Unsupported post-offload impact preview token."
    );
  });

  it("treats an expired token as stale", async () => {
    const expired = signRepairToken({ kind: "POST_OFFLOAD_IMPACT_PREVIEW_V1", version: 1, expiresAt: Date.now() - 1 });
    const error = await verifyPostOffloadImpactPreview({ ...baseInput, token: expired }).catch((e) => e);
    expect(error).toBeInstanceOf(StalePostOffloadImpactPreviewError);
    expect(error).toMatchObject({
      code: "POST_OFFLOAD_IMPACT_PREVIEW_STALE",
      statusCode: 409,
      message: "Post-offload impact preview expired. Review the impact again before saving.",
    });
  });

  it("binds the token to the user, company, container and date", async () => {
    const { preview: _preview, ...input } = await issue();
    const mismatch = "Post-offload impact preview does not match this user, company, container, or date.";
    await expect(verifyPostOffloadImpactPreview({ ...input, userId: "u-2" })).rejects.toThrow(mismatch);
    await expect(verifyPostOffloadImpactPreview({ ...input, companyId: 4 })).rejects.toThrow(mismatch);
    await expect(verifyPostOffloadImpactPreview({ ...input, containerId: 12 })).rejects.toThrow(mismatch);
    await expect(verifyPostOffloadImpactPreview({ ...input, transactionDate: "2026-10-02" })).rejects.toThrow(mismatch);
    await expect(verifyPostOffloadImpactPreview({ ...input, transactionDate: "bad" })).rejects.toThrow(
      "A valid transaction date is required for preview."
    );
  });

  it("rejects changed charges as invalid and changed cost state as stale", async () => {
    const { preview: _preview, ...input } = await issue();
    await expect(
      verifyPostOffloadImpactPreview({ ...input, charges: [{ ...usdCharge, amount: "101" }] })
    ).rejects.toThrow("Post-offload charges changed after preview. Review the updated impact before saving.");

    seed({ charges: [{ id: 1, amount: "25" }] });
    const stale = await verifyPostOffloadImpactPreview(input).catch((e) => e);
    expect(stale).toBeInstanceOf(StalePostOffloadImpactPreviewError);
    expect(stale.message).toBe(
      "Post-offload cost inputs changed after preview. Review the impact again before saving."
    );
  });

  it("ignores row order when fingerprinting the cost state", async () => {
    const { preview, ...input } = await issue();
    seed({
      charges: [
        { id: 1, amount: "25" },
        { id: 2, amount: "50" },
      ],
      rawStock: [
        { id: 2, receivedKg: "8000", usedKg: "7000" },
        { id: 1, receivedKg: "12000", usedKg: "3000" },
      ],
    });
    await expect(verifyPostOffloadImpactPreview(input)).resolves.toEqual(preview);
  });

  it("detects a changed supplier position and a changed recomputed impact", async () => {
    const { preview: _preview, ...input } = await issue();
    deps.remainingKg.mockResolvedValue(5000);
    await expect(verifyPostOffloadImpactPreview(input)).rejects.toThrow(StalePostOffloadImpactPreviewError);

    deps.remainingKg.mockResolvedValue(4000);
    deps.lockedRate.mockResolvedValue({ rate: new Decimal("0.6") });
    await expect(verifyPostOffloadImpactPreview(input)).rejects.toThrow(
      "Post-offload cost inputs changed after preview."
    );

    deps.lockedRate.mockResolvedValue({ rate: new Decimal("0.5") });
    deps.scopeRows = [{ available_bales: "99" }];
    await expect(verifyPostOffloadImpactPreview(input)).rejects.toThrow(
      "Post-offload cost impact changed after preview. Review the updated impact before saving."
    );
  });
});
