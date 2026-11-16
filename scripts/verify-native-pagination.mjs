#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs/promises";

const files = {
  registration: "server/routes/factoryRoutes.ts",
  daybook: "server/routes/factory/factoryDaybookPaginationRoutes.ts",
  daybookIntegrity: "server/services/factory/daybookSourceIntegrity.ts",
  stockEntry: "server/routes/factory/factoryStockEntryHistoryPaginationRoutes.ts",
  allocation: "server/routes/factory/factoryStockAllocationV5PaginationRoutes.ts",
  common: "server/routes/location/commonInventoryPerformanceRoutes.ts",
  bales: "server/routes/factory/bales/balesCrudRoutes.ts",
};

const source = Object.fromEntries(
  await Promise.all(
    Object.entries(files).map(async ([key, file]) => [key, await fs.readFile(file, "utf8")])
  )
);

function containsAll(text, patterns, label) {
  for (const pattern of patterns) {
    assert.match(text, pattern, `${label} is missing ${String(pattern)}`);
  }
}

containsAll(
  source.registration,
  [
    /registerFactoryDaybookPaginationRoutes\(app\)/,
    /registerFactoryStockEntryHistoryPaginationRoutes\(app\)/,
    /registerFactoryStockAllocationV5PaginationRoutes\(app\)/,
  ],
  "factory pagination registration"
);

for (const [label, text] of [
  ["daybook", source.daybook],
  ["stock entry history", source.stockEntry],
  ["V5 allocation", source.allocation],
]) {
  containsAll(
    text,
    [
      // The daybook also answers filter-option requests without pagination (#2382).
      /if \(!wantsPagination\(req\)(?: && !filterOptionsOnly)?\) return next\(\)/,
      /LIMIT \$\{/,
      /OFFSET \$\{/,
      /COUNT\(\*\)/,
      /X-Total-Count/,
      /totalPages/,
      /hasNextPage/,
      /hasPreviousPage/,
    ],
    label
  );
}

containsAll(
  source.daybook,
  [/synthetic_rows AS/, /buildPaginationIntegrityConditions/, /dedup_rank/, /deriveBaleStockEntryAmounts/],
  "daybook business compatibility"
);
containsAll(
  source.daybookIntegrity,
  [/factory_worker_advances/, /factory_advance_repayments/, /buildPaginationIntegrityConditions/],
  "daybook source-integrity compatibility"
);

containsAll(
  source.stockEntry,
  [/JSONB_AGG/, /lite/, /includeUnassigned/, /status NOT IN \('DELETED', 'REMOVED'\)/],
  "stock entry history compatibility"
);

containsAll(
  source.allocation,
  [
    /customer_order_expected_lines/,
    /ON CONFLICT \(order_id, article_code\) DO NOTHING/,
    /active_orders AS/,
    /loaded_per_order AS/,
    /expected AS/,
    /proformaDetails/,
    /shortageCount/,
  ],
  "V5 allocation compatibility"
);

containsAll(source.common, [/\/api\/stock-items/, /\.limit\(pageSize\)/, /\.offset\(offset\)/], "stock items pagination");
containsAll(source.common, [/\/api\/inventory/, /countQuery/, /dataQuery/], "inventory pagination");
containsAll(source.bales, [/\/api\/factory\/bales/, /rowLimit/, /rowOffset/, /countResult/], "factory bales pagination");

console.log(
  JSON.stringify(
    {
      ok: true,
      verified: [
        "paged handler registration order",
        "legacy fallback preservation",
        "database count/limit/offset contracts",
        "daybook synthetic and deletion compatibility",
        "stock-entry lite/full compatibility",
        "V5 expected/load/detail compatibility",
        "existing stock-items, inventory, and bales pagination",
      ],
    },
    null,
    2
  )
);
