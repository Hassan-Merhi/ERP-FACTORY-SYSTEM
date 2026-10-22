# Factory Net Position — Phase 1 source audit

Date: 2026-10-21
Implementation branch: feature/factory-net-position-historical
Status: PHASE 1 COMPLETE — source-code audit and dependency mapping. No application behavior changed.

## Scope and accounting contract

The Factory Net Position page (/factory/net-position-details) must reconstruct its cumulative financial and operational state from the beginning of available records through the company-local end of the selected as-of date (inclusive). An event first occurring on 2026-10-20 or 2026-10-21 must not affect a view of 2026-10-19. This affects both summary totals and every child row, including the optional customized subtotal.

For a reliable "what was known on the day" snapshot, distinguish business effective date from first-recorded timestamp, modification timestamp, deletion/reversal timestamp, and state-transition timestamp. A voucher booked to an earlier effective date but entered later creates a business rule decision; see "Unresolved design contract" below. Do not silently infer missing timestamps or write corrective vouchers.

This is a code audit, not a live-database reconciliation. Live data completeness and historical backfill feasibility remain for Phase 8. CI and full test suites are intentionally excluded at the owner's request; Claude handles CI later.

## Exact request/response path

1. client/src/components/FactoryRoutes.tsx mounts FactoryNetPositionDetails at /factory/net-position-details.
2. client/src/pages/factory/FactoryNetPositionDetails.tsx (approx. 631–659) stores asOf and valuationMode; its request key includes both, and GET /api/factory/net-position?asOf=...&valuationMode=... is correctly issued. The date input and previous/next controls modify asOf (approx. 743–777).
3. server/routes/factory/employee-pos/index.ts registers historical correction middleware BEFORE the main GET handler.
4. server/routes/factory/employee-pos/netPositionHistoricalCorrection.ts (approx. 142–194) wraps res.json for non-current dates, calls computeHistoricalOperationalValues(), and replaces only INVENTORY, RAW_MATERIAL, BALANCE_ON_TABLE asset account values. It recomputes forUs and netPosition, but leaves all other line items and onUs values alone. On failure, it logs and returns the original potentially incorrect historical response.
5. server/routes/factory/employee-pos/employeeNetPositionRoutes.ts owns the principal GET /api/factory/net-position route (approx. 40–814). It fetches vouchers, customers, supplier/stock services, open orders, rental contracts, employees, worker advances and classifications, then builds forUs/onUs account rows, breakdowns and totals.
6. server/routes/factory/employee-pos/netPositionSupplierBalances.ts builds supplier lines, locked raw-material costs and container context; it calls settlementPools and broker statement builders.
7. server/routes/factory/employee-pos/netPositionInventory.ts computes stock, raw materials, OTW and Balance on Table.
8. server/services/factory/productionBalanceOnTable.ts is the shared as-of helper for in-process production valuation.
9. server/routes/factory/employee-pos/employeeAttendanceRoutes.ts serves GET /api/factory/net-position/payroll-breakdown. The frontend sends asOf, but this endpoint does NOT consume it; it reads employees.currentBalance.
10. client/src/pages/factory/FactoryNetPositionDetails.tsx groups returned accounts by category or saved display layout. Both large top totals and expanded panels use the same response; CustomNetPositionView locally recomputes optionally hidden-line totals.
11. A separate page client/src/pages/factory/FactoryNetPosition.tsx shares the GET endpoint and must not regress. Other consumers (financial snapshot, dashboard and exports) may depend on current response shape; maintain compatibility.

## Coverage matrix: every requested category

