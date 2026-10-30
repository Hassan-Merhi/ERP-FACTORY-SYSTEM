import { describe, expect, it } from "vitest";
import { describeInventoryCostBridge } from "../server/services/accounting/costBridgeInterpretation";

describe("stock-flow bridge accounting-method safety", () => {
  it("does not turn periodic-inventory differences into adjusting journals", () => {
    const bridge = describeInventoryCostBridge(false);
    expect(bridge.accountingBasis).toBe("periodic");
    expect(bridge.inventoryBridgeIsJournalReconciliation).toBe(false);
    expect(bridge.reconciliationInterpretation).toContain("Do not book the difference");
  });

  it("treats perpetual stock movements as a bridge, still requiring verification", () => {
    const bridge = describeInventoryCostBridge(true);
    expect(bridge.accountingBasis).toBe("perpetual");
    expect(bridge.inventoryBridgeIsJournalReconciliation).toBe(true);
    expect(bridge.reconciliationInterpretation).toContain("review source-level movements");
  });

  it("demonstrates that an old cost-flow net cannot be safely posted after stock changes", () => {
    const receipts = 372853.7;
    const recordedCogs = 303022.84;
    const earlierStock = 69909.72;
    const laterStock = 69742.12;
    const earlierGap = Number((receipts - recordedCogs - earlierStock).toFixed(2));
    const currentGap = Number((receipts - recordedCogs - laterStock).toFixed(2));
    expect(earlierGap).toBe(-78.86);
    expect(currentGap).toBe(88.74);
    expect(Number((earlierStock - laterStock).toFixed(2))).toBe(167.6);
    expect(Number((103.74 + 63.86).toFixed(2))).toBe(167.6);
  });
});
