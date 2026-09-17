#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

const ROOT = process.cwd();
const read = (relativePath) => fs.readFile(path.join(ROOT, relativePath), "utf8");

const [client, plugin, source] = await Promise.all([
  read("client/src/lib/daybookPaginationClient.ts"),
  read("build/viteHeavyListPaginationPlugin.ts"),
  read("client/src/pages/factory/FactoryDaybook.tsx"),
]);

assert.match(
  plugin,
  /import \{ fetchAllDaybookEntries \} from "@\/lib\/daybookPaginationClient";/,
  "the Daybook transform must install its complete-data client"
);
assert.match(client, /const ENDPOINT = "\/api\/factory\/daybook";/, "Daybook endpoint must be targeted");
assert.match(client, /const DEFAULT_LIMIT = 100;/, "Daybook initial page size must remain 100");
assert.match(client, /fetchAllDaybookEntries/, "complete export loader is required");
assert.match(client, /for \(let page = 2; page <= totalPages; page \+= 1\)/, "complete loader must fetch every page");
assert.match(client, /entryId/, "entry deep links must bypass normal paging");
assert.match(client, /voucherId/, "voucher deep links must bypass normal paging");
assert.match(client, /const pageCache = new Map<number, DaybookPage>\(\)/, "progressive daybook pages must be cached client-side");
assert.match(client, /handleProgressiveScroll/, "daybook must progressively load as the user scrolls");
assert.match(client, /AUTOLOAD_THRESHOLD_PX/, "progressive loading must use a near-bottom threshold");
assert.match(client, /factory-daybook-progress/, "progressive loading status must be available");
assert.match(client, /scroll to load more/, "progressive loading status must explain the interaction");
assert.match(client, /JSON\.stringify\(entries\)/, "the cumulative Daybook array contract must be preserved");
assert.doesNotMatch(client, /factory-daybook-page-previous/, "manual Previous pagination must stay removed");
assert.doesNotMatch(client, /factory-daybook-page-next/, "manual Next pagination must stay removed");
assert.doesNotMatch(client, /factory-daybook-page-size/, "manual page-size pagination must stay removed");
assert.match(client, /handleRouteState/, "route changes must clear transient paging state");

assert.match(
  plugin,
  /FACTORY_DAYBOOK_MODEL_SUFFIX|FACTORY_DAYBOOK_SHELL_SUFFIX/,
  "Vite plugin must target the split FactoryDaybook implementation"
);
assert.match(plugin, /queryParams\.set\("startDate", startDate\)/, "startDate must always be present");
assert.match(plugin, /queryParams\.set\("endDate", endDate\)/, "endDate must always be present");
assert.match(plugin, /All Time/, "empty dates must preserve All Time instead of backend today defaults");
assert.match(plugin, /optionalStatus/, "optional-status filtering must be sent to the server");
assert.match(plugin, /debouncedSearchQuery\.trim\(\)/, "debounced search must be sent to the server");
assert.match(plugin, /queryParams\.set\("minAmount"/, "minimum amount must be sent to the server");
assert.match(plugin, /queryParams\.set\("maxAmount"/, "maximum amount must be sent to the server");
assert.match(plugin, /queryParams\.set\("sortOrder"/, "sort direction must be sent to the server");
assert.match(plugin, /fetchAllDaybookEntries/, "both export modes must use the complete loader");
assert.match(
  plugin,
  /exportFactoryDaybookSummary\(exportEntries, formatDisplayDate\)/,
  "summary export must use complete entries"
);
assert.match(
  plugin,
  /exportFactoryDaybookDetailed\(exportEntries, formatDisplayDate\)/,
  "detailed export must use complete entries"
);
assert.match(plugin, /entry\.txType !== "WORKER_EDITED"/, "existing worker-edit exclusion must be preserved");
assert.match(plugin, /Missing transform target/, "source drift must fail loudly");
assert.match(plugin, /Ambiguous transform target/, "ambiguous replacements must fail loudly");

const exactMarkers = [
  'import { queryClient } from "@/lib/queryClient";',
  'queryParams.set("startDate", startDate || "");',
  'queryParams.set("endDate", endDate || "");',
  'queryKey: ["/api/factory/daybook", startDate, endDate, txTypeFilter, currencyFilter],',
  'const handleExportToExcel = async () => {',
  'const handleExportDetailedToExcel = async () => {',
  "exportFactoryDaybookDetailed(filteredEntries, formatDisplayDate)",
];
const sourceWithModel = `${source}\n${await read("client/src/pages/factory/daybook/useFactoryDaybookModel.ts")}`;
for (const marker of exactMarkers) {
  const first = sourceWithModel.indexOf(marker);
  assert.ok(first >= 0, `Missing exact Daybook source marker: ${marker}`);
  assert.equal(
    sourceWithModel.indexOf(marker, first + marker.length),
    -1,
    `Ambiguous Daybook source marker: ${marker}`
  );
}

console.log(
  JSON.stringify(
    {
      ok: true,
      checks: [
        "Daybook startup wiring",
        "100-row initial payload",
        "progressive scroll loading",
        "client-side cumulative page merge",
        "All Time empty-date preservation",
        "legacy array compatibility",
        "no manual next/previous controls",
        "server-side search/status/amount/sort filters",
        "entry and voucher deep-link bypass",
        "complete summary export",
        "complete detailed export",
        "worker-edit exclusion preservation",
        "route-state reset",
        "fail-loud source transforms",
      ],
    },
    null,
    2
  )
);
