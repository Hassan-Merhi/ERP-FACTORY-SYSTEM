/**
 * The production insert schemas accept an amount only when it is a number as
 * a numeric column reads it: "5kg" passed parseFloat's check (it reads 5) and
 * then failed at insert; it is now rejected by the schema with the same
 * message the field always used.
 */
import { describe, expect, it } from "vitest";
import { insertMixBatchSourceSchema, insertProductionRawStockSchema } from "@shared/schema";

const rawStock = (receivedKg: string, costPerKg = "0.35") =>
  insertProductionRawStockSchema.safeParse({ companyId: 7, containerId: 1, receivedKg, costPerKg });

describe("production schema amounts", () => {
  it.each(["5", "0.125", " 12.5 ", "1e3"])("accepts %j as a positive kg", (kg) => {
    expect(rawStock(kg).success).toBe(true);
  });

  it.each(["0", "-1", "5kg", "abc", "", "1,000", "Infinity"])("rejects %j as a positive kg", (kg) => {
    const result = rawStock(kg);
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.message)).toContain("Received kg must be positive");
  });

  it("allows a zero cost but not a negative or unparsable one", () => {
    const source = (costPerKg: string) =>
      insertMixBatchSourceSchema.safeParse({ mixBatchId: 1, weightKg: "10", costPerKg, totalCost: "0" }).success;
    expect(source("0")).toBe(true);
    expect(source("-0.01")).toBe(false);
    expect(source("0.35/kg")).toBe(false);
  });
});
