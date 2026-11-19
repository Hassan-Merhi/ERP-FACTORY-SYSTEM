# Golden Coast Phase 16 — payable / equity conversion audit

Audit of the Phase 16 cleanup against `main`, run on 2026-09-03. Scope: what is
already merged, what is not, and whether the four Phase 16 invariants hold.

## 1. Conversion work is NOT in main

Six Golden Coast branches carry Phase 15–18 work. **None is an ancestor of
`main`** — every one is unmerged, and all were last updated on 2026-09-03.

| Branch | Commits ahead | Files | Diff |
| --- | ---: | ---: | --- |
| `fix/golden-coast-payable-equity-model` | 16 | 17 | +361 / −98 |
| `phase15/golden-coast-sales-cash-payable-20260903` | 14 | 7 | +1224 / −246 |
| `phase16/golden-coast-hadi-credit-payable-20260903` | 28 | 16 | +2424 / −264 |
| `phase17-fresh-start-settlement` | 4 | 1 | +66 |
| `phase17/golden-coast-net-position-balance-sheet-20260903` | 38 | 22 | +2737 / −368 |
| `phase18/golden-coast-equity-presentation-20260903` | 37 | 69 | +5050 / −569 |

The Phase 16 branch is the substantive one. It introduces, none of which exists
in `main`:

- `server/services/accounting/goldenCoastSalesPayable.ts` — the
  **capital-to-payable bridge** (see §2);
- `server/routes/sp/spGoldenCoastHadiTransferGuard.ts` (573 lines);
- `server/routes/sp/goldenCoastAutoHadiCore.ts`, a split of the auto-HADI
  route, which **rewrites 491 lines of `goldenCoastAutoHadi.ts`**;
- `client/src/pages/sp/golden-coast/HadiProceedsRemittancePanel.tsx`.

Nothing was merged from these branches as part of this audit. The auto-HADI
rewrite overlaps files this branch has already changed, so a merge would
conflict and needs a deliberate decision rather than a blind replay.

## 2. The capital-to-payable bridge is a design decision, not a defect

The Phase 15/16 branches post, per sale:

```
Dr Fresh Start FZ Equity   gross sale proceeds
Cr GC Sales Cash Payable   gross sale proceeds
```

The reasoning is sound on its own terms: Fresh Start contributed the inventory
as capital, so as that inventory converts to cash their capital converts into a
debt owed back to them. It is the "payable / equity conversion" Phase 16 is
named after, and it is deliberately not profit distribution — sales and COGS
still close 50/50 through the monthly close.

It is recorded here rather than adopted because it changes what partner equity
means over the life of the company, and `main` has never carried it.

## 3. The four invariants hold in main

Each is now locked by a test rather than asserted by inspection.

**Payables remain liabilities.** Every obligation role (`gc_sales_cash`,
`hassan_savings`) is liability-typed, accepts no equity type, and carries
neither an ownership share nor an opening equity target. A payable found
reclassified as Equity is repaired back to Liability in place, keeping its
account id so posted history still resolves.

**Equity movements are separate.** Every ownership role
(`fresh_start_equity`, `hassan_equity`, `profit_pending_distribution`) is
equity-typed and accepts no liability type. The monthly close splits profit —
and charges loss — to the two equity accounts and touches no payable account;
Profit Pending Distribution nets to zero, so it is a conduit and not a store of
value.

Covered by `server/services/accounting/goldenCoastPayableEquitySeparation.test.ts`.

**No duplicate journals.** `accounting_posting_requests` carries a unique index
on `(company_id, idempotency_key)`, so a repeated key replays and a fresh key
posts. Driving every Golden Coast key builder together from one shared client
request id shows no two distinct events collide, the two legs of a paired
posting stay distinct, keys are stable across retries, and each key is prefixed
with its own source type and scoped by company. The monthly close is keyed by
period, so a month can be closed only once.

Covered by `server/services/accounting/goldenCoastIdempotencyNamespace.test.ts`.

**No broken historical balances.** Already covered in `main` and left alone:
Phase 2 provisioning is repair-only (it adopts legacy accounts, restores
soft-deleted ones, and leaves duplicate sub-type accounts untouched rather than
deduplicating), and Golden Coast vouchers are immutable, corrected by reversal
and re-posting. No new coverage was added here because none was missing.

## 4. Outstanding decisions

1. Whether to merge, cherry-pick, or abandon the six branches above — in
   particular whether the capital-to-payable bridge becomes the model.
2. The retired Phase 5/6 `pos-sale` endpoint still posts the receivable
   direction and is still mounted, though live POS no longer reaches it.
