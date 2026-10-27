# MALI HMD supplier cost repair — evidence-gated procedure

**Scope:** ERP company 9 (MALI), supplier 27 (HMD), stock group 130, historical-sales cost repair run 62.

**Goal:** Repair proven purchase/stock/sales valuation errors without manipulating supplier liabilities, changing historical cash, or adding an ERP screen. Do not invent a `$78.89` expense.

## Confirmed starting figures (26 October 2026)

| Basis | USD |
|---|---:|
| Offloaded landed cost, seven containers | 372,853.70 |
| Booked sales revenue | 339,200.81 |
| Booked sales COGS | 303,022.84 |
| Profit from booked sales less COGS | 36,177.97 |
| Current inventory (saved total_value) | 69,909.72 |
| Current inventory (quantity × rounded average rate) | 69,909.75 |
| Saved-value cost gap: receipts − COGS − stock | -78.86 |
| Rate-based cost gap | -78.89 |

These small net gaps conceal **gross item-level valuation differences above $4,000**. They are not a missing invoice.

Historical evidence limits from the database:
- 209 HMD item codes appear in the scoped inventory group.
- 84 historical transfer lines have null `value_moved`, so the exact value relieved from the source was not saved.
- 944 older sale lines have null `value_moved`, so source inventory relief is not independently evidenced on those lines.
- Run 62 has 397 blocked HMD sale rows. 374 have an out-of-rate-hull blocker; 14 HMD12630 rows disagree with canonical sale evidence; the remainder have irreversible cost-memory/rewind blockers.
- The October 1 proven-rows partial apply changed 129 HMD sales lines, increasing stored COGS by $303.65. Do not replay an already applied run.

Two unsold transferred items need **source rate proofs**, not blind stock-value reductions:
- HMD12579: offloaded $557.52, current depot $719.79, net +$162.27, transfer lines without `value_moved`.
- HMD13011: observed receipt vs depot stock difference $50.80; older transfers lack `value_moved`, and a later offload was reversed/reposted in October. Source value must be time-ordered.

## Verified movement-value corrections to the original manual formula

The first unadjusted receipt-minus-sales-minus-inventory comparison is **not a full cost equation**: stock adjustments can change inventory without a sale. A signed inventory adjustment belongs in the cost bridge. On 26 October we verified three exact examples:

| Code | Raw item cost gap | Recorded signed adjustment value | After that adjustment |
|---|---:|---:|---:|
| HMD12003 | -$0.10 | +$0.10 | $0.00 |
| HMD12059 | +$72.99 | -$72.99 | $0.00 |
| HMD12091 | -$47.99 | +$47.99 | $0.00 |

These entries already balance and must **not** be manually revalued. HMD12059 and HMD12091 appear at both MALI and Mali Depot because several offloads legitimately received directly into each location; their depot presence by itself is not an undocumented transfer.

Across the entire HMD group the nominal signed canonical adjustment/movement value is **+$665.14**. Adding that mechanically produces a **+$586.28** residual on saved values, but that is **not an accounting error to post**: the tally includes credit-note and deleted-sale reversals, plus adjustment edit/reverse pairs whose underlying sales accounting must be deduplicated. Build the source-specific movement bridge before treating any such sum as a COGS true-up.

## Recovery stages

1. **Freeze and fingerprint evidence:** Take a company-scoped, repeatable-read snapshot, identify each receipt/offload, sale, return, transfer, stock adjustment, historical valuation override and deleted/reversed transaction. Use `scripts/audit-erp-supplier-inventory-cost.ts` read-only, then save its JSON output. Do not backdate after a live posting without refreshing the snapshot.

2. **Reconstruct quantities first:** Starting from original opening stock and dated receipts, prove the movement chain per stock item **and location**, including reversals/optional flags. Do not infer transfer posting dates from voucher dates when audited finalization dates differ. Require exact closing units. Any item with unaccounted quantities remains blocked.

3. **Reconstruct money independently:** Calculate every original offload item value from its recorded purchase rate and approved offloading allocation. Transfers must move exactly the source-relieved value, not the manually entered destination rate. Replay canonical movements at stored `value_moved` where present. For older null values, use audited source-inventory snapshots, approvals, or reliable immutable transaction records; otherwise explicitly block.

4. **Review blocked historical sales:** Run the existing historical sales cost repair engine in diagnosis mode for each affected (company, location, stock item). Accept its evidence-proven lines only. Do not defeat the rate-hull, inverse-uniqueness, mutation-time, or checkpoint guards merely to reduce the balancing difference. For HMD12630, investigate the 14 canonical-sale mismatch lines individually.

5. **Create a proposed correction set:** For each **proven** discrepancy, pin `company_id`, `location_id`, `stock_item_id`, source event IDs, old/new quantity and value, and a cryptographic hash of the unchanged evidence. Show precise impact separately on:
   - physical inventory quantity (should stay fixed for a value-only correction);
   - inventory subledger total value/average cost at each location;
   - historical sale-cost correction or an explicitly dated COGS true-up;
   - inventory/COGS general-ledger postings, balanced and linked to correction ID.
   Never alter supplier payable or opening cash as a balancing plug.

6. **Only then apply:** In a single company-scoped serializable transaction (advisory lock), re-check evidence hash and current row values `FOR UPDATE`; record before/after audit data; post value corrections through supported inventory cost and ledger services; check the general ledger debit/credit balance, source movement totals, and write-set. Roll back the entire transaction on mismatch. An idempotency key must reject replay.

7. **Verify at item level:** Compare independently recomputed landed cost, accepted adjustments, true COGS and current stock to the cent. Demand exact quantity conservation, no new negative location layers, no duplicate postings, no phantom transfers, and no changes to customer statements, supplier liabilities, or historical currencies. Re-run the read-only snapshot after commit; no assertion of “100% correct” while any HMD item is blocked or has unexplained value.

## Running the non-mutating workpaper

```sh
npx tsx scripts/audit-erp-supplier-inventory-cost.ts --company 9 --supplier 27 --group 130 --repair-run 62 --out /tmp/mali-hmd-20261026.json
```

This tool **has no apply mode**. An operator-approved correction step must be implemented using the existing audited inventory and accounting posting services once the original source values are proved. The draft prevention PR #2490 should be reviewed independently of the historical-data repair.

## Why a plug journal is prohibited

The $78.89 is the **net** of large offsetting mismatches and a $0.03 rate-display difference. A journal for only $78.89 could make one KPI equal another while leaving incorrect stock-unit rates and unsupported old COGS intact. Correct source transactions and their paired accounting effects, not the difference between two report totals.
