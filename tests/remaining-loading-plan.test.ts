import { describe, expect, it } from "vitest";
import { buildRemainingLoadingPlan } from "../server/routes/factory/customer-orders/remainingLoadingPlan";
import { mergeNewProformaArticles } from "../server/routes/factory/customer-orders/proformaPlan";

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

  it("does not resurrect completed articles in the second or third continuation", () => {
    const original = [
      { ...source[0], createdAt: new Date("2026-10-01T00:00:00Z") },
      { ...source[1], createdAt: new Date("2026-10-01T00:00:00Z") },
    ];
    const second = buildRemainingLoadingPlan(original, new Map([["hmd-a", 60], ["hmd-b", 10]]));
    expect(second.lines.map((line) => [line.articleCode, line.expectedQty])).toEqual([["HMD-B", 30]]);

    const resumed = mergeNewProformaArticles(second.lines, original, true, "2026-10-02T00:00:00Z");
    expect(resumed.map((line) => line.articleCode)).toEqual(["HMD-B"]);
    const third = buildRemainingLoadingPlan(resumed, new Map([["hmd-b", 20]]));
    expect(third.lines.map((line) => [line.articleCode, line.expectedQty])).toEqual([["HMD-B", 10]]);
    expect(mergeNewProformaArticles(third.lines, original, true, "2026-10-03T00:00:00Z"))
      .toHaveLength(1);
  });

  it("adds genuinely new proforma items to unfinished continuation plans", () => {
    const original = [
      { ...source[0], createdAt: "2026-10-01T00:00:00Z" },
      { ...source[1], createdAt: "2026-10-01T00:00:00Z" },
      { articleCode: "HMD-C", productName: "Added item", expectedQty: 4, proformaLineId: 13, createdAt: "2026-10-04T00:00:00Z" },
    ];
    const saved = [{ ...source[1], expectedQty: 8 }];
    const merged = mergeNewProformaArticles(saved, original, true, "2026-10-03T00:00:00Z");
    expect(merged.map((line) => [line.articleCode, line.expectedQty])).toEqual([
      ["HMD-B", 8],
      ["HMD-C", 4],
    ]);
    const next = buildRemainingLoadingPlan(merged, new Map([["hmd-b", 3]]));
    expect(next.remainingBales).toBe(9);
  });

  it("does not revive old master articles omitted by an existing legacy continuation", () => {
    const master = [
      { ...source[0], created_at: "2026-10-01T00:00:00Z" },
      { ...source[1], created_at: "2026-10-01T00:00:00Z" },
    ];
    const saved = [{ ...source[1], expectedQty: 10 }];
    expect(mergeNewProformaArticles(saved, master, true, "2026-10-02T00:00:00Z"))
      .toEqual(saved);
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
    expect(capacity).toContain("AND cpl.created_at > co.created_at");
    expect(finalize).toContain("mergeNewProformaArticles(existingPlan, masterPlan, planKind === "continuation", order.createdAt)");
    expect(dialog).toContain('data-testid="button-finalize-open-next-loading"');
  });
});

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
function requireText(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}
