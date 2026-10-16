#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

const ROOT = process.cwd();

async function read(relativePath) {
  return fs.readFile(path.join(ROOT, relativePath), "utf8");
}

const [
  main,
  accountingGuard,
  viteConfig,
  vitePlugin,
  stockEntrySource,
  stockEntryReports,
  stockEntryReportsLegacy,
  stockEntryRoute,
] =
  await Promise.all([
    read("client/src/main.tsx"),
    read("client/src/lib/accountingRequestFetchGuard.ts"),
    read("vite.config.ts"),
    read("build/viteHeavyListPaginationPlugin.ts"),
    read("client/src/pages/StockEntryHistory.tsx"),
    read("client/src/pages/stockentryhistory/reports.ts"),
    read("client/src/pages/stockentryhistory/reportsLegacy.ts"),
    read("server/routes/factory/factoryStockEntryHistoryPaginationRoutes.ts"),
  ]);

assert.match(main, /import "\.\/lib\/accountingRequestFetchGuard";/, "main.tsx must install the accounting request guard");
assert.doesNotMatch(
  accountingGuard,
  /import "\.\/heavyListPaginationClient";/,
  "Stock Entry History must not install the floating Previous/Next pagination client"
);

assert.match(
  stockEntrySource,
  /useInfiniteQuery<StockEntryHistoryPage, Error>\(/,
  "Stock Entry History must load its date-range dataset through bounded infinite pages"
);
assert.match(
  stockEntrySource,
  /getNextPageParam: \(lastPage\) => lastPage\.hasNextPage \? lastPage\.page \+ 1 : undefined/,
  "Stock Entry History must keep fetching pages until the server reports no next page"
);
assert.match(
  stockEntrySource,
  /const groups: GroupRow\[\] = useMemo\(\(\) => historyPages\?\.pages\.flatMap\(\(page\) => page\.items\) \?\? \[\]/,
  "Stock Entry History must consume every loaded page"
);
assert.match(stockEntrySource, /const useLite = viewMode === "condensed";/, "condensed mode must retain its lite payload");
assert.match(stockEntrySource, /if \(useLite\) params\.set\("lite", "1"\);/, "detailed mode must retain full rows");

assert.match(
  stockEntryRoute,
  /const SCREEN_FULL_LOAD_LIMIT = 9999;/,
  "the Stock Entry History route must explicitly allow the full-screen sentinel"
);
assert.match(
  stockEntryRoute,
  /requestedLimit === SCREEN_FULL_LOAD_LIMIT \? SCREEN_FULL_LOAD_LIMIT : Math\.min\(MAX_PAGE_SIZE, requestedLimit\)/,
  "the normal API cap must remain while the Stock Entry History screen can load its complete result"
);

assert.match(viteConfig, /heavyListPaginationPlugin\(\)/, "Vite must retain export-safety transforms for heavy lists");
assert.match(
  stockEntryReports,
  /groupsWithBales\.map/,
  "Stock Entry History export must use the complete filtered groups"
);
assert.match(vitePlugin, /Missing transform target/, "transform drift must fail loudly");
assert.match(vitePlugin, /Ambiguous transform target/, "ambiguous transforms must fail loudly");

const originalSummaryMarker = "const summaryRows = filteredGroups.map((g) => ({";
const fullFetchMarker = "const groupsWithBales = await fetchGroupsWithBales();";
assert.ok(
  stockEntryReportsLegacy.includes(originalSummaryMarker),
  "source marker for the exact transform must still exist"
);
assert.ok(
  stockEntryReports.includes(fullFetchMarker),
  "Stock Entry History source must retain the full export fetch marker"
);

console.log(
  JSON.stringify(
    {
      ok: true,
      checks: [
        "floating Stock Entry History pagination UI disabled",
        "bounded infinite-page Stock Entry History screen load",
        "normal API page-size cap preserved for other callers",
        "condensed/detailed payload mode preservation",
        "full-data Excel summary transform",
        "transform drift guards",
      ],
    },
    null,
    2
  )
);
