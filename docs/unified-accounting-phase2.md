# Unified Accounting — Phase 2: Posting and Voucher Lifecycle

**Branch:** `feature/unified-accounting-erp-factory-rentals`
**Scope:** ERP + Factory + Rentals (ERP, Factory and Properties rental origins).

## Implemented

### One central posting engine remains authoritative

This phase **reuses**, rather than rewrites, the established shared accounting services:

- `postBalancedVoucherTx`, `createDatabasePostingDependencies`:
  decimal debit/credit balancing, company ownership, source identity,
  fingerprint, transaction-scoped advisory lock, posting audit and closed-period
  protections.
- `postErpVoucherTx` / `postErpEntriesTx`: ERP transactions and Rental postings.
- `postFactoryVoucherTx`: Factory and Supplier Partner voucher postings using
  their historical FX convention, native document amount, and posting identities.
- `voucherCorrection.reverseVoucherTx` for explicit mirror reversals and
  `retireVouchersTx` for deletion/replacement of source-owned vouchers.
- Ledger integrity guards, perpetual-inventory reconciliation, and account
  classification remain the same. No cutover or new accounting tables.

### Rental immediate payment atomicity

Previously, new rental payment rows and monthly ledger allocations were saved
in one transaction, then a second transaction posted the voucher and changed
those rows to POSTED. A failed voucher posting left an intermediate SCHEDULED
group behind.

Now immediate payments create payment rows, update monthly rent totals, post
voucher entries through the existing central engine, and stamp the payments
POSTED in **the same transaction**. Any error in that transaction rolls back
those changes together. Future-dated payments still remain SCHEDULED and are
posted later using the same posting function.

A contract-scoped transaction advisory lock serializes allocation creation for
the same contract before the due-month calculations. Source rows for a scheduled
group are now locked and restricted by company and module. Scheduler lookups
also require an eligible owning/linked contract.

### Payment-request idempotency without a data migration

- `clientRequestId` is supported on single and bulk rental-payment requests.
- The two existing Rental payment forms send stable request IDs for retries of
  unchanged user input. Each bulk line has a different request identity.
- With a request ID, the server derives a `PG2-` group identity from company,
  rental origin, contract, client request ID, and financial payload digest.
- Under an advisory lock, an exact repeat reuses persisted payment rows (whether
  SCHEDULED or POSTED). No second voucher or auto-transfer is created.
- Reusing a request ID with a changed financial payload is rejected as a
  conflict. Legacy clients that omit the field retain their previous behavior.
- Existing `PG-` group IDs and the original six-character voucher suffix
  remain readable and deletable. `PG2-` groups use twenty-character digest
  suffixes to prevent a same-day/contract voucher number collision. Recognition
  voucher creation and rental deletion use the same compatibility helper.

**Idempotency limitation:** the stable request ID must be supplied by the
client. Legacy requests that omit it remain non-retry-safe. An optional
cross-company rental auto-transfer is still deliberately performed *after*
the rental payment has committed and is not rolled back with that payment; its
cross-company financial reconciliation belongs to the planned Intercompany
phase. This phase does not silently alter that existing business rule.

### Audited rental payment cancellation

`rentalPaymentDeletionService.ts` now calls the existing `retireVouchersTx`
inside its caller-owned transaction for:

- Payment vouchers that no other active payment row references.
- Associated advance-clearing and advance-recognition vouchers.
- Legacy prepaid recognition/reclassification repair vouchers.
- Existing from/to intercompany transfer vouchers (previously already using
  `retireVouchersTx`) remain included in the same delete transaction.

Retirement retains the historical voucher and lines, records an actor/reason,
releases its voucher number and durable posting identity, and permits
re-posting of the underlying source without replaying the old deleted voucher.
Rental monthly ledger recalculation and payment row deletion remain in the
same transaction. The existing closed-period guards remain authoritative.

### Refuse inactive idempotency markers

The canonical and legacy posting identity readers now refuse to return an
**inactive (soft-deleted) voucher** as though it were an active, successful
posting replay. Correctly retired legacy vouchers remain eligible for a new
posting generation. Stale markers require deliberate reconciliation, not
a silent re-post or misleading successful response.

### Persist rental origin consistently

Rental payments, guarantees, refunds, deposit-to-rent journals, and
intercompany auto-transfer vouchers now supply the originating
`ERP`, `FACTORY`, or `PROPERTIES` source module to the existing engine.
Already persisted voucher data is unchanged. The generic ERP adapter's
default remains `ERP` for other modules, and the Factory adapter's historical
currency convention remains untouched.

## No accounting data mutation or cutover

- No SQL migrations or updates to historic vouchers.
- No repairs to existing account, supplier, customer, inventory, factory,
  employee, or rental balances.
- No modifications to production data, deployed services or protected `main`.
- No change to historical currency rate convention, cost method, inventory
  quantity, rental charge amount, or company-level Net Position.
- Stock/Factory/ERP source-document posting paths retain their existing
  controls; the work here strengthens the already shared service boundary.

## Handoff to Claude

The owner requested **no CI or test execution by this implementation**;
Claude owns builds, integration verification, migrations where relevant, and
certification. This document records the implementation, not a claim that
the changes have been independently tested.

Suggested areas for Claude's assessment (not executed here): single and bulk
duplicate retries, same request ID with changed payload, different concurrent
payments to one rental contract, same-day rent receipts, scheduled-to-posted
transition, rental payment deletion/re-creation, foreign-currency rental
journals, and closed-period refusal. Existing ERP and Factory voucher
posting, source identity, and reversal behavior must remain unaffected.

## Later-phase ownership

- Phase 3: formal open-item invoice/bill/tenant reconciliation.
- Phases 6-7: ERP and Factory financial inventory/COGS convergence.
- Phase 8: broader Rent accounting policy and tenant/deposit accounting.
- Phase 9: cross-company transfer/consolidation atomic reconciliation.
- Phase 10: full historical dated cost and rent snapshots.
- Phase 13: enhanced period close controls.

Those are *not* silently implemented or implied by Phase 2.