| Area | Current source/formula | Existing date handling | Verified gap / Phase target |
| --- | --- | --- | --- |
| Customer Accounts | employeeNetPositionRoutes.ts: getCustomerLedgerAndMemo; customerLedgerSplit.ts; heldUnfinalizedCustomerCharges.ts; underlying ledgerBalanceEngine.ts | asOf passed to party ledger and held-charge projection; voucher effective/voucher date limited | Partially historical. Memo sources and historical finalization statuses need event-by-event review. Current customers/deletions and mutable order states may change earlier balances. Phase 3. |
| Raw Material | netPositionInventory.ts: factory_raw_stock received_kg/used_kg, supplier locked rate, manual adjustments, completed/open mix batch sources | Base calculations have NO asOf filter on raw-stock rows, adjustments or completed/open mixes; historical correction reconstructs by adjusting today's total for later receipts/mixes/adjustments | Inverse-from-current is not an authoritative replay, particularly after edits, deletion, changes of locked cost or partial batch transitions. Phase 4/8. |
| Uninvoiced Orders | employeeNetPositionRoutes.ts: customer_orders current status, grand_total, total_qty_bales; only VERIFIED and LOADING enter assets | order_date <= asOf | Current status and totals are used for an old date. Scanned bales do not drive a dated amount. Use historical order lifecycle and scan times; avoid counting stock twice. Phase 5. |
| Liability Deposits | Main route loads voucher_entries for vouchers with COALESCE(effective_date,voucher_date) <= asOf, then shared classifyNetPositionAccounts | Voucher cutoff exists | Voucher-supported account movement mostly dated, but account opening/creation, future soft deletions, edited vouchers and classification require audit. Phase 6. |
| Factory Stock OTW | netPositionInventory.ts: iterates allContainersF; only current PENDING/IN_TRANSIT/ARRIVED status, using current goods, freight, commission, other charges | Parent container query restricts created_at <= asOf | No historical status/offload transition; container offloaded after cutoff disappears from old OTW. Mutable price/charges can rewrite history. Phase 5. |
| Assets + Prepaid Rent | Asset ledger rows through classifyNetPositionAccounts; rental property_units, ACTIVE property_contracts, property_monthly_ledger expected by billing date, POSTED property_payments filtered by payment_date | Voucher lines, rental billed expected, posted payments have date limits | Current active units/contracts and edited expected amounts influence past. Fixed asset recognition/opening/deletion/depreciation must be identified per asset subtype. Phase 6. |
| Stock in Hand | netPositionInventory.ts: today's IN_STOCK and current allocation; historical correction uses factory_bales with entry/pressed/created date cutoff and finalized/deleted dates, product catalogue production/selling prices | Only overlay has a partial date query | Uses current status or mutable product price; cannot reliably reconstruct returns, removals, reservations, transfers, reversals or period-specific costing. Phase 4. |
| Employee Receivables | employeeNetPositionRoutes.ts: employees.currentBalance with negative values displayed as receivables; worker advances from SUM(factory_worker_advances.remaining_balance) | NO asOf on employees.currentBalance or worker advances | Current balances/repayments leak into past; employee selection uses current active/deleted state. factory_advance_repayments stores repayment_date, enabling reconstruction where complete. Phase 3/6. |
| Supplier Overpayments + Normal Suppliers | netPositionSupplierBalances.ts: supplier settlement pools, brokers, supplier payments, voucher settlements, FX; current supplier opening and links | Date filter on container created_at, payment date, voucher effective date, FX transfer date, additional-charge creation | Partial support: current container amounts/status, current parent/broker membership and locked raw-material cost/FX assumptions can alter prior-day lines; soft deletion can drop old items. Phase 3/5. |
| Liability + Loans | Main route's factory voucher entries and classifyNetPositionAccounts | Voucher effective_date/voucher_date <= asOf | Existing posted movement cutoff generally works, but master openings, loan inception, edited/deleted records and future changes must be reconstructed or qualified. Phase 6. |

Additional displayed categories not to omit: Balance on Table, Factory Worker Advances, Payroll Payable, Customer CR, Verified/Loading split, Stock OTW, supplier broker grouping, cash/bank or any other classified asset/liability ledger lines.

## Specific defects and risks backed by source

- The date control is not disconnected; it already propagates into a dated query key and URL.
- Historical middleware wraps res.json rather than returning a single wholly dated DTO, and it patches only three values; errors silently fall back to a non-reconstructed response (netPositionHistoricalCorrection.ts: 142–194).
- Today's raw-material snapshot is used as the starting point for the historic raw-material adjustment (netPositionHistoricalCorrection.ts: 93–139), and its SQL currently checks deleted_at IS NULL, losing future-deleted movement history.
- Base inventory stock SQL has no asOf, and the overlay's bale logic can include bales currently in another state if their finalized_at is null; use movement/event history and historical allocation (netPositionInventory.ts: 81–103; netPositionHistoricalCorrection.ts: 70–88).
- Finished inventory uses factory_bale_products.production_price / selling_price, which may represent today's product price, not the original price of a bale; evaluate factory_bales stored cost at event time (netPositionInventory.ts: 81–103).
- Balance on Table limits mix and bale creation dates, but uses CURRENT bale exclusion statuses and current mix totals (productionBalanceOnTable.ts: 15–58).
- Supplier OTW uses TODAY's status on an older container (netPositionInventory.ts: 305–335). The settlement pool's asOf filter only limits container created_at, not its past states (settlementPools.ts: 322–429).
- customer_orders.verified_at, loading_started_at, loading_finalized_at, finalized_at and created_at exist, but the report uses current status plus order_date; historical amendments and rescans must be examined (shared/schema/factory/customer-orders.ts: 106–145).
- customer_order_bales_history exists, and server/customerOrderBaleScanAuditBridge.mjs ensures scanned_at on both scan/history tables with a trigger for genuine scans. Historical imported rows deliberately can have NULL scan time. Date replay must not invent those dates.
- Payroll breakdown accepts asOf from client but never reads req.query.asOf (employeeAttendanceRoutes.ts: 14–49); it returns current positive employees.currentBalance. This can make the customized subtotal disagree with the dated main panel.
- Worker advances have advance_date and repayments have repayment_date (shared/schema/factory/workers-payroll.ts: 220–280), but current report reads remaining_balance without limiting the date (employeeNetPositionRoutes.ts: ~445–465).
- Prepaid Rent filters payment_date but requires propertyContracts.status='ACTIVE' NOW; historically valid expired contracts vanish, and future-created active contracts can appear with a current ledger configuration (employeeNetPositionRoutes.ts: ~475–545).
- The frontend todayStr() uses new Date().toISOString().slice(0,10), i.e. UTC rather than factory/business-local date (FactoryNetPositionDetails.tsx: ~332–333). Backend uses getClientDate(req); possible disagreement near midnight.
- The frontend uses staleTime: Infinity for any prior-day snapshot (FactoryNetPositionDetails.tsx: 654). An earlier date may remain stale forever after late-posted corrections or historical data repairs.
- The main route selects only presently non-deleted ledgerAccounts and vouchers (employeeNetPositionRoutes.ts: ~120–154). Current soft-deletion exclusion does not reconstruct "visible then, deleted later" history.
- Classification and explicit factory stock/clearing exclusions live in server/netPositionHelper.ts and employeeNetPositionRoutes.ts. Preserve avoidance of double-counted inventory, freight, and customer pre-finalization charges.
- Current-rate vs dated-rate distinction: the factory_fx_rates query uses effective_date <= asOf, which is positive; supplier locked raw-material rate is a current master value. Preserve currency-native settlement amounts and verified exchange-rate policy, do not revalue historical original transactions at today's FX.
- The API returns forUsTotal, onUsTotal, netPosition; forUs/onUs totals, account arrays, breakdown arrays, supplementary numeric fields and pending/verified/loading order lists. All must reconcile for the same date.

