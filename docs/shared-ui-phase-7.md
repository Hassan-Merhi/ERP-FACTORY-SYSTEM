# Phase 7 — Architecture Debt and Safe Dead-Code Cleanup

**Implementation:** 2026-10-12, on `refactor/shared-ui-standardization-phases-1-5`
**Status:** Scoped architecture consolidation implemented and committed.
**Verification:** Not run — no tests, typecheck, lint, builds, browser checks, CI or Render checks. These commits are NOT production verified or a guarantee of zero remaining dead code.

## Why these changes

This wave targeted replicated client infrastructure that could be safely
consolidated by reading its source while preserving existing module entry
points and behavior. It deliberately avoided deleting side-effect modules,
perceived unused page files and exports with potentially dynamic or test-only
callers. No byte-identical non-test TS/JS source blobs were found in the
GitHub branch's repository tree, but this does not rule out semantic duplication.

## Implemented

### 1. Shared fetch-request mechanics

Added `client/src/lib/fetchRequestUtils.ts`:

- `resolveFetchUrl`: handles string, URL, Request and malformed URL inputs.
- `fetchRequestMethod`: uses `RequestInit.method` before `Request.method`;
  defaults to GET and keeps normalized uppercase methods.
- `replaceFetchInputUrl`: preserves Request headers/body/options through
  `new Request(newUrl, input)`, returns URL for URL inputs and keeps a
  relative URL for same-origin string inputs.
- `fetchQueryCacheKey`: sorts query keys and drops only the explicitly
  supplied pagination/cursor fields. A company scope is included ONLY when
  passed by the owning interceptor.

Replaced local copies in:
`containerPaginationClient.ts`,
`supplierPurchaseOrderPaginationClient.ts`,
`accountStatementPaginationClient.ts`,
`daybookPaginationClient.ts`,
`v5AllocationPaginationClient.ts`,
`heavyListPaginationClient.ts`,
and `bandwidthFetch.ts`.

**Safety:** Every wrapper retains the exact endpoint guard, registration
flag, captured `previousFetch`, input/init forwarding, route restrictions,
pagination limits, response identity, and side-effect import.
Daybook/V5 query cache keys continue to include
`readActiveCompanyScope()`; account/stock-entry/daily client keys retain
their previous unscoped shape, without silently changing cache behavior.

### 2. One legacy pagination page collector

Added `client/src/lib/legacyPaginatedListFetch.ts` and replaced
near-identical fetch aggregation loops in the container and supplier
purchase-order interceptors. The collector keeps the old unpaginated-array
API return contract, the same 250-row page size, failed-page responses,
first-response fallback on invalid JSON, response status/headers, and
`X-Total-Count`.

Each module still owns endpoint matching, fetch-wrapper installation,
`pagination` bypass, and chaining to the fetch wrapper installed
previously. Domain logic and API semantics were not moved into the helper.

Removed now-unnecessary local `ContainerPage` and `PurchaseOrderPage`
interfaces and an obsolete module marker that was redundant after imports.

### 3. One debounce implementation

`use-debounce.ts` is the canonical timer/cleanup implementation.
`useDebouncedValue.ts` now delegates to it while retaining its named
export and required-delay signature. Neither call site, default timing,
nor a page's filtering semantics requires migration.

### 4. Confirmed dead imports

Removed unused `Badge` from `FactoryPendingInvoices.tsx` and unused
`Input` from `StockOTW.tsx`, left over after prior shared-UI migrations.

## Actual implementation commits

- `26ed2fd7c620655e76785537bcb29589d334e018` — first fetch utility and canonical debounce.
- `2a51b984101a3e7ff940a0cf5bce3d30b1980022` — remaining fetch interceptors.
- `a1468049ff17562c3f337cb7b0b956617f781920` — pagination query-key normalization, preserving tenant scope.
- `9cc134fa285ceba998ca696a2e07a22dced6a7b7` — shared page collection and dead local types/imports.

## Explicit exclusions

- Do not remove `supplierPurchaseOrderPaginationClient.ts` or
  `containerPaginationClient.ts`: they install fetch interception through
  module side effects.
- Do not remove `useDebouncedValue.ts`: consumers still import that name.
- Do not delete specialized status badges, accounting/FX formatters, old
  routes, hooks, or schema adapters purely because a text search finds few
  imports. Dynamic routing, plugin surfaces and test-only entry points can
  reference those files.
- Broad repository-wide dead-code proofs, accessibility certification,
  integration regression fixes and deployment readiness belong to
  **Phase 8 (Claude review and validation)** after implementation.
- Do not change currency conversion rules, tenant cache partitioning,
  mutation order, permissions, offline handling, or Render CI in cleanup work.

**No production change has been deployed or merged.**
