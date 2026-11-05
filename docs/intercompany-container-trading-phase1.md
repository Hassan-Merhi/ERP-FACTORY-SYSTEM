# Intercompany Container Trading — Phase 1 foundation

Branch: feature/intercompany-container-trading  
Status: Phases 1–4 are implemented in **branch-only code**; Phase 4 includes the paired-payment SQL guards and regression cases. CI and a disposable PostgreSQL run must pass before Phase 4 is certified. Pair trading remains disabled until explicitly configured; historical repair remains disabled. Nothing is merged or deployed.

## Scope and invariants

- Preserve the existing unique physical container number. Intercompany companies must reference one canonical container through intercompany_trades, not create duplicate physical stock.
- Each confirmed container trade belongs to one verified source/destination pair and has linked POs. At most one trade may be active for a container.
- Each source Excel file SHA-256 is unique per source company; each batch/container combination is unique. Confirmation of multiple containers will be atomic in Phase 2.
- All new relationship switches default to OFF. Historical repair additionally requires a verified baseline, named activator, activation timestamp, and configured positive per-item and daily limits.
- The dedicated Shared Charge Editor grant is scoped to an affected relationship and (by default) a specific invoice key. The grantor must be an Owner or Developer in that relationship's participating company. Grants cannot be deleted; revocations identify the revoking Owner or Developer.
- Audit events cannot be modified or deleted. Repair requests start held and may only be marked posted when approval and voucher metadata are present. These are data constraints, not an implemented repair engine.
- Existing vouchers, purchase orders, suppliers, cash, inventories and financial reports are untouched by the additive migration.

## Phase 1 deliverables

1. Drizzle declarations in shared/schema/intercompanyTrading.ts, exported from shared/schema/index.ts.
2. Registered migration migrations/20261105_001_intercompany_phase1_foundation.sql with new tables, foreign keys, indexes, default-disabled activation flags, validation triggers and immutable audits.
3. Focused PostgreSQL regression test tests/intercompany-phase1-foundation.test.ts. It runs the real SQL in an isolated temporary schema in a transaction and rolls back all fixtures.

## Restrictions during subsequent phases

- Do not re-use the old per-company importer for two-company transactions: its existing container-number checks and multi-step writes are not an atomic cross-company import operation.
- Do not enable intercompany trading until Phase 2 has verified posting mappings and the import transaction service can commit both PO sides together.
- Do not enable historical repairs until Phase 7 has implemented evidence checks, open-period posting, daily-cap reservations, approval audit and idempotent execution.
- Do not infer relationships or party accounts from names. All mappings must use verified IDs and company-scoped checks.
- Do not grant invoice access solely by possessing an invoice ID. Phase 6 must verify that the invoice belongs to the granted relationship and all affected containers.
- Do not interpret schema-level authorization as complete request security. Phase 6 must enforce roles on every API read and write and invalidate permissions promptly.
- Do not run the additive migration against production merely to test Phase 1. Use an isolated DB and an audited rollout later.

## Release gates

- Migration registry validation, TypeScript checks, backend regression, formatting, lint, and migration startup checks.
- An isolated PostgreSQL proof of default-off policies, wrong-company account rejection, canonical container uniqueness, grant authorization, immutable audit and held repairs.
- No branch merge or deployment until user authorizes it.


## Phase 2 implementation (same isolated feature branch)

Phase 2 adds the dedicated Properties **Container Trading** workflow, without replacing the existing single-company importer or creating a separate dashboard.

- An authorized Properties Owner/Developer with corresponding destination access explicitly configures the existing source receivable, source Purchases, source sales, source COGS, source accrued-charge liability, destination payable, destination Goods-In-Transit and destination supplier records. Account company ownership and type are validated. The destination supplier must represent the Properties company.
- The original Excel .xlsx workbook is parsed by the existing reader at both preview and confirmation. The user must select an enabled destination **for every container**. One canonical physical container is created in Properties; the destination PO links to its ID rather than creating duplicate stock.
- All original supplier PO groups are retained as separate source POs with a join table preserving workbook identifiers. The destination has one linked PO for each physical container. Company stock items must match valid codes/names and unit-of-measure records before posting.
- Confirmed price is exact: goods plus only explicitly confirmed eligible charges. Unconfirmed spreadsheet estimates remain as evidence, excluded from both sides until the later synchronized-charge workflow. The source resale has zero markup.
- Posting is atomic per workbook: source supplier Purchase vouchers, source at-cost Sales and cost reclassification vouchers, destination Purchase/GIT vouchers, linked POs, PO lines, trade links, charge evidence, batch deduplication and immutable audit records all commit together or all roll back. No bank or cash entries are generated.
- The destination Purchase/GIT voucher debits the destination Goods-In-Transit account and credits the **Hassan Properties supplier subledger** so supplier balances and later supplier payments see the payable. It does **not** additionally credit the configured intercompany payable GL account, avoiding a duplicated liability. The configured payable account remains mapping metadata for reviewed reconciliation and reporting. Its financial posting treatment must be finalized in the reporting/reconciliation phase before consolidation eliminations are enabled.
- Duplicate file hashes and globally unique physical-container numbers prevent re-import. The legacy ERP import log is written once per workbook so the old importer cannot silently import the same original file again.
- Phase 2 accepts **USD invoices and USD-base companies only**. Historical FX is a later phase.
- Old standalone edits of linked PO headers/lines, container charges, vouchers and financial lines, and offloading into inventory are deliberately blocked until the Phase 3/5 coordinated workflows exist. This protects cross-company balances during testing.
- Existing Accounts and Analytics remain authoritative for normal financial information; broader custom reporting follows in Phase 6.

