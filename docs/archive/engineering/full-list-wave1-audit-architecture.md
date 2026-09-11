# Full-list loading — Wave 1 audit and architecture

Status: **Wave 1 complete (static repository audit + architecture decision)**  
Branch: `perf/full-list-wave1-audit-architecture`  
Base audited: `main` at `74580ac12124064f9150cab380071d69558d3afe`  
Scope: Daybook, Accounts statements, and Tracking > Containers OTW.  

This record deliberately makes **no screen-behaviour change**. Its purpose is to freeze the current implementation, identify the performance and accounting dependencies behind the visible pagination controls, and define the architecture that later waves must follow before those controls are removed.

## User-visible target

The eventual UI target is one continuous list on each scoped surface:

- no Previous button;
- no Next button;
- no Rows selector;
- no `Page X of Y` control;
- first rows appear quickly;
- remaining rows become available automatically;
- totals, balances, filters, exports, permissions and edits continue to operate over the complete filtered result set;
- no background polling or repeated full-dataset request loop is introduced.

"Full list" means a continuous user experience. It does **not** mean one unbounded SQL query followed by rendering every record into the DOM at once.

## 1. Current implementation baseline

| Surface | Screen request | Current screen size | Pagination implementation | Server work | Important full-data behaviour |
|---|---|---:|---|---|---|
| ERP Daybook | `GET /api/daybook` after the Vite pagination transform | 100 default, 250 max | page + OFFSET; build-time transform injects Previous/Next/Rows | unified voucher + offload CTE, count and page slice | exports already walk 250-row pages |
| Account statement | `GET /api/accounts/:kind/:id/transactions` | 100 default, 250 max | global fetch interceptor injects page + limit and fixed DOM controls | page query + full-period summary + preceding-page net | server already returns full-period debit, credit and closing metadata |
| Tracking > Containers OTW | `GET /api/git/containers` | 50 | React page state + shared `PaginationBar` | server currently fetches, enriches, filters and sorts the full active-container set, then slices it in memory | summary/facets are calculated from the complete filtered set |
| Factory/Properties Daybook (adjacent) | `GET /api/factory/daybook` | 100 default, 250 max | global fetch interceptor + fixed DOM controls | paginated route | explicit export helper walks all 250-row pages |

### Static performance baseline

The current repository establishes the following pre-change workload characteristics. These are the baseline characteristics later waves must improve or preserve:

1. Daybook and account statements use OFFSET-based page navigation, so deep pages require increasing skip work.
2. Account statement pages additionally calculate a preceding-page net for non-first pages. Repeatedly auto-loading page 1, 2, 3 ... using the current implementation would repeatedly process an increasing prefix of the statement.
3. Tracking pagination currently limits payload and browser DOM size, but it does **not** limit the principal server-side list workload: the handler loads all active containers for the resolved company scope, enriches them, builds facets, filters and sorts the full array, then slices the selected page.
4. Tracking's table maps every supplied container into a React table row; there is no row virtualization in the audited component.
5. Account and factory/properties Daybook pagination clients install route-state code globally. The account client and factory/properties Daybook client each contain a one-second route-state interval. That is not API polling, but it is avoidable idle browser work that can disappear when those interceptors are retired.
6. React Query cancellation already exists in the native Daybook/Tracking hooks, and Tracking has explicit stale-company AbortError recovery. Later waves must preserve this behaviour rather than replacing it with a fire-and-forget batch loop.

No production latency number is invented in this audit. A runtime p50/p95 and payload-size capture must be taken immediately before Wave 2 changes against the explicitly chosen Render workspace/environment; selecting a production workspace is an operational action and is intentionally not inferred by this record.

## 2. Daybook audit

### Shipped/build-time path

`Daybook.tsx` does not fully describe the code that ships. `build/vitePhase1PaginationPlugin.ts` rewrites the component during the Vite build. The transform:

- changes the screen model to `/api/daybook`;
- injects page and page-size state;
- injects Previous/Next/Rows controls;
- changes the displayed row source;
- changes Excel export to use the complete `/api/daybook` helper;
- adds `/api/daybook` invalidation after mutations.

This means removing only the visible `PaginationBar` from the source file would **not** remove the actual shipped pagination path. Wave 2/3 must migrate the behaviour out of the build-time string transform first or update the transform and source atomically.

### `/api/daybook`

The native route combines voucher and offload rows, then orders the combined data by this stable tuple:

