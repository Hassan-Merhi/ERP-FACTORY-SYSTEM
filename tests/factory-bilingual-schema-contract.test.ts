import { describe, expect, it } from "vitest";

import { FACTORY_BILINGUAL_ARTICLE_INDEX, FACTORY_BILINGUAL_COLUMNS } from "../server/factoryBilingualSchemaBridge.mjs";

// The bilingual bridge verifies schema as an import side effect, so this
// contract lives in a mock-free file: suites that mock `pg` cannot import
// the bridge without crashing on its startup ensure.
describe("Factory bilingual schema contract", () => {
  it("verifies required multilingual columns definition", () => {
    expect(FACTORY_BILINGUAL_COLUMNS.length).toBeGreaterThan(10);
    const articleCol = FACTORY_BILINGUAL_COLUMNS.find(
      ([table, col]) => table === "factory_bales" && col === "product_name_ar"
    );
    expect(articleCol).toBeDefined();
  });

  it("verifies canonical normalized article code index name", () => {
    expect(FACTORY_BILINGUAL_ARTICLE_INDEX).toBe("factory_bale_products_company_article_code_normalized_idx");
  });
});
