import { describe, expect, it } from "vitest";
import { translateApprovedInterfaceText } from "@/components/ApplicationInterfaceTranslator";
import { translateProformaCapacityPhase4Text } from "./proformaCapacityPhase4Translations";

const PHASE4_LITERALS = [
  "Loaded (This+Other)",
  "Proforma fully consumed",
  "No remaining quantity is available for a new loading.",
  "Failed to fetch proforma capacity",
  "Invalid currentOrderId",
] as const;

describe("Phase 4 proforma capacity translations", () => {
  it("translates every literal the reconciliation introduced", () => {
    for (const literal of PHASE4_LITERALS) {
      expect(translateProformaCapacityPhase4Text(literal, "en")).toBe(literal);
      expect(translateProformaCapacityPhase4Text(literal, "ar")).toBeTruthy();
      expect(translateProformaCapacityPhase4Text(literal, "fr")).toBeTruthy();
      expect(translateProformaCapacityPhase4Text(literal, "ar")).not.toBe(literal);
      expect(translateProformaCapacityPhase4Text(literal, "fr")).not.toBe(literal);
    }
  });

  it("is reachable through the interface translator, not just the module", () => {
    for (const literal of PHASE4_LITERALS) {
      expect(translateApprovedInterfaceText(literal, "ar")).toBe(translateProformaCapacityPhase4Text(literal, "ar"));
      expect(translateApprovedInterfaceText(literal, "fr")).toBe(translateProformaCapacityPhase4Text(literal, "fr"));
    }
  });

  it("preserves surrounding whitespace and leaves unknown copy alone", () => {
    expect(translateProformaCapacityPhase4Text("  Proforma fully consumed ", "fr")).toBe(
      "  Proforma entièrement consommé "
    );
    expect(translateProformaCapacityPhase4Text("Some other copy", "fr")).toBeNull();
    expect(translateProformaCapacityPhase4Text("   ", "fr")).toBeNull();
  });
});
