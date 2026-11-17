import { describe, expect, it } from "vitest";

import { columnDefinition, indexDefinition } from "./helpers/schemaManifest";

// The multilingual catalog columns used to be ensured at boot by
// server/factoryBilingualSchemaBridge.mjs; migrations now define them.
const FACTORY_BILINGUAL_COLUMNS: ReadonlyArray<readonly [string, string, string]> = [
  ["factory_categories", "name_ar", "character varying(100)"],
  ["factory_bale_products", "name_ar", "text"],
  ["factory_bale_products", "description_ar", "text"],
  ["factory_bales", "product_name_ar", "text"],
  ["factory_bales", "category_ar", "text"],
  ["customer_proforma_lines", "product_name_ar", "text"],
  ["customer_order_lines", "bale_name_ar", "text"],
  ["customer_order_bales", "bale_name_ar", "text"],
  ["customer_order_bales_history", "bale_name_ar", "text"],
  ["customer_order_expected_lines", "product_name_ar", "text"],
  ["factory_pos_sale_items", "product_name_ar", "text"],
  ["customer_order_bale_removals", "product_name_ar", "text"],
  ["factory_v3_load_bales", "product_name_ar", "text"],
  ["factory_invoice_loading_bales", "product_name_ar", "text"],
  ["customer_dispatch_bale_scans", "product_name_ar", "text"],
  ["bale_recode_items", "product_name_ar", "text"],
];

describe("Factory bilingual schema contract", () => {
  it("migrations define every multilingual snapshot column", () => {
    for (const [table, column, type] of FACTORY_BILINGUAL_COLUMNS) {
      expect(columnDefinition(table, column)?.type, `${table}.${column}`).toBe(type);
    }
  });

  it("migrations define the canonical normalized article code index", () => {
    expect(indexDefinition("factory_bale_products_company_article_code_normalized_idx")).toBe(
      "CREATE INDEX factory_bale_products_company_article_code_normalized_idx ON public.factory_bale_products USING btree (company_id, upper(btrim(article_code)))"
    );
  });
});
