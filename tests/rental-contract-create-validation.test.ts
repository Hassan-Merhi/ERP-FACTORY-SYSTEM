import { describe, expect, it } from "vitest";
import { insertPropertyContractSchema } from "../shared/schema/properties";

const base = {
  companyId: 1,
  unitId: 9,
  tenantName: "HASSAN DAKIK",
  startDate: "2026-11-01",
  rentalAmount: "20000",
  currency: "USD",
  isInternal: false,
};

describe("rental contract creation validation", () => {
  it("normalizes an empty optional guarantee into a valid zero amount", () => {
    const contract = insertPropertyContractSchema.parse({ ...base, guaranteeAmount: "" });
    expect(contract.guaranteeAmount).toBe("0");
  });

  it("also normalizes whitespace-only guarantee amounts", () => {
    const contract = insertPropertyContractSchema.parse({ ...base, guaranteeAmount: "   " });
    expect(contract.guaranteeAmount).toBe("0");
  });

  it("preserves an entered valid guarantee amount", () => {
    const contract = insertPropertyContractSchema.parse({ ...base, guaranteeAmount: "2500.50" });
    expect(contract.guaranteeAmount).toBe("2500.50");
  });

  it("rejects invalid numeric guarantees before SQL insertion", () => {
    expect(insertPropertyContractSchema.safeParse({ ...base, guaranteeAmount: "not-a-number" }).success).toBe(false);
    expect(insertPropertyContractSchema.safeParse({ ...base, guaranteeAmount: "-25" }).success).toBe(false);
  });
});
