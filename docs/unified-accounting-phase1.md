# Unified Accounting Foundation — Phase 1

**Branch:** `feature/unified-accounting-erp-factory-rentals`

## Scope and decision

ERP, Factory, and Rentals will share **one existing company-scoped ledger and one
existing central posting engine**. Rentals is a business domain with three
operational origins: ERP, FACTORY, and PROPERTIES. It is **not** a fourth voucher
store, a new company, or a new ledger.

This phase adds a single semantic foundation without changing journal postings,
opening balances, fiscal-close logic, inventory valuations, rental payment
allocations, or existing reports.

## Existing authoritative systems (reuse, never replace)

| Concern | Existing service | Phase 1 integration |
| --- | --- | --- |
| Voucher source/amount types | `accountingTypes.ts` | Retained without additional voucher columns |
| Debit/credit and durable identity | `centralPostingEngine.ts` | Remains the only strict posting engine |
| ERP and rental voucher entry adapters | `erpVoucherPosting.ts` | Still used by ERP and Rentals |
| Factory voucher entry adapter | `services/factory/factoryVoucherPosting.ts` | Still used by Factory |
| Account classification | `accountClassification.ts` | Used by the new financial statement category helper |
| System account creation | `systemAccounts.ts` | ERP and Factory roles now reference shared codes |
| Rental account creation | `routes/rental/shared/ledger.ts` | Existing by-name resolution and generated codes are preserved |
| Rental scheduler | `services/rental/dueRentalPosting.ts` | Uses shared rental account names |
| Period locks, reconciliation and auditing | `periodLockService.ts`, `partyReconciliationService.ts`, `perpetualInventory/` | Remain intact; extended in subsequent phases |

The shared contract lives at
`server/services/accounting/unifiedAccountingFoundation.ts` and is exported
by `server/services/accounting/index.ts`.

## Account categories

`financialStatementCategory({ code, accountType, subType })` derives:

- **asset**, **liability**, **equity**, **income** and **expense**, using the
  existing `classifyAccountType` service;
- **cost_of_sales**, specifically for COGS-type accounts, the `COGS` ledger
  code and the `RETAIL-COGS` ledger code;
- **party** for customer, supplier, and intercompany accounts with a
  balance-dependent side;
- **unknown** for genuinely unclassified legacy account types.

Cost of sales remains classified as **expense** by the existing ledger and
fiscal-close engines. This helper is a reporting distinction, **not** a change
to debit/credit behavior. Direct Expense is **not** automatically COGS:
freight, production losses, duty, and non-capitalizable charges may require
their own policies in later phases.

Never silently retype legacy accounts or rewrite historical transactions to
make them match a category. Unknown classifications must stay visible until
resolved through an authorized change.

## Account-role definitions

The `ACCOUNTING_CONTROL_ACCOUNTS` mapping supplies stable semantic roles.
ERP and Factory values are exact established ledger codes, also referenced by
`SYSTEM_ACCOUNTS`:

| Domain | Roles |
| --- | --- |
| ERP | Purchases, Inventory, Goods in Transit, COGS |
| Factory | Factory Goods in Transit, Raw Material Stock, WIP, Finished Goods, Bale Sales Income, Production Variance |
| Rentals | Rent income, rent expense, accrued rent, rent advances, prepaid/deferred rent, security deposits |

**Rental difference:** Rental accounts are looked up by their **name**. If
missing, `findOrCreateLedgerAccount` generates a unique code from a prefix
and a timestamp. Therefore RENT-INC etc. in the rental role registry are
**creation prefixes, not guaranteed complete account codes**.
`RENTAL_ACCOUNT_PREFIXES_BY_ROLE` is the single source of those variants,
including ACC-RENT-PAY/ACCR-RENT-PAY and PREP-RENT/PREPAID-RENT.
`isRentalPostingAccountCode` recognizes fixed and generated-prefix variants,
and `isSystemResolvedAccountCode` protects them from changes through the
ordinary ledger code editor. This does not create or edit accounts.

The three rental route registrations, plus the daily rental scheduler, now use
`RENTAL_MODULE_ACCOUNTS` for their existing income/expense **names**.
There is no forced merging of ERP rents, Factory rents, and Properties rents.

## Voucher provenance

`describeAccountingPosting` derives a **read-only** business domain from
the voucher's existing `sourceModule`, `sourceType`, `sourceId`,
`companyId`, `effectiveDate` / `voucherDate`, and `currency` fields.

- `rental-*` / `rent-*` source identities are Rentals even if their stored
  source_module is `ERP` or `FACTORY`.
- `PROPERTIES` source_module is Rentals.
- Other `FACTORY` and `ERP` source_module values preserve their respective
  accounting domain.
- Unrecognized source_module values become `UNKNOWN`; source identities are
  **not** guessed from descriptions or account names.
- Effective business date uses the stored effective date when present, else
  voucher date; transaction currency is preserved if recorded.
- Rental origins retain their original ERP/FACTORY/PROPERTIES scope when the
  stored source_module is known. Older rental vouchers without a known origin
  are not silently assigned an origin.

This function is a projection for subsequent phase reporting and convergence.
It **does not** change stored source_module or posting identity. Source
identities continue to be owned by the existing central posting mechanism.

## Phase 1 production impact

- No database migrations.
- No automatic account creation, currency conversion, historical backfill,
  voucher repair, journal entry, or period reopening.
- No change to authorization, inventory movements, business dates,
  cost calculation, company scoping, Net Position, or rentals allocations.
- No change to existing `source_module` values in persisted vouchers.
- Phase 2 will migrate/strengthen posting flows incrementally rather than
  bypass the central engine.

## Handoff

Changes are committed to the Phase 1 branch. Automated checking, CI, running
tests and independently certifying behavior are reserved for Claude as
requested. Code implementation is complete for this foundation; it is not
represented as independently tested or production-deployed.