1. effective/voucher date (`sort_date`), in the requested direction;
2. voucher/offload type rank ascending;
3. record id (`sort_id`), in the requested direction.

It currently performs `LIMIT ... OFFSET ...` and also counts the complete combined set. Default page size is 100; maximum page size is 250.

The existing tuple is sufficient to define a deterministic keyset cursor. No additional user-visible sort rule is required.

### Daybook filters that must remain server authoritative

- company/session scope;
- start and end date;
- voucher type;
- active/optional status;
- text search, including voucher number, description and location name;
- minimum amount;
- maximum amount;
- POS location restrictions;
- requested sort direction.

Exports already have an explicit full-data helper and must remain independent from the number of rows currently rendered on screen.

### Source/build divergence risk

The source-level `usePaginatedDaybookVouchers()` path and `/api/vouchers` pagination route are still present even though the build transform replaces the Daybook query block for the shipped screen. Their parameter vocabulary also differs from the transformed path. Wave 2 must avoid creating a third competing Daybook list contract. The target is one explicit screen data path, with compatibility helpers retained only for known callers.

## 3. Accounts audit

### Client interception

`accountStatementPaginationClient.ts` globally wraps `window.fetch` while the Accounts route is active. It:

- detects account transaction endpoints;
- appends `pagination=1`, `page` and `limit`;
- defaults to 100 rows and permits 50/100/250;
- creates a fixed-position pagination control directly under `document.body`;
- stores a statement metadata snapshot;
- invalidates the active account statement query when the user changes page;
- checks route state once per second.

The pagination controls therefore are not owned by the account statement React component itself.

### Financial dependency that cannot be removed blindly

The Vite pagination plugin rewrites `AccountStatementView.tsx` to subscribe to the global pagination snapshot. That injected metadata is used for:

- complete-period transaction count;
- complete-period debit total;
- complete-period credit total;
- complete-period closing balance.

Without replacing that metadata path, simply deleting the pagination interceptor would make the source component fall back to calculations over only the rows currently passed into the table. Wave 2 must move these aggregates into the explicit query response/model before the interceptor is retired.

### Server statement workload

The statement route already produces useful full-period metadata. For voucher-entry statements it executes, in parallel where applicable:

- the current page query;
- a complete-period COUNT/SUM summary;
- a preceding-page net query;
- plus a pre-period net query when a start date is supplied.

Stable ordering is already present:

- ledger: `sort_date, sort_id`;
- bank/fixed-asset/supplier/employee: `sort_date, sort_id, sort_entry_id`;
- customer balance rows follow the same date/id principle.

The route currently uses OFFSET. Auto-fetching every current page would magnify the preceding-prefix work, so Wave 2 must not implement continuous loading by looping the existing page API unchanged.

### Index inventory from the schema

The audited schema declares:

- `vouchers_company_idx(company_id)`;
- `vouchers_company_date_idx(company_id, voucher_date)`;
- `voucher_entries_voucher_idx(voucher_id)`;
- `voucher_entries_customer_idx(customer_id)`;
- `voucher_entries_ledger_account_idx(ledger_account_id)`;
- `voucher_entries_ledger_voucher_idx(ledger_account_id, voucher_id)`.

No schema-declared composite account/voucher indexes were found for `bank_account_id`, `fixed_asset_id`, `supplier_id`, or `employee_id` in the audited `voucher_entries` definition. These are **candidates only**, not Wave 1 migrations. Wave 2 must confirm real PostgreSQL indexes and `EXPLAIN (ANALYZE, BUFFERS)` before adding any index.

Candidate shapes to evaluate later:

- `(bank_account_id, voucher_id)`;
- `(fixed_asset_id, voucher_id)`;
- `(supplier_id, voucher_id)`;
- `(employee_id, voucher_id)`.

The effective-date ordering also deserves an execution-plan check because current voucher indexing is on `voucher_date`, while statement ordering uses `COALESCE(effective_date, voucher_date)`.

## 4. Tracking audit

The `/tracking` route is a tabbed hub. This Wave 1 scope is the default **Containers OTW** tab, which mounts `TrackingContainersTab` and then `GITContainers`.

### Client path

`GITContainers` currently:

- keeps page state locally;
- uses 50 rows per page;
- resets page to 1 whenever a filter changes;
- requests a compact profile from `/api/git/containers`;
- uses debounced search;
- includes page and page size in the company-scoped React Query key;
- passes the request AbortSignal into `fetch`;
- keeps server summary/facets when available;
- renders the current page through `ContainerTable`;
- renders the shared React `PaginationBar`.

