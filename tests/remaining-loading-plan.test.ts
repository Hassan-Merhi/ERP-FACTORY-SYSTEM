import { describe, expect, it } from "vitest";
import { buildRemainingLoadingPlan } from "../server/routes/factory/customer-orders/remainingLoadingPlan";

const source = [
  { articleCode: "HMD-A", productName: "Product A", expectedQty: 60, proformaLineId: 11 },
  { articleCode: "HMD-B", productName: "Product B", expectedQty: 40, proformaLineId: 12 },
];

describe("remaining-only continuation loading", () => {
  it("shows only the unscanned quantities by article, never the full original proforma", () => {
    const next = buildRemainingLoadingPlan(source, new Map([["hmd-a", 45], ["hmd-b", 20]]));
    expect(next).toEqual({
      lines: [
        { articleCode: "HMD-A", productName: "Product A", expectedQty: 15, proformaLineId: 11 },
        { articleCode: "HMD-B", productName: "Product B", expectedQty: 20, proformaLineId: 12 },
      ],
      remainingBales: 35,
    });
  });

  it("keeps reducing the saved remaining-only plan through several containers", () => {
    const second = buildRemainingLoadingPlan(source, new Map([["hmd-a", 45], ["hmd-b", 20]]));
    const third = buildRemainingLoadingPlan(second.lines, new Map([["hmd-a", 10], ["hmd-b", 10]]));
    expect(third).toEqual({
      lines: [
        { articleCode: "HMD-A", productName: "Product A", expectedQty: 5, proformaLineId: 11 },
        { articleCode: "HMD-B", productName: "Product B", expectedQty: 10, proformaLineId: 12 },
      ],
      remainingBales: 15,
    });
  });

  it("deduplicates case-variant article lines and clamps overloading to zero", () => {
    const plan = buildRemainingLoadingPlan(
      [
        { articleCode: " ABC ", productName: "First", expectedQty: 2, proformaLineId: 1 },
        { articleCode: "abc", productName: "Second", expectedQty: 3, proformaLineId: 2 },
        { articleCode: "DEF", productName: "Other", expectedQty: 1, proformaLineId: 3 },
      ],
      new Map([["abc", 9]])
    );
    expect(plan).toEqual({
      lines: [{ articleCode: "DEF", productName: "Other", expectedQty: 1, proformaLineId: 3 }],
      remainingBales: 1,
    });
  });

  it("returns no continuation when nothing is missing", () => {
    const result = buildRemainingLoadingPlan(source, new Map([["hmd-a", 60], ["hmd-b", 45]]));
    expect(result.lines).toEqual([]);
    expect(result.remainingBales).toBe(0);
  });

  it("refuses corrupt or fractional quantities rather than silently losing bales", () => {
    expect(() =>
      buildRemainingLoadingPlan([{ ...source[0], expectedQty: -1 }], new Map())
    ).toThrow("Invalid expected quantity");
    expect(() =>
      buildRemainingLoadingPlan(source, new Map([["hmd-a", 0.5]]))
    ).toThrow("Invalid loaded quantity");
  });

  it("keeps one proforma reference and uses an empty new order before any scanning", () => {
    const finalize = requireText("server/routes/factory/customer-orders/finalize-loading/loading.ts");
    const capacity = requireText("server/routes/factory/customer-orders/proformaCapacity.ts");
    const dialog = requireText("client/src/pages/factory/factorycontainerloadingscan/FinalizeLoadingDialog.tsx");

    expect(finalize).toContain("nextLoadingLines.map((line)");
    expect(finalize).toContain("status: \"LOADING\"");
    expect(finalize).toContain("proformaIdUsed: order.proformaIdUsed");
    expect(finalize).toContain("buildRemainingLoadingPlan(");
    expect(capacity).toContain("SELECT article_code AS \"articleCode\", expected_qty AS quantity");
    expect(capacity).toContain("AND NOT EXISTS (");
    expect(dialog).toContain('data-testid="button-finalize-open-next-loading"');
  });
});

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
function requireText(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}
