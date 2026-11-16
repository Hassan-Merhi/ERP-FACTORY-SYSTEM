import { describe, expect, it } from "vitest";
import { FACTORY_HISTORICAL_REPLAY_V7_BACKFILL_SQL } from "../server/services/factory/historicalReplayV7MigrationSql";
import { columnDefinition, functionDefinition, hasIndex, hasTrigger, manifestEntry } from "./helpers/schemaManifest";

describe("Historical Replay V7 schema (defined by the schema migrations)", () => {
  it("has the locked supplier rate, inventory owner and valuation basis columns", () => {
    expect(columnDefinition("factory_suppliers", "current_raw_material_cost_per_kg_usd")).toMatchObject({
      type: "numeric(20,8)",
      notNull: false,
    });
    expect(columnDefinition("factory_mix_batch_sources", "inventory_supplier_id")).toMatchObject({ type: "integer" });
    expect(columnDefinition("factory_raw_material_adjustments", "valuation_basis")).toMatchObject({
      type: "character varying(30)",
    });
  });

  it("contains company-isolated database-boundary guards, constraints and indexes", () => {
    const resolver = functionDefinition("factory_resolve_mix_source_inventory_supplier");
    expect(resolver).toContain("INVENTORY_SUPPLIER_COMPANY_MISMATCH");
    expect(resolver).toContain("CONTAINER_INVENTORY_SUPPLIER_CONFLICT");
    expect(functionDefinition("factory_default_new_adjustment_valuation_basis")).toBeDefined();
    expect(hasTrigger("factory_mix_batch_sources", "factory_mix_source_inventory_supplier_trg")).toBe(true);
    expect(hasTrigger("factory_raw_material_adjustments", "factory_adjustment_valuation_basis_trg")).toBe(true);
    expect(hasIndex("factory_mix_batch_sources_inventory_supplier_idx")).toBe(true);
    expect(hasIndex("factory_raw_material_adjustments_unclassified_valuation_idx")).toBe(true);
    expect(
      manifestEntry("constraint", "public.factory_mix_batch_sources.factory_mix_batch_sources_inventory_supplier_fk")
    ).toBeDefined();
    expect(
      manifestEntry(
        "constraint",
        "public.factory_raw_material_adjustments.factory_raw_material_adjustments_valuation_basis_chk"
      )
    ).toBeDefined();
  });
});

describe("Historical Replay V7 backfill", () => {
  it("is data only", () => {
    expect(FACTORY_HISTORICAL_REPLAY_V7_BACKFILL_SQL).toContain("inventory_supplier_id");
    expect(FACTORY_HISTORICAL_REPLAY_V7_BACKFILL_SQL).toContain("valuation_basis = 'QUANTITY_ONLY'");
    expect(FACTORY_HISTORICAL_REPLAY_V7_BACKFILL_SQL).not.toMatch(/\b(CREATE|ALTER|DROP|COMMENT)\b|\bDO\s+\$/i);
  });

  it("never runs the business-data cost replay", () => {
    expect(FACTORY_HISTORICAL_REPLAY_V7_BACKFILL_SQL).not.toMatch(
      /UPDATE\s+factory_suppliers\s+SET\s+current_raw_material_cost_per_kg_usd/i
    );
    expect(FACTORY_HISTORICAL_REPLAY_V7_BACKFILL_SQL).not.toMatch(
      /UPDATE\s+factory_mix_batches\s+SET\s+(cost_per_kg|total_cost)/i
    );
    expect(FACTORY_HISTORICAL_REPLAY_V7_BACKFILL_SQL).not.toMatch(
      /UPDATE\s+factory_bales\s+SET\s+(cost_per_kg|total_cost)/i
    );
  });
});
