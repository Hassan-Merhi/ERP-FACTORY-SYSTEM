# Unified Accounting — Phase 3: Customer, Supplier and Tenant Open-Item Reconciliation

**Branch:** `feature/unified-accounting-erp-factory-rentals`
**Scope:** ERP, Factory, Rentals (ERP / FACTORY / PROPERTIES rental origins)

## Implementation

### Existing accounting remains authoritative

Phase 3 builds a **document-matching subledger on top of posted voucher
entries**, not a new general ledger, a balance repair, or a replacement for
`partyReconciliationService.ts`. That existing service still compares the
canonical GL balance against projections. Phase 3 answers a different
question: *which specific posted charge is this payment or credit settling?*

New files:

- `server/services/accounting/partyOpenItemService.ts`
- `server/services/accounting/ensurePartyOpenItemSchema.ts`
- `server/services/rental/rentalOpenItemsService.ts`
- `server/routes/accountingOpenItemRoutes.ts`
- `client/src/pages/AccountingOpenItems.tsx`

Routes and navigation are integrated in ERP, Factory, and Properties
under their existing accounting shells and permissions.

### Posted ERP customers, ERP suppliers and Factory suppliers

The shared service reads live, non-optional voucher entries using the
**existing partyLineRules owner/priority predicates**. This avoids
double-counting customer-tagged bank or other-account lines and respects
customer-owned linked ledger accounts.

- Customer charges = customer-owned debits; payments, refunds, credits =
  customer-owned credits.
- ERP / Factory supplier charges = supplier-owned credits; payments / credits
  = supplier-owned debits.
- Journal descriptions are not used to infer party ownership; the voucher
  line, party identity, and live posted state are required.
- Factory customer charges tied to unfinalized orders are excluded via the
  existing `loadHeldChargeSnapshot` projection. **No unfinalized charge may
  be matched while it is held out of customer statements.**
- Charge/settlement lines are displayed separately with original, matched,
  remaining, currency, status, voucher link, and linked match records.
- `open`, `partial`, `settled`, and `inconsistent` statuses are distinct.
- For customer invoices typed Sales/Sale/Invoice where a nonnegative
  `payment_terms_days` exists, a due date and days overdue are shown.
  Supplier terms stored as free text are **not** guessed into due dates.
- Legacy party opening balances are displayed separately, never fabricated
  into invoice lines or silently matched. Open-item totals are therefore **not
  advertised as equal to the total party GL balance** until opening balances,
  unposted operational memos, and legacy data are reconciled separately.

**Factory currency caution:** Matches are never used to recompute Inside,
Outside, or supplier FX exposure. When native original currency amounts are
available on voucher entries, they are used. A legacy non-USD line missing
native amounts displays its USD base with `currencyVerified=false` and is
**not matchable** until appropriately reviewed. Two entries in different
native currencies cannot be allocated together. Phase 5 owns true
cross-currency settlement and realized FX gain/loss posting.

### Durable matching metadata

New additive table: `accounting_open_item_matches`.

Each match records company, party domain, party ID, both voucher-entry IDs,
native currency, exact decimal amount, business date, idempotency key,
creator, and optional reason.

- Amount must be positive, at most six decimal places, and cannot exceed
  the remaining charge or available settlement.
- Both entries must be live, company-owned, correctly attributed to the
  **same party**, opposite sides, and in the **same verified currency**.
- The company and party are locked for allocation, preventing concurrent
  over-application on the same account.
- Exact retries with the same request identity return the same match;
  conflicting retries are refused.
- Unmatching is **soft-voided**, requires a reason, records who and when,
  and leaves the voucher/entry rows untouched.
- Matching and unmatching reject closed fiscal periods through the
  existing database period guard.
- Entries removed/retired later no longer contribute active allocations.
- The as-of query uses the stored match date and void date, so a match
  cancelled later remains visible for dates before that cancellation.
- Both creation and void write an explicit audit event in the same transaction.

There is **no automatic GL voucher, balancing entry, credit note, cash receipt,
FX conversion, inventory valuation, or customer/supplier balance change**.

`ensureRuntimeSchema` creates this separate metadata table idempotently at
startup, because bulk migrations are disabled in some production deployments.
The change creates no rows, does no historic backfill, and does not change
existing voucher tables.

### Rentals — reuse the month allocation ledger

Rental receivables and payments are already organized by contract,
`property_monthly_ledger` (due periods) and `property_payments` (splits).
Rather than write duplicate matches, this phase exposes a read-only
contract-month view with:

- Due date, expected rent, posted-paid, outstanding and full/partial/unpaid
  status.
- Payment IDs linked to each due month.
- Contract/module/company scope including known linked-company relationships.
- Historical as-of date, excluding future charges and payments.
- Prepaid amounts allocated to months outside the due window shown separately.
- Original contract/payment currency preserved, and mixed currency
  inconsistencies refused rather than silently converted.

Scheduled payments and guarantees are not treated as received rent merely
because a payment row exists. Rental security deposits remain their own
liability/asset accounting, not rent receipts.

### Endpoints

Privilege: **Admin, Owner or Developer**, company from the authenticated
session. No user-selectable company ID is trusted.

- `GET /api/accounting/open-items?domain=customer|supplier|factory_supplier&partyId=123&asOfDate=YYYY-MM-DD`
- `GET /api/accounting/open-items/rentals?module=ERP|FACTORY|PROPERTIES&contractId=123&asOfDate=YYYY-MM-DD`
- `POST /api/accounting/open-items/matches` with
  `{domain,partyId,chargeEntryId,settlementEntryId,amount,idempotencyKey,reason?}`
- `POST /api/accounting/open-items/matches/:id/void` with `{reason}`

Both write operations use the current company's transactional business date,
not a client-provided backdate.

UI paths:

- ERP: `/accounting/open-items`
- Factory: `/factory/accounting/open-items`
- Properties: `/properties/accounting/open-items`

The Accounts screen also links to the new tool. ERP and Properties navigation
have dedicated entries. Factory uses the existing Accounts access key/alias
rather than creating a separate unrestricted permission key.

### Source-of-truth and limitations

This matches **posted voucher entries**. It is not an automatic assignment
algorithm, and existing documents remain unmatched until an authorized user
records a match. No historical matches are fabricated. Document-level opening
balances, pre-cutover foreign currency, off-ledger memo transactions, and
cross-company supplier arrangements require reviewed accounting treatment,
not synthetic entries. A historic as-of result can also be limited when
source vouchers were subsequently retired (Phase 10 owns full history).

The provider's customer and supplier balance computations remain unchanged.
This is particularly important for Factory supplier balances involving multiple
currency buckets and inside/outside settlement logic.

### Claude handoff (no checks were run)

Owner explicitly delegated build, CI, automated tests, and certification to
Claude. Implementation was committed on the shared feature branch without
merging into main or deploying to Render. Claude should independently
certify the database schema, source ownership SQL, cross-company access,
partial allocations, over-allocation concurrency, fixed and native FX,
unfinalized charge exclusion, cancellation history, rental linked-company
periods, role gating, and frontend route compilation.

**No automated checks, CI, manual production transactions, historical accounting
repairs, merge, or deployment were performed in this phase.**
