import { describe, expect, it } from "vitest";

import { buildNotFinalizedClause } from "../server/services/factory/historical-replay/scope";
import { parseBoundedPagination } from "../server/lib/boundedPagination";

describe("Phase 1 coverage certification boundaries", () => {
  it("keeps backend paging bounded at the configured maximum", () => {
    expect(parseBoundedPagination({ page: "2", limit: "9999" }, { defaultLimit: 100, maxLimit: 250 })).toEqual({
      page: 2,
      limit: 250,
      offset: 250,
    });
  });

  it("keeps finalized factory bales excluded from the default replay repair scope", () => {
    const clause = buildNotFinalizedClause(false);

    expect(clause).toContain("dispatch_batch_id IS NULL");
    expect(clause).toContain("customer_order_bales");
    expect(clause).toContain("factory_invoice_loading_bales");
  });
});
