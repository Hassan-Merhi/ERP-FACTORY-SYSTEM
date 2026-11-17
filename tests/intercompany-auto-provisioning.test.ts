import { describe, expect, it } from "vitest";
import {
  normalizedTradingName,
  propertiesSupplierCode,
  tradingAccountSpecs,
  uniquePropertiesSupplier,
} from "../server/services/intercompany/tradingProvisioningPlan";

describe("automatic Properties to ERP container trading setup", () => {
  const source = { id: 17, name: "TEST PROPERTIES" };
  const dest = { id: 31, name: "TEST HADI" };

  it("uses seven deterministic, non-overlapping company-scoped account identities", () => {
    const specs = tradingAccountSpecs(source, dest);
    expect(specs).toHaveLength(7);
    expect(new Set(specs.map((account) => `${account.companyId}:${account.code}`)).size).toBe(7);
    expect(specs.filter((account) => account.companyId === source.id)).toHaveLength(5);
    expect(specs.filter((account) => account.companyId === dest.id)).toHaveLength(2);
    expect(specs.find((account) => account.field === "sourceReceivableAccountId")?.accountType).toBe("Asset");
    expect(specs.find((account) => account.field === "destinationPayableAccountId")?.accountType).toBe("Liability");
    expect(specs.find((account) => account.field === "destinationGitAccountId")?.accountType).toBe("Asset");
    expect(specs.find((account) => account.field === "sourceSalesAccountId")?.accountType).toBe("Income");
    expect(specs.find((account) => account.field === "sourceCostAccountId")?.code).not.toBe(
      specs.find((account) => account.field === "sourcePurchaseAccountId")?.code
    );
    expect(tradingAccountSpecs(source, dest)).toEqual(specs);
  });

  it("isolates the destination payables and source receivables for different company pairs", () => {
    const hadi = tradingAccountSpecs(source, dest);
    const mali = tradingAccountSpecs(source, { id: 32, name: "TEST MALI" });
    expect(hadi.find((row) => row.field === "sourceReceivableAccountId")?.code).not.toBe(
      mali.find((row) => row.field === "sourceReceivableAccountId")?.code
    );
    expect(
      tradingAccountSpecs({ id: 18, name: "OTHER PROPERTIES" }, dest).find(
        (row) => row.field === "destinationPayableAccountId"
      )?.code
    ).not.toBe(hadi.find((row) => row.field === "destinationPayableAccountId")?.code);
    expect(propertiesSupplierCode(17, 31)).toBe("IC-PROP-17-31");
    expect(propertiesSupplierCode(18, 31)).not.toBe(propertiesSupplierCode(17, 31));
  });

  it("reuses only one active exact-name Properties supplier", () => {
    const existing = { id: 71, legalName: "TEST  PROPERTIES", active: true, deletedAt: null };
    expect(normalizedTradingName(existing.legalName)).toBe(normalizedTradingName(source.name));
    expect(uniquePropertiesSupplier([existing], source.name)).toBe(existing);
    expect(uniquePropertiesSupplier([], source.name)).toBeUndefined();
  });

  it("fails closed for duplicate or inactive matching suppliers", () => {
    const active = { id: 1, legalName: source.name, active: true, deletedAt: null };
    const duplicate = { id: 2, legalName: "Test-Properties", active: true, deletedAt: null };
    expect(() => uniquePropertiesSupplier([active, duplicate], source.name)).toThrow("Multiple Properties-named");
    expect(() => uniquePropertiesSupplier([{ ...active, active: false }], source.name)).toThrow("inactive or deleted");
    expect(() => uniquePropertiesSupplier([{ ...active, deletedAt: new Date("2026-01-01") }], source.name)).toThrow(
      "inactive or deleted"
    );
  });
});
