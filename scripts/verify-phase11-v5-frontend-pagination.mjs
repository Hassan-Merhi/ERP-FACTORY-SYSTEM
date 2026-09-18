#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

const ROOT = process.cwd();
const read = (relativePath) => fs.readFile(path.join(ROOT, relativePath), "utf8");

const [main, client, server, plugin, source] = await Promise.all([
  read("client/src/main.tsx"),
  read("client/src/lib/v5AllocationPaginationClient.ts"),
  read("server/routes/factory/factoryStockAllocationV5PaginationRoutes.ts"),
  read("build/viteHeavyListPaginationPlugin.ts"),
  read("client/src/pages/factory/FactoryStockAllocationV5.tsx"),
]);

assert.match(main, /import "\.\/lib\/v5AllocationPaginationClient";/, "main.tsx must install V5 pagination");
assert.match(client, /const ENDPOINT = "\/api\/factory\/v5\/stock-allocation";/, "V5 endpoint must be targeted");
assert.match(client, /const DEFAULT_LIMIT = 50;/, "V5 screen default must remain 50 rows");
assert.match(server, /const DEFAULT_PAGE_SIZE = 50;/, "V5 server default must remain 50 rows");
assert.match(server, /const MAX_PAGE_SIZE = 250;/, "V5 server must cap paginated requests at 250 rows");
assert.match(client, /fullAction/, "explicit full-data requests need an interceptor bypass marker");
assert.match(client, /fetchAllV5AllocationData/, "all-pages loader is required for business actions");
assert.match(client, /for \(let page = 2; page <= totalPages; page \+= 1\)/, "all-pages loader must fetch every page");
assert.match(client, /hasFocusedDeepLink\(\)/, "focused proforma links must bypass normal paging");
assert.match(client, /negativeOnlyMode \|\| hasFocusedDeepLink\(\)/, "global Negative Only and deep links must stay full-data");
assert.match(client, /button-v5-toggle-negative-only/, "Negative Only mode changes must be observed");
assert.match(client, /const pageCache = new Map<number, V5AllocationData>\(\)/, "progressive pages must be cached client-side");
assert.match(client, /handleProgressiveScroll/, "stock allocation must progressively load as the user scrolls");
assert.match(client, /AUTOLOAD_THRESHOLD_PX/, "progressive loading must use a near-bottom threshold");
assert.match(client, /v5-allocation-progress/, "progressive loading status must be available");
assert.match(client, /scroll to load more/, "the progressive loading status must explain the interaction");
// The merged body used to be serialized inline. It moved into one helper so
// the out-of-range path answers in the same shape instead of leaking the raw
// envelope; both call sites are pinned below, which covers more of the
// contract than the single inline literal did.
assert.match(
  client,
  /function allocationResponse\(response: Response, data: V5AllocationData\): Response/,
  "the legacy V5 response shape must be produced in one place"
);
assert.match(client, /JSON\.stringify\(data\)/, "the merged V5 body must be serialized into the response");
assert.match(client, /return allocationResponse\(response, merged\);/, "progressive pages must be merged into the legacy V5 response shape");
assert.match(
  client,
  /return allocationResponse\(response, mergeCachedPages\(anchor\)\);/,
  "an out-of-range page must answer from the loaded pages, never the raw envelope"
);
assert.doesNotMatch(client, /v5-allocation-page-next/, "manual Next pagination must stay removed");
assert.doesNotMatch(client, /v5-allocation-page-previous/, "manual Previous pagination must stay removed");
assert.doesNotMatch(client, /v5-allocation-page-size/, "manual page-size pagination must stay removed");
assert.match(client, /handleRouteState/, "route changes must reset transient bridge modes");

assert.match(
  plugin,
  /V5_ALLOCATION_MODEL_SUFFIX|V5_ALLOCATION_COMPONENT_SEGMENT/,
  "Vite plugin must target the split V5 allocation screen"
);
assert.match(plugin, /fetchAllV5AllocationData/, "V5 transform must import the complete-data loader");
assert.match(plugin, /openCreateDrawerWithAllRows/, "create drawer must wait for complete rows");
assert.match(plugin, /openEditDrawerWithAllRows/, "edit drawer must wait for complete rows");
assert.match(plugin, /const currentRows = actionRows \?\? \(await loadAllActionRows\(\)\)/, "draft quantity editing must use complete rows");
assert.match(plugin, /const complete = await fetchAllV5AllocationData\(exportParams\)/, "Excel must load all filtered pages");
assert.match(plugin, /setActionRows\(null\)/, "drawer completion must release complete row references");
assert.match(plugin, /Missing transform target/, "source drift must fail loudly");
assert.match(plugin, /Ambiguous transform target/, "ambiguous replacements must fail loudly");

const exactSourceMarkers = [
  'import { apiRequest, queryClient } from "@/lib/queryClient";',
  'function openEditDraft(proformaId: number, proformaName: string, currentRows: V5Row[]) {',
  'const filtered = rows.filter((r) => {',
  'onClick={() => setCreateDrawerOpen(true)}',
  'onClick={() => setEditDrawerProformaId(proforma.proformaId)}',
  'onClose={() => setCreateDrawerOpen(false)}',
  'onClose={() => setEditDrawerProformaId(null)}',
];
const sourceWithModel = `${source}\n${await read("client/src/pages/factory/factorystockallocationv5/useFactoryStockAllocationV5Model.tsx")}`;
for (const marker of exactSourceMarkers) {
  const first = sourceWithModel.indexOf(marker);
  assert.ok(first >= 0, `Missing exact V5 source marker: ${marker}`);
  assert.equal(
    sourceWithModel.indexOf(marker, first + marker.length),
    -1,
    `Ambiguous V5 source marker: ${marker}`
  );
}

console.log(
  JSON.stringify(
    {
      ok: true,
      checks: [
        "V5 startup wiring",
        "normal 50-row initial payload",
        "server 50-row default",
        "server 250-row cap",
        "progressive scroll loading",
        "client-side cumulative page merge",
        "no manual next/previous controls",
        "all-pages action loader",
        "focused deep-link bypass",
        "global Negative Only preservation",
        "route-state reset",
        "complete create/edit/draft rows",
        "complete filtered Excel export",
        "large action-reference cleanup",
        "fail-loud source transforms",
      ],
    },
    null,
    2
  )
);
