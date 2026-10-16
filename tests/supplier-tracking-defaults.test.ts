import { describe, expect, it } from "vitest";
import { isBlankTrackingValue, resolveTrackingDefaults, resolveTrackingDutyFee } from "../server/services/supplierTrackingDefaults";

describe("supplier tracking defaults", () => {
  it("fills blank shop and agent values from the supplier mapping", () => {
    expect(
      resolveTrackingDefaults({ shopName: null, agent: "" }, { locationName: "Hadi #1", agentName: "NAHLI" })
    ).toEqual({ shopName: "Hadi #1", agent: "NAHLI" });
  });

  it("preserves explicit container values over defaults", () => {
    expect(
      resolveTrackingDefaults(
        { shopName: "Manual Shop", agent: "NCA" },
        { locationName: "Hadi #1", agentName: "NAHLI" }
      )
    ).toEqual({ shopName: "Manual Shop", agent: "NCA" });
  });

  it("fills only the missing field", () => {
    expect(
      resolveTrackingDefaults(
        { shopName: "Manual Shop", agent: "   " },
        { locationName: "Hadi #1", agentName: " KDOUH " }
      )
    ).toEqual({ shopName: "Manual Shop", agent: "KDOUH" });
  });

  it("treats null, empty, and whitespace-only values as blank", () => {
    expect(isBlankTrackingValue(null)).toBe(true);
    expect(isBlankTrackingValue("")).toBe(true);
    expect(isBlankTrackingValue("   ")).toBe(true);
    expect(isBlankTrackingValue("NAHLI")).toBe(false);
  });
  it("fills only a missing duty fee and preserves explicit 0 or a manual amount", () => {
    expect(resolveTrackingDutyFee(null, "48.31")).toBe("48.31");
    expect(resolveTrackingDutyFee(undefined, "0")).toBe("0");
    expect(resolveTrackingDutyFee("0", "48.31")).toBe("0");
    expect(resolveTrackingDutyFee("30.00", "48.31")).toBe("30.00");
    expect(resolveTrackingDutyFee(null, null)).toBeNull();
  });

});
