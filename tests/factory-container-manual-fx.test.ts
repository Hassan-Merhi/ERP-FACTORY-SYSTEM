import { describe, expect, it } from "vitest";
import { parseContainerManualFxRate } from "../server/services/factory/containerManualFxRate";

describe("container-specific manual FX validation", () => {
  it("accepts a confirmed container quote even without a company-wide dated rate", () => {
    expect(parseContainerManualFxRate("1.12", "EUR")?.toFixed()).toBe("1.12");
    expect(parseContainerManualFxRate("1", "EUR")?.toFixed()).toBe("1");
    expect(parseContainerManualFxRate("0.00000001", "GBP")?.toFixed()).toBe("0.00000001");
    expect(parseContainerManualFxRate("999999999999.99999999", "EUR")?.toFixed()).toBe("999999999999.99999999");
  });

  it("rejects malformed, unrepresentable, nonpositive or nonidentity USD rates", () => {
    for (const invalid of ["", "0", "-1", "1.2EUR", "Infinity", "NaN", "0.000000001", "1.123456789", "1000000000000"]) {
      expect(parseContainerManualFxRate(invalid, "EUR")).toBeNull();
    }
    expect(parseContainerManualFxRate("1.12", "USD")).toBeNull();
    expect(parseContainerManualFxRate("1", "USD")?.toFixed()).toBe("1");
  });
});