`TrackingContainersTab` already cancels/removes stale company-scoped queries and recovers AbortErrors once. This behaviour is part of the future continuous-list contract.

### Server path — critical performance finding

`/api/git/containers` does not currently page at the database boundary. The handler:

1. resolves allowed company scope;
2. fetches active containers for that scope;
3. loads company names;
4. enriches the full container set;
5. builds facets;
6. applies table filters to the complete array;
7. sorts the complete array;
8. builds the complete filtered summary;
9. only then slices the requested page.

Therefore a naive frontend loop that requests page 1, 2, 3 ... would repeat almost the full server workload for every page. That is specifically prohibited for Wave 2.

### Rendering risk

`ContainerTable` currently uses a normal `containers.map(...)` to create all supplied table rows. Full-list loading cannot safely become "fetch everything and render everything" as data grows. The later frontend wave must introduce virtualization or equivalent bounded rendering while preserving inline-edit controls, links, drawer opening, sticky headers and printing/export semantics.

## 5. Shared architecture decision

All three surfaces will move toward the same conceptual contract even if their response metadata differs.

### Continuous chunk envelope

The row-loading portion of a response should follow this model:

```ts
interface ContinuousChunk<T, TCursor> {
  items: T[];
  total: number;
  hasMore: boolean;
  nextCursor: TCursor | null;
  asOf?: string;
}
```

Surface-specific metadata remains explicit rather than being smuggled through global browser state. Examples:

```ts
interface AccountChunkMeta {
  periodDebitTotal: number;
  periodCreditTotal: number;
  periodPreNetBalance: number;
  closingNetBalance: number;
  chunkOpeningNet: number;
}
```

Tracking may additionally return summary/facet metadata independently from row chunks.

### Cursor definitions

**Daybook**

Cursor must encode the complete current sort tuple and direction:

```text
sortDate + typeRank + sortId + direction
```

**Accounts**

Cursor must encode:

```text
sortDate + sortId [+ sortEntryId]
```

A chunk must include the running-net value immediately before its first row (or an equivalent server-derived starting balance), so the client can calculate row running balances without scanning every earlier page again.

**Tracking**

Do not emulate a cursor by repeatedly invoking the current in-memory paged handler. Wave 2 must first move row-window selection closer to the data source or otherwise ensure that advancing the cursor does not refetch/re-enrich the complete container set for every chunk. Full summary/facet calculation may remain a separate bounded metadata operation.

### Client loading model

Later frontend work should use one reusable continuous-query abstraction with these guarantees:

- company identity is part of the cache key;
- all filter values are canonicalized into the key;
- the first chunk renders without waiting for the rest;
- next chunks fetch automatically;
- an AbortSignal reaches every chunk request;
- a filter/company/account change cancels obsolete requests;
- late responses cannot append into a new filter scope;
- rows are deduplicated by a stable identity;
- failed later chunks do not erase already loaded rows;
- no interval/polling loop is used to advance chunks;
- cache invalidation after mutations targets the exact API family/company scope.

The implementation can use React Query's infinite-query model or an equivalent repository-native wrapper, but the behavioural contract above is the requirement.

## 6. Aggregate and balance contract

A core rule for all later waves:

> Aggregate correctness must never depend on how many chunks are currently downloaded or how many rows are currently mounted in the DOM.

### Daybook

Any complete-period totals shown in the UI must come from server aggregate metadata or a dedicated aggregate request, not `loadedRows.reduce(...)` unless the response is explicitly confirmed complete.

### Accounts

The server remains authoritative for period debit, period credit, pre-period net and closing net. Running row balances use a server-provided chunk opening net plus the rows within the chunk.

### Tracking

Summary cards and filter facets remain calculated for the complete filtered/scope dataset, not the visible chunk. Row count text uses server `total`.

## 7. Export, print and bulk-action contract

Removing pagination cannot silently narrow actions to only mounted/visible virtual rows.

- Daybook Excel export remains complete and server/filter scoped.
- Account PDF and Excel statement endpoints remain complete and period scoped.
- Tracking print/export must not rely on a virtualized DOM snapshot if the intended action is "all filtered rows".
- Tracking bulk operations that currently use server totals must continue to target the intended complete scope.
- Explicit row selections remain row-id based, not viewport-index based.

