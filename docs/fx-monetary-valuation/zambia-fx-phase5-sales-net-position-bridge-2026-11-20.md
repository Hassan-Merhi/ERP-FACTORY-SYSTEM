# Zambia FX — Phase 5 Sales Report / Net Position reconciliation

**Branch:** `audit/zambia-fx-phase1-20261120` · draft PR #3357  
**Source:** live Zambia `ZM` (company 19) ledger, sales and inventory rows inspected **read-only** on November 20, 2026.

## Finding: the $0.32 comparison consists of separate reporting sources

The original comparison is Sales Report `Cost Profit` USD **3,506.22** minus the original manual FX loss **45.63** = **3,460.59**, versus the screenshot's **Net Position 3,460.91**. The USD **0.32** gap is not a missing journal:

| Bridge component | USD | Evidence |
| --- | ---: | --- |
| Sales Report Cost Profit | 3,506.22 | Sales items: 11,030.31 revenue − 7,524.09 reported cost |
| Posted Sales Revenue difference | +0.01 | Four posted Sales Revenue voucher credits sum 11,030.32; source sales-items revenue is 11,030.31 |
| Stock value relieved vs Sales Report cost | +0.30 | `sales_items.value_moved` = 7,523.79, while `sales_items.total_cost` = 7,524.09 |
| Manual FX journal economic loss | −45.63 | `JV-19-2026-000001`, original manual FX voucher, debit FX / credit cash |
| **Expected book-economic operating position** | **3,460.90** | 3,506.22 + 0.01 + 0.30 − 45.63 |
| Screenshot-only net presentation difference | +0.01 | Screenshot Net Position 3,460.91 vs book-economic position 3,460.90; the wrong Asset FX +45.63 and synthetic FX liability −45.62 have net display effect +0.01 |
| **Original displayed Net Position** | **3,460.91** | User's screenshot, not an automatically persisted financial ledger balance |

The +$0.01 presentation difference is explained algebraically by the two screen values, but **must not be treated as a newly identified accounting entry**. The Phase 5 endpoint intentionally leaves `reportedNetPositionUsd=null`; it is not a substitute for the contemporaneous full management report and does not invent an as-of report reading.

## The $0.30 is specifically traceable to actual historical stock issues

| Sale | Stored `total_cost` | Inventory `value_moved` | Difference |
| --- | ---: | ---: | ---: |
| `SV-19-2026-000003` | 4,979.84 | 4,979.60 | 0.24 |
| `SV-19-2026-000004` | 1,506.52 | 1,506.50 | 0.02 |
| `SV-19-2026-000005` | 544.69 | 544.67 | 0.02 |
| `SV-19-2026-000006` | 493.04 | 493.02 | 0.02 |
| **Total** | **7,524.09** | **7,523.79** | **0.30** |

All 40 sale lines have non-null `value_moved` evidence. The true stock cost removed is `value_moved`. The Sales Report uses `total_cost`. The difference is at the source line level, not a wrongly balanced voucher. Do not silently rewrite either historical column or create a $0.30 accounting entry.

## Source purchase/inventory reconciliation

- Net posted company Purchases USD **147,025.58**.
- Duties USD **14,391.20** and transport USD **16,123.60**.
- Total source landed funding USD **177,540.38**, with matching credit/loan liability USD **177,540.38**.
- ERP stock on floor: **90,437.09** from `inventory.total_value` across all 3 non-deleted Zambia locations (KITWE 18,513.55; LUSAKA DEPOT 53,608.15; LUSAKA SHOP 18,315.39).
- Stock on the way: **79,579.50** from two `OTW` containers (CAAU9158721 46,984.50; CAAU5379196 32,595.00).
- Current stock: 90,437.09 + 79,579.50 = **170,016.59**.
- Actual stock relieved: **7,523.79**.
- **170,016.59 + 7,523.79 = 177,540.38**, precisely matching source landed funding.
- Book cash 10,984.69 + stock 170,016.59 − credits/loans 177,540.38 = **3,460.90**, before report-only FX rows. This also equals Sales Revenue 11,030.32 − actual inventory relief 7,523.79 − 45.63 FX = 3,460.90.

This establishes a complete **Zambia-specific source-stock/accounting bridge** for the inspected snapshot, not a general principle that Sales Cost Profit and all companies' Net Position must equal each other. Loan movements, equity, account openings, foreign exposures and alternate report dates can legitimately break that equality elsewhere.

## Phase 5 code

- `server/services/accounting/salesNetPositionBridge.ts` uses Decimal cents, retaining both the Sales Report's recorded cost and the actual value removed from inventory. It never invents a balancing entry or overwrites an official report number.
- `server/services/accounting/zambiaSalesNetPositionReconciliation.ts` reads **one company-scoped, repeatable-read, read-only** transaction. It inspects current sale voucher summaries, posted Sales Revenue, source landed funding/credits, current stock value, OTW stock and the FX counter. It returns per-voucher differences and explicit completeness blockers.
- `GET /api/accounting/monetary-fx/sales-net-position/reconciliation` is Admin/Owner/Developer-only, and uses session company selection; no company ID from the request. It has no POST/PUT/delete actions, no rate writes, and no voucher edits.
- The diagnostic is **Zambia pre-perpetual-ERP sourced**: other ledger codes, nonzero openings, missing sale `value_moved`, funding mismatches, unexpected balances, wrong FX account classification, or unresolved stock source numbers return `needs_review` rather than a false successful comparison.
- The current live Zambia result is expected to be `needs_review` until account `FXREVGAI` is correctly classified from Asset to Indirect Expense via approved accounting action; **this is a valid safety result** even though the source-stock arithmetic balances.

## Acceptance / remaining gates

1. Regression cases must preserve the exact +0.01 posted-sales, +0.30 inventory-relief, −45.63 FX arithmetic and 3,460.90 book-economic position.
2. Wrong account type remains blocked; no historical cost rewrite, duplicate expense, or synthetic position plug.
3. CI type-check, formatting, database tests and repository security/audit gates must pass on the same PR branch.
4. **Production accounting correction requires its own reviewed operational approval** and subsequent verification (Phases 3–4); do not merge, deploy or mutate live records to accomplish Phase 5.
