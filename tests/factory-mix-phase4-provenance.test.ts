import { describe, expect, it, vi } from "vitest";
import {
  MixRawStockShortageError,
  requireMixRawStockCapacity,
  requireMixFifoFullyAllocated,
  availableSupplierAddAllowance,
} from "../server/services/factory/mixRawStockQuantityGuard";
import {
  buildPhase4ProvenanceReport,
  classifySupplierStockCoverage,
  phase4MixProvenanceCsv,
} from "../server/services/factory/mixPhase4ProvenanceAudit";

describe("Phase 4 Factory supplier ADD and raw-stock integrity", () => {
  it("covers a negative receipt row only when a corresponding ADD stock pool exists", () => {
    const germany = classifySupplierStockCoverage({
      receivedKg: "46181", usedKg: "49697", addAdjustmentKg: "3516",
      deductAdjustmentKg: "0", rowOverdrawKg: "3516",
    });
    expect(germany.coverage).toBe("POTENTIALLY_ADJUSTMENT_BACKED");
    expect(germany.netKg).toBe("0.000");
    const banin = classifySupplierStockCoverage({
      receivedKg: "13032", usedKg: "32656", addAdjustmentKg: "19624",
      deductAdjustmentKg: "401", rowOverdrawKg: "19624",
    });
    // DEDUCT has already reduced receivedKg and cannot be double-subtracted.
    expect(banin.coverage).toBe("POTENTIALLY_ADJUSTMENT_BACKED");
    expect(banin.netKg).toBe("0.000");
  });

  it("does not claim that a negative receipt row is automatically an actual stock deficit", () => {
    expect(classifySupplierStockCoverage({
      receivedKg: "16691", usedKg: "19454", addAdjustmentKg: "2763",
      deductAdjustmentKg: "0", rowOverdrawKg: "2763",
    }).coverage).toBe("POTENTIALLY_ADJUSTMENT_BACKED");
    expect(classifySupplierStockCoverage({
      receivedKg: "16691", usedKg: "19454", addAdjustmentKg: "2000",
      deductAdjustmentKg: "0", rowOverdrawKg: "2763",
    }).coverage).toBe("UNBACKED_SHORTAGE");
  });

  it("rejects unbacked mix consumption but permits available, documented ADD stock", () => {
    expect(() => requireMixRawStockCapacity({ availableKg: "0.100", requestedKg: "0.200", source: "C1" }))
      .toThrow(MixRawStockShortageError);
    expect(() => requireMixRawStockCapacity({ availableKg: "0.300", requestedKg: "0.300", source: "C1" }))
      .not.toThrow();
    expect(() => requireMixFifoFullyAllocated("0.300", 7, "0.299")).toThrow(MixRawStockShortageError);
    expect(() => requireMixFifoFullyAllocated("0.300", 7, "0.300")).not.toThrow();
  });

  it("rejects an invalid business date before using any supplier ADD history", async () => {
    const tx = { select: () => { throw new Error("Unexpected query"); } };
    await expect(availableSupplierAddAllowance(tx as never, 12, 26, [], "tomorrow"))
      .rejects.toThrow(MixRawStockShortageError);
  });

  it("deducts existing receipt overuse from new ADD allowance", async () => {
    const payload = [{ kg: "3516.000" }];
    const tx = {
      select: () => ({
        from() { return this; },
        where() { return Promise.resolve(payload); },
      }),
    };
    const remaining = await availableSupplierAddAllowance(tx as never, 12, 26,
      [{ receivedKg: "46181", usedKg: "49697" }]);
    expect(remaining.toFixed(3)).toBe("0.000");
  });

  it("subtracts manual supplier-only consumption when no physical receipt rows exist", async () => {
    const queues = [[{ kg: "500.000" }], [{ kg: "300.000" }]];
    const tx = {
      select: () => ({
        from() { return this; },
        innerJoin() { return this; },
        where() { return Promise.resolve(queues.shift()); },
      }),
    };
    const allowance = await availableSupplierAddAllowance(tx as never, 12, 26, []);
    expect(allowance.toFixed(3)).toBe("200.000");
  });
});

describe("Phase 4 supplier provenance report", () => {
  const raw = [{
    raw_stock_id: 80, container_id: 66, container_number: "OB-2026-0001",
    company_id: 12, supplier_id: 34, supplier_name: "BANIN",
    received_kg: "13032.000", used_kg: "32656.000", cost_per_kg_usd: "0.2",
    offloaded_at: "2026-03-28",
  }];
  const ownership = [{
    batch_id: 71, batch_code: "FMB-2026-0071", batch_status: "COMPLETED",
    source_id: 381, source_type: "CONTAINER", source_supplier_id: 37,
    inventory_supplier_id: 37, container_supplier_id: 60, container_id: 71,
    container_number: "MEDU7875650", container_company_id: 12,
    source_weight_kg: "5667.000", source_rate_usd: "0.6278830",
    source_total_usd: "3558.2129610",
  }];
  const adjustments = [{
    id: 5, supplier_id: 34, supplier_name: "BANIN", date: "2026-03-17",
    type: "ADD", kg: "19624.000", cost_per_kg: "0.2",
    currency_code: "USD", valuation_basis: null, reference: "=badformula",
    notes: null,
  }, {
    id: 15, supplier_id: 31, supplier_name: "SPAIN MANSOUR", date: "2026-05-04",
    type: "ADD", kg: "2763.000", cost_per_kg: "0.7085",
    currency_code: "EUR", valuation_basis: null, reference: null,
    notes: "MOVED FROM FORMACIO",
  }];

  it("reports current owner mismatch as evidence-review only, without rewriting historical rates", () => {
    const report = buildPhase4ProvenanceReport(12, raw, ownership, adjustments, []);
    expect(report.readOnly).toBe(true);
    expect(report.summary.ownershipAffectedBatches).toBe(1);
    expect(report.ownershipExceptions[0]).toMatchObject({
      pricingSupplierId: 37,
      recordedInventorySupplierId: 37,
      currentContainerSupplierId: 60,
      recordedRateUsd: "0.6278830",
      classification: "REQUIRES_HISTORICAL_TRANSFER_PROOF",
    });
    expect(report.summary.rawStockOverdrawRows).toBe(1);
    expect(report.rawStockExceptions[0].supplierCoverage).toBe("POTENTIALLY_ADJUSTMENT_BACKED");
  });

  it("identifies non-USD unclassified valued additions without guessing an FX rate", () => {
    const report = buildPhase4ProvenanceReport(12, raw, ownership, adjustments, []);
    expect(report.summary.unclassifiedValuedAdds).toBe(2);
    expect(report.summary.unclassifiedNonUsdAdds).toBe(1);
    expect(report.adjustmentEvidence.find((a) => a.adjustmentId === 15)?.classification)
      .toBe("FX_AND_BASIS_EVIDENCE_REQUIRED");
  });

  it("escapes formula injection from historic adjustment references in the CSV", () => {
    const report = buildPhase4ProvenanceReport(12, raw, ownership, adjustments, []);
    expect(phase4MixProvenanceCsv(report, "adjustments")).toContain("'=badformula");
    expect(phase4MixProvenanceCsv(report, "ownership")).toContain("5667.000");
    expect(phase4MixProvenanceCsv(report, "stock")).toContain("19624.000");
  });
});
