/**
 * The factory raw-stock and mix-batch insert schemas accept an amount only
 * when it is a number as a numeric column reads it: "5kg" passed parseFloat's
 * check (it reads 5) and then failed at insert; it is now rejected by the
 * schema with the same message the field always used.
 */
import { describe, expect, it } from "vitest";
import {
  insertFactoryMixBatchSchema,
  insertFactoryMixBatchSourceSchema,
  insertFactoryRawStockSchema,
} from "@shared/schema";

const messages = (result: { success: boolean; error?: { issues: Array<{ message: string }> } }) =>
  result.error?.issues.map((issue) => issue.message) ?? [];

describe("raw stock and mix batch schema amounts", () => {
  const rawStock = (receivedKg: string, costPerKg = "0.35") =>
    insertFactoryRawStockSchema.safeParse({ companyId: 7, containerId: 1, receivedKg, costPerKg });

  it.each(["5", "0.125", " 12.5 ", "1e3"])("accepts %j as received kg", (kg) => {
    expect(rawStock(kg).success).toBe(true);
  });

  it.each(["0", "-1", "5kg", "abc", "", "1,000", "Infinity"])("rejects %j as received kg", (kg) => {
    expect(messages(rawStock(kg))).toContain("Received kg must be positive");
  });

  it("allows a zero cost but not a negative or unparsable one", () => {
    expect(rawStock("10", "0").success).toBe(true);
    expect(messages(rawStock("10", "-0.01"))).toContain("Cost per kg must be non-negative");
    expect(messages(rawStock("10", "0.35/kg"))).toContain("Cost per kg must be non-negative");
  });

  it("validates mix batch and source amounts the same way", () => {
    const batch = insertFactoryMixBatchSchema.safeParse({
      companyId: 7,
      totalWeightKg: "100kg",
      totalCost: "35",
      costPerKg: "0.35",
    });
    expect(messages(batch)).toContain("Total weight must be positive");
    const source = insertFactoryMixBatchSourceSchema.safeParse({
      mixBatchId: 1,
      weightKg: "10",
      costPerKg: "0.35",
      totalCost: "3.5 USD",
    });
    expect(messages(source)).toContain("Total cost must be non-negative");
  });
});
