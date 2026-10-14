# Smart Transfer — Known Issues & Recommended Fixes

This note documents the outstanding issues in the **Smart Transfer** feature that
currently account for the repository's baseline TypeScript errors (`tsc --noEmit`
reports 7, all listed below). They live in in-progress feature code and are
deliberately left for the feature owner to resolve — this is a diagnosis and a
recommended fix for each, not an applied change.

## Summary

| # | Severity | File | Line(s) | Kind |
|---|----------|------|---------|------|
| 1 | **Runtime bug (NaN)** | `client/src/components/stock-transfer/SmartTransferGeneratorDialog.tsx` | 428, 480 | Undefined variable → `NaN` |
| 2 | Resolved (file removed) | `server/services/stockTransferRevisionLifecycle.ts` | — | The superseded pending-revision lifecycle was deleted in the 2026-10 dead-code cleanup; the immutable lifecycle is the only implementation. |

---

## Issue 1 — `reserveQty` is undefined (produces `NaN` at runtime)

### What TypeScript reports
```
SmartTransferGeneratorDialog.tsx(428,96): Cannot find name 'reserveQty'.
SmartTransferGeneratorDialog.tsx(480,96): Cannot find name 'reserveQty'.
```

### Root cause
Both sites compute a line's reserve quantity like this:

```ts
sourceReserveQty: Math.min(inventory.currentStock, reserveQty),
```

but **`reserveQty` is never declared** in the component — there is no `useState`,
`const`, `let`, or prop by that name. `getInventory()` (line 359) returns only
`{ currentStock, available, rate }`; it does not return a reserve.

Because the identifier is undefined, `Math.min(number, undefined)` evaluates to
**`NaN`** at runtime. That `NaN` is written to `sourceReserveQty` on the affected
line and then:
- rendered in the UI (shows `NaN`), and
- posted back to the server when the transfer is applied.

This is triggered on two user actions, **not** on the normal preview path:
- **`updateLineSource`** (line 428) — when the user manually changes a line's source location.
- **`addManualLine`** (line 480) — when the user manually adds a line.

The normal server-generated preview is unaffected: those lines get
`sourceReserveQty` from the server response (`SmartPreviewLine.sourceReserveQty`,
populated in `smartTransferAllocation.ts` from `source.reserveQty`, which is a
sales-history-based local reserve computed per source location).

### Why it hasn't surfaced as a crash
`NaN` doesn't throw — it silently propagates. The damage is a wrong/blank reserve
figure on manually-edited lines and potentially a `NaN` reaching the apply
endpoint.

### Recommended fix (safe, minimal)
A manually chosen source is an explicit user override, and there is no
per-location sales-reserve value available on the client for an arbitrary source.
The correct, low-risk behaviour is to reserve **0** for manual lines:

```ts
// updateLineSource (line ~428) and addManualLine (line ~480)
sourceReserveQty: 0,
```

This removes the `NaN`, is behaviourally defensible (a hand-directed transfer is
not auto-reserving for local sales), and keeps the server free to re-validate on
apply.

### Alternative (heavier, only if the reserve must be preserved)
If the product intent is that manual lines should still honour the local-sales
reserve, the reserve must come from the server, since it depends on 30-day sales
history the client doesn't hold. That means either:
- extending the preview response with a per-`(stockItem, location)` reserve map
  the client can look up, or
- a small `GET /api/stock-transfers/source-reserve?stockItemId=&locationId=`
  endpoint called on manual source change.

The simple `0` fix is recommended unless there's a concrete requirement for the
heavier path.

---

## Issue 2 — `QueryResult` indexed by `[0]` (type-only, runtime-safe)

> **Resolved:** the file was deleted in the 2026-10 dead-code cleanup (its only route was unreachable). The notes below are kept as history.

### What TypeScript reports (5 occurrences)
```
stockTransferRevisionLifecycle.ts(205,50): Element implicitly has an 'any' type because
  expression of type '0' can't be used to index type 'QueryResult<Record<string, unknown>>'.
  Property '0' does not exist on type 'QueryResult<Record<string, unknown>>'.
```
…and the same at lines **232, 350, 499, 524**.

### Root cause
Each site defensively supports two possible shapes from `.execute()`:

```ts
const existing = existingResult.rows?.[0] ?? existingResult[0];
```

The `?? existingResult[0]` fallback indexes the result as if it were a bare array.
When the result is typed as `QueryResult<...>` (which has `.rows`, not numeric
indices), TypeScript rejects `[0]`. At **runtime** the pattern is fine — it works
whether the driver returns `{ rows: [...] }` or an array — which is why these are
type errors, not bugs.

(Note: the identical pattern at line 122 does **not** error, because it's inside
`lockTransferScope(tx: any, …)` where `tx.execute()` returns `any`.)

### Recommended fix (normalize once, keep runtime behaviour)
Introduce a tiny helper and use it at all six sites (including line 122 for
consistency):

```ts
function firstRow<T = Record<string, unknown>>(res: any): T | undefined {
  return (res?.rows ?? res)?.[0];
}

// then:
const existing = firstRow(existingResult);
const row = firstRow(lockedInventory);
```

This preserves the exact both-shapes runtime behaviour while satisfying the type
checker, and removes all 5 errors in one pass.

---

## After both fixes
`tsc --noEmit` should report **0 errors** — the repository would have a clean type
baseline for the first time, which lets CI treat *any* new type error as a hard
failure instead of having to filter a known-baseline of 7.
