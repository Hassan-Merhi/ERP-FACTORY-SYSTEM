# Inventory valuation repair — Wave 1 evidence and regression locks

## Scope

Wave 1 is evidence-only. It does not change inventory costing behavior and it does not repair production rows.

The purpose is to make the known failure reproducible, keep the branch safe to run in CI, and provide a read-only way to identify other rows that deserve investigation before any production repair.

## Confirmed production case

Read-only production inspection on 2026-09-11 confirmed the reported item:

- Company: HMD KINSHASA
- Location: Kinshasa#2
- Stock code: `SH.MIX3`
- Item: AJ S MIX SHOES III (55PCS)
- Current quantity: `18.000`
- Current stored average rate: `33.92`
- Current stored total value: `610.48`
- Last canonical movement unit cost: `66.65`
- POS edit reversal rows in the canonical journal: `3`
- POS edit reissue rows in the canonical journal: `3`
- Last POS edit activity: 2026-09-08
- Last movement after those edits: stock-adjustment edit apply on 2026-09-09 at `66.65`
- Current unresolved negative layers for this item: `0`

The Stock Movement screen separately shows the historical running balance around `68.02` per bale before its current-year December override replaces December with the damaged live inventory rate.

## Confirmed failure mechanism

`reverseOriginalSaleInventory()` currently restores an edited POS sale by calling the normal positive `adjustInventory()` path without an incoming rate.

If an unrelated negative-stock layer exists for the same item/location, that positive call settles the layer first. Quantity is restored, but some or all of the restored quantity receives no inventory value. The resulting average rate falls. Reissuing the unchanged sale then deducts stock at that lower average rate, permanently reducing the remaining inventory value.

Repeating the edit can ratchet the value down again.

The same class of historical-edit risk exists in stock-adjustment editing: the old production adjustment is reversed at the current inventory rate rather than by undoing its original stored value exactly.

The current-year location monthly summary has an independent display/reconciliation defect: it explicitly writes live inventory into `monthlyData[11]`, so today's live balance is forced into December even when the current month is earlier in the year.

## Regression locks

`tests/inventory-valuation-wave1-regressions.test.ts` contains:

- a passing control proving an unchanged POS edit is valuation-neutral when no shortage layer exists;
- an expected-failure regression proving an unrelated negative layer is consumed by an unchanged POS edit;
- an expected-failure regression proving repeated unchanged edits ratchet valuation down;
- an expected-failure regression proving an unchanged historical production adjustment changes current inventory value;
- an expected-failure contract proving the current-year summary hard-forces December and does not use stored `inventory.totalValue` as its live monetary checkpoint;
- a passing guard proving the audit executable stays tenant-scoped and opens a read-only transaction.

The known defects use Vitest `it.fails(...)` intentionally. That means Wave 1 CI can remain green while still proving the current implementation violates the desired invariant. When a later wave fixes one of these defects, the corresponding expected-failure test must be converted to a normal `it(...)`; otherwise Vitest will fail because the defect no longer reproduces.

## Read-only drift audit

Run the audit for one company at a time:

```bash
node scripts/audit-inventory-valuation-drift.mjs --company-id 8
```

Optional JSON output:

```bash
node scripts/audit-inventory-valuation-drift.mjs --company-id 8 --json
```

Optional rate-drift threshold, expressed as a fraction:

```bash
node scripts/audit-inventory-valuation-drift.mjs --company-id 8 --threshold 0.20
```

The executable opens `BEGIN READ ONLY`, asserts the requested tenant through `app.current_company_id`, keeps maintenance scope off, and reports candidates only. It has no repair path.

The two default candidate classes are:

1. `POSITIVE_STOCK_WITH_NEGATIVE_LAYER` — positive live quantity while unresolved shortage layers still exist for that item/location. Under the canonical settlement model this deserves review because genuine incoming stock should settle shortage layers before becoming positive on-hand stock.
2. `RATE_DRIFT_AFTER_POS_EDIT` — at least one canonical POS edit reversal exists and the current average rate differs from the latest canonical movement unit cost by at least the configured threshold. This is a triage signal, not proof by itself.

## Initial dry-run result

A read-only cross-company dry run on 2026-09-11 returned:

- 16 `POSITIVE_STOCK_WITH_NEGATIVE_LAYER` candidates;
- 3 `RATE_DRIFT_AFTER_POS_EDIT` candidates.

The three rate-drift candidates included `SH.MIX3`. The other candidates must not be repaired merely because they appear in this report; Wave 5 will reconstruct their transaction history and classify true corruption versus legitimate costing changes.

## Wave 1 completion rule

Wave 1 is complete when:

- the known POS valuation failure is reproducible under an expected-failure test;
- repeated edit drift is reproducible;
- stock-adjustment edit drift is reproducible;
- the December override is pinned by regression evidence;
- the read-only audit exists and is guarded as tenant-scoped/read-only;
- normal CI stays green because no production behavior has been changed yet.

No inventory, voucher, negative-layer, or accounting data is changed by Wave 1.
