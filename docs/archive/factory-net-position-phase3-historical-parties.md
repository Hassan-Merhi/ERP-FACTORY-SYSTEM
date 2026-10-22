# Factory Net Position — Phase 3: Historical Parties

Branch: `feature/factory-net-position-historical`  
Status: Phase 3 source implementation committed; database reconciliation and CI intentionally deferred.

## Rule

An October 19 snapshot includes customer/supplier/employee financial movements **recorded by the end of October 19 in the company's local time**, with business/effective dates no later than October 19. An October 20/21 transaction may never enter a previous date merely because its voucher/payment was backdated. The existing current-day source rules and amounts are preserved.

All changes are read-only. No ledger vouchers, entries, balances, suppliers, customer orders, or employee caches were rewritten.

## Implemented

### 1. Customer Accounts (asset and customer credit)

- Opt-in `knownAt` added to `PartyBalanceQuery`/`BalanceScope` in `ledgerBalanceEngine.ts`.
- The historical party ledger counts only vouchers satisfying both booking date and voucher `created_at`, additionally rejecting post-cutoff voucher entries and honoring voucher retirements after the cutoff. Ordinary statements with no `knownAt` keep their existing effective-date-only behavior.
- Master customer openings are excluded if the master was created after the cutoff.
- `getCustomerLedgerAndMemo` accepts this same optional scope; it remains the existing Party-page authoritative split, not an unrelated replacement formula.
- Customer memo invoice/cache rows require source `created_at` within cutoff; voucher-linked memo exclusion checks the dated voucher's original record time. Future-deleted memo rows remain visible where an actual deletion timestamp exists.
- `heldUnfinalizedCustomerCharges` dates the eligible vouchers, voucher entries, and order creation consistently and considers finalization events after the cutoff. The projection still leaves trial-balance vouchers unchanged.
- Main net-position route filters out customers first created after the cutoff; a customer soft-deleted after the cutoff is kept in historical views. Customer-owned ledger account IDs are excluded from parallel ledger presentation, avoiding customer double-counting.

### 2. Normal Suppliers and Supplier Overpayments

- The existing statement/settlement currency pooling formula is retained: USD + sum(native pool × confirmed settings rate), with positive payable under What We Owe and negative under Supplier Overpayments.
- Historical scope is passed through `computeNetPositionSupplierBalances`, `loadSupplierSettlementBalances`, and `buildBrokerStatement`.
- Supplier/linked-supplier masters and containers created after the cutoff are excluded. Where soft deletion timestamps exist, later-deleted containers remain visible on earlier dates.
- Direct payments and supplier FX transfers require both their effective payment/FX date and actual creation time to be <= cutoff.
- Supplier vouchers require booked date, voucher creation time and entry creation time within cutoff; vouchers retired later can remain visible in earlier reports. The pre-existing exclusions of FACTORY-PAY / FACTORY-SFX / FACTORY-PAYABLE-RECLASS / FACTORY-CORRECTION entries avoid double counting against operational payments.
- Commissions and additional charges use their individual creation times. Existing broker grouping and linked-supplier rollup stay in effect.
- Current-day supplier directory parity remains the same: `knownAt` is opt-in for the historical Factory Net Position only.

### 3. Employee Receivables and Payroll Payable

- New `server/services/factory/netPositionEmployees.ts` is a single signed employee read model for both the main Net Position and `/api/factory/net-position/payroll-breakdown`.
- Today continues to read `employees.current_balance`, preserving existing payroll parity.
- Prior days reconstruct **employee opening balance + qualifying voucher credit - qualifying voucher debit**. Employee and voucher/entry record timestamps and voucher booked dates must satisfy the shared historical cutoff.
- Legitimate historical legacy EMP-<code> ledger vouchers that modified employee balances are included once; the main ledger account projection subtracts their duplicated historical **movement** but keeps ledger-account opening balances.
- Positive employee balances = Payroll Payable liability; negative employee balances = Employee Receivables asset. Neither projection silently uses currentBalance for historical dates.
- Payroll breakdown now returns its resolved `asOf`, uses the same service/positive-only rows, and rejects invalid/future dates under the same shared rules.

### 4. Integration and contracts

- The main Net Position endpoint applies the same `FactoryNetPositionAsOf` to all Phase 3 calculations.
- Its historic customer, supplier, employee and payroll rows feed the existing `forUs`/`onUs` response and summary calculation without changing category names, types, FX configuration, sorting or the Cost/Selling price toggle.
- Historical views continue to return `historyCompleteness: "partial"`. This is intentional: inventory, container lifecycle and mutable master edits require later phases.
- Updated affected repository source-characterization fixture and route test assumptions for historical `knownAt` signatures. Added a focused employee historical date/signed-balance test file. **None executed**, as directed.

## Acknowledged history limits for Phase 8 / later phases

The original database stores some *current mutable values without a complete prior-version log*, such as changed customer openings, edited supplier openings, broker relationships, container price/charge edits, deleted/recreated records, some historic customer/order status transitions, and incomplete legacy memo/employee transaction provenance. These cannot be guaranteed as exact historical-knowledge snapshots solely by applying date filters.

A container's lifecycle and event values are assigned to Phase 5; raw material/stock to Phase 4; assets/deposits/loans and factory worker advances to Phase 6. Historical data completeness, migration/replay and original source reconciliation are Phase 8 work. Keep the visible partial warning until those conditions are satisfied; never silently fake an earlier balance.

## Deferred verification examples for Claude (do not run here)

1. Create a $100 customer invoice on Oct 21 with an Oct 19 document date: the Oct 19 customer balance stays unchanged; Oct 21 includes it.
2. Pay a supplier on Oct 21, with a receipt dated Oct 19: the supplier debt remains unchanged on Oct 19, decreases on Oct 21. Verify EUR/AUD settings and overpaid-to-owed side switching.
3. Record employee withdrawal on Oct 20 and deposit on Oct 21: Oct 19 shows neither, Oct 20 shows the withdrawal, Oct 21 shows the deposit as well.
4. Check every positive employee row in payroll breakdown sums to the Payroll Payable aggregate in the main response for the same company and cutoff; employee negatives appear only on asset side.
5. Confirm a later-retired voucher still appears in the earlier historical snapshot (where the creation/deletion audit timestamps are available) and not in current live balances.
6. Check broker linked-supplier settlement and original currency logic are unchanged for today. Investigate source tables that lack version history before claiming historic precision.
7. Check asset and liability category sum invariants and confirm no duplicated EMP-coded or customer-linked ledger movement.
8. Run established tests/CI only during Claude's later verification process.

No CI, tests, merge, deploy, or production database writes were performed.