### Phase 2 verification

- tests/intercompany-phase2-container-pricing.test.ts: source PO grouping, charge confirmation, precise cent allocations, no-markup equalities and invalid-input rejection.
- tests/intercompany-phase2-database-guards.test.ts: isolated PostgreSQL proof of wrong-company configuration prevention, source PO provenance, blocked legacy edits/offloads and isolation of unrelated records.
- CI gates: TypeScript type-check, backend/frontend tests, migration registry/startup, formatting, security and build.

**Rollout remains explicit:** this is a development branch with a draft, unmerged PR. No production migration, merge or deployment has been authorized or performed. Historical automatic repairs remain disabled.

## Phase 3 — synchronized linked POs and shared invoices (branch-only)

Status: implemented as feature-branch code; **CI and isolated PostgreSQL certification are required before activation**. Phase 4 payments, Phase 5 offload/cancellation and later historic reconciliation are not enabled here.

- `intercompany_trade_line_links` persists each original Excel row's source/destination PO line identity; editing never infers it by barcode, name or order.
- Linked edits require the complete line set, an expected version, signed-in authorized company, posting date, request key and reason. The server derives both counterparties from the persisted trade.
- Original vouchers remain untouched. Accounting corrections are balanced and append-only: source supplier payable, source receivable/revenue, cost reclassification, and destination goods-in-transit/Properties supplier payable. No payment is fabricated.
- Confirmed shared-charge invoices retain their original external face amount and evidence. A user reviews proportional defaults and may override only if allocations still total the invoice.
- Existing shared allocations remain unchanged after PO goods price edits. Later redistribution needs an explicit, audited Shared Charge Editor authorization and preserves the invoice face amount.
- The database requires transaction-local active revision capabilities for linked PO, line, container cost and charge updates. Legacy uncoordinated editing is blocked.
- Offloaded or non-open POs remain blocked until the separate inventory/COGS-safe workflow exists. Closed accounting periods are enforced by the central posting engine.
- Shared Charge Editor permission is explicit, invoice- or relationship-scoped, and never granted merely by Admin role. Owners and Developers issue/revoke grants.

### Phase 3 release gates

1. Exact money arithmetic and signed reversal checks: `tests/intercompany-phase3-pricing.test.ts`.
2. Fresh-schema SQL triggers and immutable invoice totals: `tests/intercompany-phase3-database-guards.test.ts`, with rolled-back test data.
3. Disposable database end-to-end scenario: import, edit from each involved company, confirm invoice, redistribute, reject stale versions and refuse closed periods.
4. Green TypeScript, formatting, backend, security, route-manifest, i18n and mobile checks, without regressions to existing ERP.
5. No merge, production database migration, deployment, or feature activation without the user's approval.

## Phase 4 — paired actual payments and same-pair credit (branch-only)

Phase 4 is implemented on the independent feature branch only. It has **no migration, merge or production posting** until verified and deliberately activated.

- One confirmed real-world transfer requires explicit evidence of a destination ERP cash/bank **payment** and a Hassan Properties cash/bank **receipt**, each using an active account in its own company. Confirmation creates both central-engine vouchers in **one database transaction** or neither.
- The destination debit is its **Hassan Properties supplier payable**, and the source credit is its **intercompany receivable**. The cash/bank legs are the real, individually selected payment/receipt accounts; credits and allocations never fake a bank/cash posting.
- A stable idempotency key and an immutable fingerprint of the transfer evidence, dates, historical FX, selected accounts and manual allocations prevent accidental double posting or changed-payload replay. The external transfer reference must also be unique for that company pair.
- Payment currency can be USD, CFA or ZMW. The original transaction amount, exchange rate in **transaction units per USD**, posting date, and resulting USD-base amount are preserved. Each company's central posting engine validates current period restrictions.
- Actual payments may be partially allocated to specific outstanding linked PO(s), selected by the user. Excess remains **unallocated credit belonging only to this specific Properties–destination pair**.
- **On new container import only**, existing unapplied credits in that pair are applied oldest first. This step creates allocation evidence only; it does not move any cash/bank balance.
- **On PO price decreases**, existing allocations are preserved wherever possible. If they exceed the new PO cost, the excess is released to its original payment/credit pool. Such credit is not automatically moved to another existing PO during edits.
- Reversal requires explicit confirmation of **both real-world legs** and a documented permissible reversal date. It posts two balanced append-only reversal vouchers, releases only that payment's PO allocations, retains the original financial vouchers and historical FX, and is itself idempotent and audited.
- Database triggers prohibit allocating HADI money to Kinshasa or vice versa, spending one cash receipt twice, keeping paid allocations after full reversal, editing allocation history, and uncoordinated editing/deletion/reversal of either mirrored voucher.
- Cancellation and destination-change credit carryover hooks are reserved for Phase 5; their company-pair isolation remains mandatory. Phase 4 does not silently reassign physical container ownership.