## History/data availability (code-confirmed, deployment NOT verified)

Present schema/services expose voucher effective_date/voucher_date and entries, employee repayment dates, mix batch date/created_at, raw material adjustment date, raw-stock offloaded_at, bale stock_entry_date/pressed_at/created_at and finalized_at, order lifecycle timestamps, customer order scan audit scanned_at, and cancelled scan history. These provide some historical anchors.

Source code alone does NOT prove every historical state change (especially old status transitions, edits, deleted/recreated records, old material rates and NULL scanned_at records) is recoverable. Phase 8 must inspect data coverage and provide an explicit completeness/uncertainty report before claiming exact history.

## Unresolved design contract for Phase 2

The owner says a transaction ADDED on October 21 should not show when viewing October 20. Standard financial effective-date statements DO include a voucher backdated to October 20 even when entered October 21. Therefore Phase 2 must define the primary report as either:
A) Booked-effective-date-as-of (retroactive corrections appear in earlier balances); or
B) Historical-knowledge-as-of (requires both booked_on <= cutoff and recorded_at <= cutoff; subsequent edits/deletes require versioned/reversal state).

Do not silently conflate these. The user's examples favor option B for new activities; maintain an auditable accounting-effective-date basis separately where necessary. Company-local day boundary and timezone must be explicit. For missing/legacy recorded timestamps, show data-quality warnings rather than fabricated times.

## Handoff / work boundaries

- Phase 2: one validated asOf date contract, timezone, effective-vs-recorded policy, historical query interface, consistent error handling. Remove response interception once a single dated response can be produced safely.
- Phase 3: customer / supplier / employee balances and payroll detail; use stable authoritative transaction inputs and consistent multi-currency basis.
- Phase 4: immutable or reconstructible raw-material and bale stock movements, historical unit valuation, Balance on Table.
- Phase 5: dated supplier container lifecycle/OTW, order lifecycle, scanned bale events (including partial loading/cancellation).
- Phase 6: voucher-backed liabilities/deposits/loans, fixed assets, rental contracts/prepaid balances, worker advances and payroll payable.
- Phase 7: propagate report date to all rows and breakdowns; keep grouped UI/toggle; choose cache invalidation consistent with historical corrections.
- Phase 8: live historical availability audit, read-only reconciliation, migration/backfill where evidence exists, indexes/performance; report irrecoverable gaps.
- Phase 9: targeted manual/reconciliation verification only; do NOT trigger CI/workflow or full test suites. Claude will handle CI.

Contract invariants: SUM(asset rows) = forUs.total = forUsTotal; SUM(liability rows) = onUs.total = onUsTotal; netPosition = forUsTotal - onUsTotal; category breakdowns match their member rows. Custom hidden-row subtotal is intentionally a separate what-if projection and must use the SAME dated base amounts. Current-date results should not regress. No postings or source mutations from read-only snapshot operations.

## Audit completion and limits

Completed: traced route mount, date picker, request cache keys, middleware sequencing, backend response assembly, ledger party helpers, supplier settlements, stock/raw inventory, production WIP, OTW, unfinished orders, prepaid rent, employees/payroll, worker advances, account classification, date/history columns and grouping UI. Created and documented a gap/phase map for all ten owner categories plus adjacent fields.

Not performed in this source-only Phase 1: production DB SELECT reconciliation, production application browser verification, CI, automated/full test suite, schema changes, data migrations, accounting voucher changes, merge or deployment. No real transaction amounts were altered.
