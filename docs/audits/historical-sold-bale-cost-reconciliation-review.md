# Historical factory bale costs: review-only reconciliation

**Release status: unapproved. Do not merge to main, deploy to Render, or run production cost updates until the Owner explicitly approves.**

## Background
Legacy no-mix bale records sometimes stored the catalogue **price per bale** in the `cost_per_kg` column and multiplied it by weight to obtain `total_cost`. The modern stock-entry path uses `stockEntryBaleCost` and correctly records `total_cost = production_price` and `cost_per_kg = production_price / weight_kg`. The approved one-time repair already corrected eligible unsold physical stock; this work concerns bale rows marked `SOLD` and historical deleted/available edge rows.

## Accounting distinctions

1. **Invoiced or finalized orders:** Keep posted invoices, frozen invoice documents, historical sales profit, customer balances, COGS, and cost snapshots unchanged. The current `factory_bale_products.production_price` is *not* evidence of the price at the original production date; it is only a screening estimate. Research archival prices and determine the approved correction basis before drafting any financial adjustment.
2. **SOLD on VERIFIED with no invoice:** Under `factoryStockValuation`, such bales still count as finished goods (`soldNotInvoiced`). For those *without an invoice number, finalization timestamp, frozen invoice snapshot, sale ledger or POS sale*, the existing reviewed `baleRecost` mechanism can now preview stock re-costing. No changes happen on preview; apply remains Owner-only, validates the SHA-256 plan hash, rechecks the order, and requires `confirmVerifiedSoldBales: true` when this cohort appears.
3. **VERIFIED with evidence of an earlier invoice:** Exclude from the automatic re-cost. A VERIFIED status by itself does not establish whether an invoice was validly reversed; reconcile its transaction history before deciding whether to treat it as inventory.
4. **DELETED and anomalous AVAILABLE:** Report separately, never restore or recost automatically.

## New owner/admin screening endpoint

`GET /api/factory/bale-cost/historical-sold-audit?group=INVOICED_OR_FINALIZED&orderId=123&limit=100&offset=0`

Omit `orderId` to list all rows for a group. The response includes an `orders` section containing the grouped, read-only per-invoice screening estimates so reviewers can inspect an individual customer order without paging through unrelated bales.

Returns:
- summary totals grouped by evidence and current stored state
- paginated bale reference, order/container identifiers, stored `cost_per_kg` and `total_cost`
- current catalogue price and **nominal** difference
- invoice number, snapshot indicator, finalization timestamp, sale ledger indicator
- explicit `readOnly: true` and warning that this is **not a confirmed historical book adjustment**

Allowed groups: `INVOICED_OR_FINALIZED`, `VERIFIED_WITH_INVOICE_EVIDENCE`, `OPEN_VERIFIED_UNINVOICED`, `OTHER_SOLD`, `DELETED_REVIEW_ONLY`, `AVAILABLE_REVIEW_ONLY`.

The endpoint is authenticated, company-scoped, Admin/Owner only. It cannot write bale, invoice or voucher data.

## Review-and-apply safeguards

- No automatic background repair is included. No startup job, migration or environment variable is added.
- The verified-order cohort is included in the ordinary `recost-preview` *only while invoice-free*.
- During `recost-apply`, eligible VERIFIED order rows are locked before the hash is recalculated. If an invoice, snapshot, sale transaction or order status appears after preview, eligibility changes and the old hash is refused.
- `SOLD` bales on invoiced/finalized orders remain excluded, regardless of their stored status or subsequent reversal history.
- Applying a plan that contains VERIFIED pre-invoice SOLD bales also requires `confirmVerifiedSoldBales: true`, in addition to the existing `confirm: true` and `planHash`.
- Where a perpetual-inventory cutover applies, the existing recost posting routine journals the finished-goods revaluation; before cutover the reviewed recost run and audit are retained without creating a retroactive invoice/COGS voucher.

## Acceptance criteria after explicit approval to merge/deploy

1. Verify that the screening groups match a read-only live SQL audit at that moment; do not use prior counts as an automatic write threshold.
2. Run targeted cost-basis tests including verified-without-invoice, verified-with-invoice and already-finalized cases; confirm plan-hash race refusal and explicit second Owner approval.
3. Preview the exact bale references and financial impact under the target company's active company scope.
4. Ensure finalized invoice numbers, frozen invoice documents, customer balances, POS cost snapshots and vouchers do not change.
5. Review historical cost-at-creation evidence separately before any sold-and-invoiced monetary correction is approved.
6. Confirm the previously installed completed-order `IN_STOCK` guard stays enabled and no completed-order bale becomes available.
7. Maintain separate human approval for *applying a financial re-cost*, not merely approving code deployment.

## Not included

This branch deliberately does **not** rewrite historical finalized-sale bale costs, historic profit/COGS, invoice dates, voucher lines, deleted bales, or unusual AVAILABLE bales. Those remain an investigation until defensible historical production-price evidence and an accounting-safe correction policy exist.
