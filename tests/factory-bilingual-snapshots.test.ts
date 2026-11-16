import { describe, expect, it } from "vitest";
import {
  FACTORY_BILINGUAL_SNAPSHOT_TARGETS,
} from "../server/services/factoryBilingualSnapshotService";

const expectedTargets = new Map([
  ["factory_bales", "product_name_ar"],
  ["customer_proforma_lines", "product_name_ar"],
  ["customer_order_lines", "bale_name_ar"],
  ["customer_order_bales", "bale_name_ar"],
  ["customer_order_bales_history", "bale_name_ar"],
  ["customer_order_expected_lines", "product_name_ar"],
  ["factory_pos_sale_items", "product_name_ar"],
  ["customer_order_bale_removals", "product_name_ar"],
  ["factory_v3_load_bales", "product_name_ar"],
  ["factory_invoice_loading_bales", "product_name_ar"],
  ["customer_dispatch_bale_scans", "product_name_ar"],
  ["bale_recode_items", "product_name_ar"],
]);

describe("Factory bilingual Phase 6 snapshot contract", () => {
  it("covers every Arabic snapshot column added in Phase 2", () => {
    expect(
      new Map(FACTORY_BILINGUAL_SNAPSHOT_TARGETS.map((target) => [target.table, target.arabicColumn]))
    ).toEqual(expectedTargets);
  });

  it("resolves by product ID before exact article code and never by name", () => {
    for (const target of FACTORY_BILINGUAL_SNAPSHOT_TARGETS) {
      expect(target.companyExpression).toBeTruthy();
      expect(target.productIdExpression || target.articleCodeExpression).toBeTruthy();
      expect(target.productIdExpression).not.toMatch(/name/i);
      expect(target.articleCodeExpression).not.toMatch(/name/i);
    }
  });

  it("marks immutable historical targets as finalized", () => {
    const history = FACTORY_BILINGUAL_SNAPSHOT_TARGETS.find(
      (target) => target.table === "customer_order_bales_history"
    );
    const pos = FACTORY_BILINGUAL_SNAPSHOT_TARGETS.find(
      (target) => target.table === "factory_pos_sale_items"
    );
    expect(history?.finalizedExpression).toBe("true");
    expect(pos?.finalizedExpression).toBe("true");
  });
});