### Phase 4 verification

1. `tests/intercompany-phase4-payment-money.test.ts`: historical exchange rate conversion, exact cent-level manual allocations, overpayments, and oldest-first credit use.
2. `tests/intercompany-phase4-database-guards.test.ts`: disposable PostgreSQL schema with all four migrations, wrong-pair refusal, immutable actual voucher evidence, overpayment refusal and paired reversal.
3. Manual staging checks must cover two-side bank/cash postings, partial allocations, credit before new import, independent ERP destinations, stale edits, closed-period reversal, FX retention, simultaneous payment attempts, and no unintended cash entry.
4. Phase 4 is not certified until TypeScript, backend/DB, route security, formatting, translation, mobile and account balance tests pass. `main` remains untouched until explicit user permission.

## Phase 4 isolated validation and rollout hold

**Current release status: NOT CERTIFIED.** Code in this feature branch is not evidence of successful staging database, account-balance or production checks. The draft PR is intentionally not to be merged, and no production migration or activation is authorized.

### Automated checks required on the exact candidate commit

1. Run `npm ci`, `npm run check`, `npm run format:check:changed`, `npm run lint`, `npm run verify:migrations`, `npm run verify:startup-migrations`, `npm run check:security`, `npm run audit:write-routes`, `npm run audit:company-scope`, and `npm run build` as appropriate to the repository's CI matrix. Do not waive ratchet or security gates to get green.
2. Run `node node_modules/vitest/vitest.mjs run tests/intercompany-phase4-payment-money.test.ts tests/intercompany-phase4-database-guards.test.ts` against a **disposable PostgreSQL instance** with `DATABASE_URL` defined. The database-guard suite skips its SQL case if `DATABASE_URL` is not set: a green skipped run **does not count** as certification.
3. Also rerun Phases 1–3 tests and the existing backend/frontend accounting and authorization tests. Record commit SHA, run URLs, summary and any failures. CI queued or cancelled is **not** a pass.

### Manual staging acceptance matrix

Use isolated test companies and fresh non-production accounts. Record the original cash, bank, receivable, supplier, GIT and voucher balances for BOTH companies before each scenario, then compare balances and journal entries afterwards.

| Scenario | Expected proof |
| --- | --- |
| USD 120 transfer, allocate 80 to an outstanding PO | Exactly one destination Payment (Dr supplier 120 / Cr selected bank 120) and one Properties Receipt (Dr selected bank 120 / Cr receivable 120); remaining same-pair credit 40; replay with same key creates no voucher |
| A second ERP destination pair | Its trade cannot spend the first pair's 40 credit, even with an otherwise valid trade ID |
| CFA and ZMW with recorded historical rates | Original currency, exchange rate and date remain visible; USD amount is rounded once to cents and both voucher totals agree |
| Next new-container import | Oldest eligible credit for that exact pair is allocated without any additional cash or bank voucher |
| Linked PO price reduction | Excess paid allocation returns to original pair credit; original cash and supplier vouchers do not change |
| Stale trade version, disabled pair, different company, duplicate transfer reference, invalid FX or invalid ledger mapping | Whole operation rejected, with no single-sided payment or credit mutation |
| Reverse a confirmed transfer | Evidence of both real-world returns, valid open posting date, two opposite append-only vouchers, zero net allocations; repeated reversal key is idempotent; altered replay is rejected |
| Closed-period reversal, failed posting engine call and two competing confirms | Whole transaction rolls back; no partial real-money entry, no over-allocation and no orphan paired payment |
| Existing ERP Daybook, supplier payment and Properties balances | Legacy vouchers remain unchanged; no unrelated purchase, sales, inventory or credit change |

### Release/rollback boundary

- Before any deployment: review the additive migrations in order, capture database backup and baseline accounting totals, verify flags remain OFF, and have a named owner approve a **separate** staging test plan. Avoid live bank/cash confirmation until independent accounting sign-off.
- A failed staging check means stop, disable feature access, preserve audit evidence, and repair via a reviewed follow-up migration or compensating entries. **Do not delete confirmed payments or drop applied financial tables to roll back real transactions.**
- Phase 5 cancellation/offload and Phases 6–8 reconciliation/historical repair are outside this Phase 4 acceptance. Do not enable those workflows through a Phase 4 sign-off.
- Completion requires a passing commit-specific CI matrix, real PostgreSQL and staging ledger acceptance results, and explicit owner approval. Until then, keep the draft PR unmerged and avoid production activation.
