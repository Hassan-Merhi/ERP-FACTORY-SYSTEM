import { describe, expect, it } from "vitest";

import {
  insertBaleProductCategorySchema,
  insertBaleProductSchema,
  insertBaleSchema,
  insertBaleTransferItemSchema,
  insertBaleTransferSchema,
  insertMixBatchSchema,
  insertMixBatchSourceSchema,
  insertProductionBaleSchema,
  insertProductionRawStockSchema,
} from "../shared/schema/factory/production";

describe("Phase 33D factory production schemas", () => {
  it("accepts a valid factory bale and rejects invalid enum, currency, and weight boundaries", () => {
    const valid = {
      companyId: 7,
      barcode: "B-001",
      category: "Clothing",
      grade: "A",
      origin: "EU",
      weight: "42.500",
      datePressed: "2026-09-17",
      currency: "USD",
      status: "AVAILABLE",
    };

    expect(insertBaleSchema.safeParse(valid).success).toBe(true);
    expect(insertBaleSchema.safeParse({ ...valid, companyId: 0 }).success).toBe(false);
    expect(insertBaleSchema.safeParse({ ...valid, grade: "D" }).success).toBe(false);
    expect(insertBaleSchema.safeParse({ ...valid, origin: "CA" }).success).toBe(false);
    expect(insertBaleSchema.safeParse({ ...valid, weight: "0" }).success).toBe(false);
    expect(insertBaleSchema.safeParse({ ...valid, weight: "not-a-number" }).success).toBe(false);
    expect(insertBaleSchema.safeParse({ ...valid, currency: "US" }).success).toBe(false);
    expect(insertBaleSchema.safeParse({ ...valid, status: "DELETED" }).success).toBe(false);
  });

  it("enforces positive raw-stock quantities while permitting zero cost", () => {
    const valid = {
      companyId: 7,
      containerId: 11,
      receivedKg: "1000.250",
      costPerKg: "0",
    };

    expect(insertProductionRawStockSchema.safeParse(valid).success).toBe(true);
    expect(insertProductionRawStockSchema.safeParse({ ...valid, receivedKg: "0" }).success).toBe(false);
    expect(insertProductionRawStockSchema.safeParse({ ...valid, receivedKg: "bad" }).success).toBe(false);
    expect(insertProductionRawStockSchema.safeParse({ ...valid, costPerKg: "-0.01" }).success).toBe(false);
    expect(insertProductionRawStockSchema.safeParse({ ...valid, containerId: 0 }).success).toBe(false);
  });

  it("validates mix batches and their source rows without rejecting legitimate zero cost", () => {
    const batch = {
      companyId: 7,
      totalWeightKg: "500",
      costPerKg: "0",
      totalCost: "0",
      status: "ACTIVE",
    };
    expect(insertMixBatchSchema.safeParse(batch).success).toBe(true);
    expect(insertMixBatchSchema.safeParse({ ...batch, totalWeightKg: "0" }).success).toBe(false);
    expect(insertMixBatchSchema.safeParse({ ...batch, costPerKg: "-1" }).success).toBe(false);
    expect(insertMixBatchSchema.safeParse({ ...batch, totalCost: "-1" }).success).toBe(false);
    expect(insertMixBatchSchema.safeParse({ ...batch, status: "VOID" }).success).toBe(false);

    const source = {
      mixBatchId: 9,
      containerId: null,
      sourceBatchId: null,
      weightKg: "125.5",
      costPerKg: "0",
      totalCost: "0",
    };
    expect(insertMixBatchSourceSchema.safeParse(source).success).toBe(true);
    expect(insertMixBatchSourceSchema.safeParse({ ...source, mixBatchId: 0 }).success).toBe(false);
    expect(insertMixBatchSourceSchema.safeParse({ ...source, weightKg: "0" }).success).toBe(false);
    expect(insertMixBatchSourceSchema.safeParse({ ...source, totalCost: "-0.01" }).success).toBe(false);
  });

  it("validates production catalog category/product requirements", () => {
    expect(insertBaleProductCategorySchema.safeParse({ companyId: 7, name: "Wipers" }).success).toBe(true);
    expect(insertBaleProductCategorySchema.safeParse({ companyId: 7, name: "" }).success).toBe(false);

    const product = {
      companyId: 7,
      articleCode: "HMD16001",
      name: "Wiper Waste",
      categoryId: null,
    };
    expect(insertBaleProductSchema.safeParse(product).success).toBe(true);
    expect(insertBaleProductSchema.safeParse({ ...product, articleCode: "" }).success).toBe(false);
    expect(insertBaleProductSchema.safeParse({ ...product, name: "" }).success).toBe(false);
  });

  it("guards production-bale numeric and status fields", () => {
    const bale = {
      companyId: 7,
      baleCode: "PB-100",
      barcodeValue: "BC-100",
      weightKg: "45",
      costPerKg: "0",
      totalCost: "0",
      status: "IN_STOCK",
    };

    expect(insertProductionBaleSchema.safeParse(bale).success).toBe(true);
    expect(insertProductionBaleSchema.safeParse({ ...bale, weightKg: "0" }).success).toBe(false);
    expect(insertProductionBaleSchema.safeParse({ ...bale, costPerKg: "-1" }).success).toBe(false);
    expect(insertProductionBaleSchema.safeParse({ ...bale, totalCost: "-1" }).success).toBe(false);
    expect(insertProductionBaleSchema.safeParse({ ...bale, status: "DISPATCHED" }).success).toBe(false);
  });

  it("enforces transfer identity, creator, quantity, and monetary boundaries", () => {
    const transfer = {
      companyId: 7,
      sourceLocationId: 1,
      destinationLocationId: 2,
      transferDate: "2026-09-17",
      createdBy: "user-1",
      status: "PENDING",
    };
    expect(insertBaleTransferSchema.safeParse(transfer).success).toBe(true);
    expect(insertBaleTransferSchema.safeParse({ ...transfer, sourceLocationId: 0 }).success).toBe(false);
    expect(insertBaleTransferSchema.safeParse({ ...transfer, createdBy: "" }).success).toBe(false);
    expect(insertBaleTransferSchema.safeParse({ ...transfer, status: "VOID" }).success).toBe(false);

    const item = {
      transferId: 1,
      productionBaleId: 2,
      quantity: 1,
      weightKg: "50",
      costPerKg: "0",
      totalCost: "0",
    };
    expect(insertBaleTransferItemSchema.safeParse(item).success).toBe(true);
    expect(insertBaleTransferItemSchema.safeParse({ ...item, quantity: 0 }).success).toBe(false);
    expect(insertBaleTransferItemSchema.safeParse({ ...item, weightKg: "0" }).success).toBe(false);
    expect(insertBaleTransferItemSchema.safeParse({ ...item, costPerKg: "-1" }).success).toBe(false);
  });
});