## 8. Build-time transform cleanup dependency

Current pagination behaviour is partly introduced through Vite source-string transforms and partly through global fetch monkeypatches. That makes a visual-only removal unsafe.

Required migration order in later waves:

1. expose explicit query metadata to React components;
2. introduce cursor-capable server contracts;
3. add the shared continuous-query model;
4. move Daybook/Accounts off pagination-specific build transforms/global snapshot state;
5. only then remove visible controls and obsolete interceptors;
6. replace existing pagination-specific verifier/tests with continuous-loading invariants.

Do not delete the old clients first.

## 9. Existing tests/ratchets that later waves must update

The repository contains pagination-specific verification and UI tests, including:

- `scripts/verify-phase11-daybook-frontend-pagination.mjs`;
- `scripts/verify-phase11-frontend-pagination.mjs`;
- `tests/ui/daybook-pagination-client.test.ts`;
- `tests/ui/account-statement-pagination-client.test.ts`;
- related build-transform verification.

These protections should be **replaced**, not simply removed. New verification should assert cursor stability, no visible pagination controls, full-period aggregates, cancellation, deduplication and bounded rendering.

## 10. Wave 2 implementation gates

Wave 2 must not be considered complete unless all of these are satisfied:

- [ ] pre-change runtime p50/p95, response bytes and DB timing are captured for the chosen environment;
- [ ] Daybook cursor semantics are implemented and tested across equal dates/type ranks;
- [ ] account cursor semantics are implemented and tested across equal dates/voucher ids/entry ids;
- [ ] account aggregate metadata no longer depends on a global fetch interceptor snapshot;
- [ ] Tracking next-chunk requests do not redo the complete current full-array pipeline for each chunk;
- [ ] filters and tenancy checks are identical or stricter than today;
- [ ] abort/cancellation support is preserved;
- [ ] no polling interval is added;
- [ ] exports remain complete;
- [ ] DB indexes are changed only after measured execution-plan evidence;
- [ ] old APIs remain compatible for known non-screen callers until their usage is proven removable.

## 11. Wave 1 findings ranked by risk

### P0 — must be solved before pagination UI removal

1. **Accounts aggregate coupling:** complete debit/credit/closing values currently reach the component through pagination-specific injected snapshot state.
2. **Tracking repeated-full-work risk:** requesting every existing page automatically would repeat the full server fetch/enrichment/filter/sort pipeline.
3. **Daybook build-time divergence:** production Daybook pagination is injected by a Vite transform, so source-only UI edits would not represent the actual shipped path.

### P1 — required for scale and cleanliness

4. OFFSET and account preceding-prefix work do not scale well for automatic full-list progression.
5. Tracking table is not virtualized.
6. Account/Daybook global pagination clients contain avoidable route-state interception; two adjacent clients contain one-second route checks.
7. Non-ledger account statement index coverage must be verified at the database level before high-volume continuous loading.

### P2 — regression-control work

8. Existing pagination tests and scripted ratchets intentionally enforce the old implementation and need deliberate replacement.
9. Print/export/bulk actions need explicit all-filtered-vs-visible semantics once virtualization is introduced.

## 12. Wave 1 completion checklist

- [x] audited ERP Daybook source and shipped build transform;
- [x] audited Daybook frontend helpers and native server pagination route;
- [x] audited Accounts statement component, global pagination client and server statement route;
- [x] audited Tracking hub, Containers OTW query boundary, server listing path and table rendering;
- [x] recorded current page sizes and OFFSET behaviour;
- [x] traced filters, aggregate paths, exports and mutation invalidation dependencies;
- [x] audited schema-declared index coverage relevant to these reads;
- [x] identified current cancellation/cache behaviour that must survive;
- [x] selected deterministic cursor tuples for Daybook and Accounts;
- [x] prohibited naive repeated full-work paging for Tracking;
- [x] defined shared continuous-chunk, aggregate, cache, cancellation and action contracts;
- [x] identified build-transform/global-interceptor migration order;
- [x] identified pagination-specific tests/ratchets that later waves must replace;
- [x] made no user-visible behaviour change in Wave 1.

## Decision

Wave 1 supports removing the visible pagination controls, but **only after** the backend and data-model work in the next waves. The safe direction is cursor-based continuous loading with server-authoritative aggregates and bounded row rendering, not an unlimited one-request/one-DOM-table implementation.
