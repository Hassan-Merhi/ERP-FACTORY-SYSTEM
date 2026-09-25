import { deriveGrade, mergeProductionPeriods } from "@/pages/factory/productioncomparison/utils";
import type { ProductRow } from "@/pages/factory/productioncomparison/types";

const row = (overrides: Partial<ProductRow> & Pick<ProductRow, "articleCode">): ProductRow => ({
  productName: `Product ${overrides.articleCode}`,
  categoryName: "Mixed",
  qty: 0,
  totalWeightKg: 0,
  ...overrides,
});

describe("mergeProductionPeriods", () => {
  it("pairs an article's Period A and Period B figures on one row", () => {
    const [merged] = mergeProductionPeriods(
      [row({ articleCode: "A1", qty: 10, totalWeightKg: 450, mixBatchIds: [1, 2] })],
      [row({ articleCode: "A1", qty: 4, totalWeightKg: 180, mixBatchIds: [3] })]
    );

    expect(merged).toMatchObject({
      articleCode: "A1",
      grade: deriveGrade("A1"),
      aQty: 10,
      bQty: 4,
      aKg: 450,
      bKg: 180,
      aMixBatchIds: [1, 2],
      bMixBatchIds: [3],
    });
  });

  it("keeps articles produced in only one period with zeros for the other", () => {
    const merged = mergeProductionPeriods(
      [row({ articleCode: "ONLY-A", qty: 3, totalWeightKg: 90 })],
      [row({ articleCode: "ONLY-B", qty: 5, totalWeightKg: 150 })]
    );
    const byCode = Object.fromEntries(merged.map((r) => [r.articleCode, r]));

    expect(byCode["ONLY-A"]).toMatchObject({ aQty: 3, bQty: 0, aKg: 90, bKg: 0, bMixBatchIds: [] });
    expect(byCode["ONLY-B"]).toMatchObject({ aQty: 0, bQty: 5, aKg: 0, bKg: 150, aMixBatchIds: [] });
  });

  it("lists workers from both periods by total bales, then by name", () => {
    const [merged] = mergeProductionPeriods(
      [
        row({
          articleCode: "W1",
          workers: [
            { id: 1, name: "Sami", qty: 2 },
            { id: 2, name: "Ali", qty: 3 },
          ],
        }),
      ],
      [
        row({
          articleCode: "W1",
          workers: [
            { id: 1, name: "Sami", qty: 2 },
            { id: 3, name: "Bilal", qty: 3 },
            { id: null, name: "", qty: 9 },
          ],
        }),
      ]
    );

    expect(merged.workers).toEqual(["Sami", "Ali", "Bilal"]);
  });
});
