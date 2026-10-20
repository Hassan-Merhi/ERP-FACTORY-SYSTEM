import { describe, expect, it } from "vitest";
import { mergeNewProformaArticles } from "../server/routes/factory/customer-orders/proformaPlan";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

describe("new proforma articles on already-created loadings", () => {
  const saved = [
    { article_code: "HMD11026", product_name: "CROCHET 40KG", quantity: 4 },
    { article_code: "HMD10027", product_name: "JOGGING PANT WCR 20KG", quantity: 0 },
  ];
  const master = [
    { article_code: "HMD11026", product_name: "CROCHET 40KG", quantity: 7 },
    { article_code: "hmd10027", product_name: "JOGGING PANT WCR 20KG", quantity: 1 },
    { article_code: "HMD12101", product_name: "HAND - BAG 25KG", quantity: 5 },
  ];

  it("shows the newly added jogging pant WCR with its expected 2 and loaded 1", () => {
    const oldPlan = [{ article_code: "HMD11026", quantity: 4 }];
    const editedProforma = [
      { article_code: "HMD11026", quantity: 4 },
      { article_code: "HMD10027", quantity: 2 },
    ];
    const plan = mergeNewProformaArticles(oldPlan, editedProforma, true);
    const jogging = plan.find((line) => line.article_code === "HMD10027");
    expect(jogging?.quantity).toBe(2);
    expect(jogging!.quantity - 1).toBe(1);
  });

  it("keeps per-loading quantities while adding codes missing from the snapshot", () => {
    const plan = mergeNewProformaArticles(saved, master, true);
    expect(plan).toHaveLength(3);
    expect(plan.map((line) => [line.article_code, line.quantity])).toEqual([
      ["HMD11026", 4],
      ["HMD10027", 0],
      ["HMD12101", 5],
    ]);
  });

  it("does not change completed loading snapshots", () => {
    expect(mergeNewProformaArticles(saved, master, false)).toEqual(saved);
  });

  it("uses the current proforma if a loading has no saved plan", () => {
    expect(mergeNewProformaArticles([], master, true)).toEqual(master);
  });

  it("updates open expected rows at proforma-add time and includes legacy missing rows on reads", () => {
    const add = read("server/routes/factory/customer-proformas/lines.ts");
    const verify = read("server/routes/factory/customer-orders/verify-recover/verification-summary.ts");
    const scanner = read("server/routes/factory/customer-orders/proformaCapacity.ts");
    expect(add).toContain("INSERT INTO customer_order_expected_lines");
    expect(add).toContain("ON CONFLICT (order_id, article_code) DO NOTHING");
    expect(add).toContain("co.status IN ('DRAFT', 'LOADING', 'PENDING_VERIFICATION', 'VERIFIED')");
    expect(verify).toContain("mergeNewProformaArticles(");
    expect(scanner).toContain("LOWER(TRIM(expected.article_code)) = LOWER(TRIM(cpl.article_code))");
  });
});
