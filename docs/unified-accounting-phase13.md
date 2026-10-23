# Unified Accounting — Phase 13: Fiscal Period Closing & Audit Controls

**Repository:** `Hassan-Merhi/ERP-FACTORY-SYSTEM`  
**Branch:** `feature/unified-accounting-erp-factory-rentals` (same as Phases 1–12)  
**Modules:** ERP, Factory, Properties/Rentals  
**Handoff:** Source-level implementation committed. No CI, compilation, tests, merge, rebase, production accounting voucher mutation, manual accounting adjustments, migration execution or deployment were performed by this implementation. Claude is responsible for independent verification, security review, accounting certification and signoff.

## Existing functionality deliberately preserved

The production fiscal close engine is **not replaced**. Phase 13 builds on:

- `server/storage/accounting/fiscal-periods.ts` — `closeFiscalPeriod` and `reopenFiscalPeriod`, controlling exactly one closing journal per period, with an atomic `fiscal_period_closures` record, original opening-side accounting and closing audit.
- `server/services/accounting/closedPeriodGuard.ts` — transaction-safe voucher and voucher-entry DB triggers, company-level fiscal advisory locks and closed period writer rejection, with the documented exceptional reopen override.
- `server/services/accounting/openingBalanceLock.ts` — protects ledger, customer, supplier, bank, employee, Factory supplier and fixed-asset master openings after first close.
- `server/services/audit/voucherAuditTrigger.ts` — voucher/entry DB audit, actor metadata, hash-chain audit log append protections.
- `server/services/accounting/integrity/trialBalance.ts` and one canonical balance service — historical booked debit/credit, master openings, attributed party balances and explicit unbalanced differences.
- `server/routes/financialSalesRoutes.ts` — legacy close/reopen endpoints remain operational unless the owning company **explicitly enables** the reviewed-close policy.

**Phase 13 does not rebuild the posted P&L from Net Position, add operational stock values a second time, rewrite closing vouchers or silently reopen a fiscal period.** Its new close endpoint executes the existing `closeFiscalPeriod` writer inside its original transaction; no separate journal generator was introduced.

## New database schema — additive review metadata

`server/services/accounting/ensureFiscalReviewSchema.ts` is called by the always-on `ensureRuntimeSchema` guard; production need not depend on a bulk migration pass. Four constraints/objects underpin the workflow:

1. `accounting_fiscal_review_signoffs`
   - company, exact period start/end, retained-earnings account, SHA-256 source evidence fingerprint;
   - `ACCOUNTING` or `OWNER` capacity, reviewer ID/name, review note, review date;
   - one live signoff for each capacity and source evidence/version;
   - optional audited revocation, no silent delete or reuse of an already consumed signoff;
   - SQL BEFORE UPDATE/DELETE immutability guard refuses rewrite/delete of
     original reviewer, capacity, period, source hash, note or timestamp.
     The sole permitted UPDATE is an initial revocation with actor/reason,
     and even that is refused after use by a completed reviewed close;
   - the review cannot be used if source evidence changes.

2. `accounting_fiscal_reviewed_closures`
   - exact closed fiscal-period and posted closing voucher IDs, both reviewers, fingerprint, actor and timestamp;
   - inserted **in the same transaction** as the existing closing journal and closure record;
   - retains the reviewed close voucher and evidence if the pre-existing audited reopen removes the current `fiscal_period_closures` row; the FK becomes NULL on reopen instead of blocking it;
   - a database trigger validates source company's closing voucher, separate
     reviewer IDs/capacities, current unrevoked approvals, identical source
     fingerprint and retained earnings/period to the actual closure before
     any reviewed-close evidence can be inserted;
   - a separate immutable-close trigger rejects updates/deletes to reviewed
     evidence (except the FK-null transition caused by audited reopen);
   - reopening does **not** make the old approval valid for another close.

3. `accounting_fiscal_review_policy`
   - optional company policy `enforce_reviewed_close`;
   - defaults to **false for existing companies**; enabling is a separate Owner action with written reason and audit;
   - when enabled, the **legacy** `/api/fiscal-period/close` path is refused unless the reviewed callback is present; the safeguard is enforced inside the original writer, not only at a client route;
   - policy edits and close posting share the exact exclusive company fiscal advisory lock. A policy cannot change halfway through a posting.

4. PostgreSQL tenant and integrity controls
   - `ENABLE ROW LEVEL SECURITY` and `FORCE ROW LEVEL SECURITY` with `company_id = app.current_company_id` policies on all Phase 13 metadata tables;
   - source-record foreign keys for closure/voucher and approvals;
   - unique indexes for active signoffs and reviewed closure evidence, and check constraints on approval capacities and cancellation reasons;
   - no column changes to legacy vouchers, voucher entries, balances or fiscal journals.

All Phase 13 metadata DDL is additive and idempotent. No initial approval, close, reversal, FX conversion or backfill is issued on startup.

## Read-only fiscal-close preflight

New `server/services/accounting/fiscalReviewService.ts` implements a company-scoped, dated readiness workpaper:

- Validates real ISO calendar dates, start not later than end, existing active Equity account owned by the selected company, and end of the requested period **before the current company business date**.
- Enforces period chronology against the most recent **closed** period; requires the next period to begin on the day immediately following its end and refuses another close of the same end date.
- Protects a company's first close from excluding earlier posted P&L activity.
- Uses the **existing** trial-balance reader at the exact period end and reports:
  closing debit/credit difference; opening-balance difference; one-sided-stock and other voucher differences; and assumed opening sides.
- Checks for deleted P&L accounts with remaining recorded balances.
- Uses posted voucher entries from this company through the selected date, excluding optional and retired records, to flag:
  unbalanced balanced-type vouchers, missing/other-company ledger targets, non-USD lines without recorded historical USD base, optional vouchers excluded from books and source-voucher actor provenance gaps.
- The reviewed-close path requires a **USD functional-base company**. The
  existing legacy fiscal close writer currently computes P&L account
  balances using `voucher_entries.debit_amount/credit_amount`. Phase 13
  explicitly checks those against the historic
  `base_debit_amount/base_credit_amount` fields for relevant P&L entries.
  A material difference is a **hard blocker**, not an automatic posting
  correction: Claude must investigate and certify the historical
  conversion and legacy writer before a reviewed close can proceed.
  This protects prior periods from being silently closed at an incorrect
  native/base FX amount.
- Verifies enabled closed-period voucher and voucher-entry guards **on their exact tables**, all **seven** per-master opening-balance locks (ledger, customers, suppliers, banks, employees, Factory suppliers, fixed assets), and all **ten** voucher/entry/audit-log triggers on their intended tables and within the current schema. Checking trigger names alone could have accepted a same-named trigger on an unrelated table.
- Historical foreign-currency translation requires a recorded `base_debit_amount` for each nonzero native debit, and `base_credit_amount` for each nonzero native credit. The original combined-both-null check could miss a partially translated entry with one side missing; such entries now block independent financial signoff.
- Produces a SHA-256 digest across period, retained-earnings account, canonical trial rows and totals, source voucher/entry contents as represented by a deterministic SQL MD5 evidence digest, current guard availability, blockers and warnings. The per-entry digest now serializes a positional JSONB array (retaining the distinction between `NULL` and present values) and includes voucher posting type and creator identity in addition to effective date and original/native book values. This avoids `CONCAT_WS` null-field collisions and invalidates an old approval when such evidence changes.
- Explicitly notes unknown historic contract terms, Factory raw/WIP/bale values, unresolved intra-group profits, bank matching and missing historical FX context rather than inferring that a balanced trial balance certifies every operating source.

Readiness carries `certified:false`, independent blockers and warnings. A preview **never** writes a voucher, freezes the books or approves the period.

### Fingerprint and staleness

The preview's `evidenceHash` must match the hash checked when Accounting or Owner approves. The reviewed-close route checks it **again under the original fiscal closing writer's exclusive company advisory lock**. If any source amount, posted voucher state, master opening, account classification, period closure or material safety control changes before posting, the stale approval is refused.

The fingerprint is a source-integrity safeguard, **not** a cryptographic proof of what every historical record looked like at the original calendar date. Phase 10's immutable-history caveats remain valid. The fingerprint algorithm change deliberately invalidates prior Phase 13 unconsumed approvals: reviewers must regenerate a new evidence preview and sign it again; no existing approval is rewritten. Large company ledgers should be performance-reviewed by Claude because the source entry digest deliberately covers all posted lines through the period end.

### Phase 13 hardening on the existing unified-accounting feature branch

The current continuation strengthens the read-only preflight and its fingerprint, without replacing the original fiscal-close writer, automatically enabling reviewed financial posting or activating the `enforce_reviewed_close` policy. It neither modifies production books nor executes a migration.

Claude must independently verify these newly hardened failure cases:

1. A foreign-currency posted entry with nonzero debit but missing only its base debit, and the equivalent credit-side case; both must report an FX completeness blocker even if the opposite-side base field is present.
2. Missing, disabled or misplaced voucher/entry/fiscal guard triggers, every one of the seven master-opening triggers and all ten audit triggers; readiness must fail closed, not accept a matching name from an unrelated table. All three fiscal-review metadata tables must also have both ENABLE/FORCE row-level security and the required `fiscal_review_company_scope` policy in the current schema; absence of any protection is a hard blocker.
3. A changed posting type/creator (or changed/null source field) must produce a new source digest and approval hash. Existing signoffs must become stale; a signed hash can never be quietly re-used.
4. Legitimate fully populated USD and historical non-USD base entries must not be classified as untranslated solely because the unused debit/credit side has a null base.
5. Full SQL/TypeScript compilation, PostgreSQL transactional locking, concurrent voucher writes versus closing, review revocation versus close, tenant isolation, route permissions, financial posting locks and replay/reopen behavior are **not** established by these source changes.

## Independent review and posted-close workflow

1. **Finance preparer:** An Admin or Developer chooses the company, period, active Equity account and reviews all blockers. A review requires a 10–2,000 character note, its own actor ID and the current SHA-256 evidence hash.
2. **Owner:** A *different authenticated user* with Owner role separately signs exactly that source fingerprint. The same user may not approve both capacities. A duplicate current signoff is refused, and changed evidence invalidates the old signoffs.
3. **Owner reviewed close:** A different explicit action requires all blockers cleared, matching current Accounting+Owner signoffs and typed confirmation `CLOSE YYYY-MM-DD`. Backend Owner authorization is enforced independently of React.
4. The original `closeFiscalPeriod` transaction first obtains the same exclusive fiscal-period advisory lock used by voucher write guards. The optional `beforeClose` callback re-reads current readiness, locks the signoff rows, checks separate reviewers and the exact source hash, and refuses staleness.
5. The original writer creates the real fiscal closing journal, fiscal closure record and its existing audit. The optional `afterClose` callback inserts the reviewed-close evidence and audit record **before the same transaction commits**.
6. If verification, voucher posting, period-closure insert, reviewed evidence or audit insert fails, PostgreSQL rolls back the **whole** transaction. There is no partly completed reviewed close.
7. Closing never performs a historical backfill, adjusting voucher, stock valuation change, account opening rewrite or FX revaluation.

The new reviewed-close process is an **alternative certification workflow** in compatibility mode. An Owner may turn on `enforce_reviewed_close` to require it for ALL future closes, including the legacy API, and can turn that enforcement off only with another explicit Owner action/reason. The existing reopen route still works independently with its previous Admin/Developer permission and mandatory audited reason.

The reviewed fiscal-close event is **evidence of completed dual review under current source data**, not a legal external audit opinion or a certified IAS/GAAP consolidated statement.

## APIs and UI

New `server/routes/fiscalReviewRoutes.ts`, mounted in `server/routes/applicationRoutes.ts`. All routes require authentication and selected-company scope. Factory additionally applies its established Accounts/View Accounts page gate.

| Method | Route | Purpose |
| --- | --- | --- |
| GET | `/api/accounting/fiscal-review/equity-accounts` | Active company-owned Equity accounts for selection |
| GET | `/api/accounting/fiscal-review/readiness?periodStartDate=...&periodEndDate=...&retainedEarningsAccountId=...` | Dated, read-only close-readiness and evidence fingerprint |
| GET | `/api/accounting/fiscal-review/policy` | Company reviewed-close enforcement |
| POST | `/api/accounting/fiscal-review/policy` | Owner-only audited enable/disable |
| POST | `/api/accounting/fiscal-review/signoffs` | Admin/Developer Accounting or Owner approval, separate users |
| POST | `/api/accounting/fiscal-review/signoffs/:id/revoke` | Owner-only audited review cancellation |
| POST | `/api/accounting/fiscal-review/close` | **Owner only**: perform verified, atomic, real fiscal closing |
| GET | `/api/accounting/fiscal-review/history` | Reviewed-close evidence and reopened status |
| GET | `/api/accounting/fiscal-review/audit` | Company fiscal close/signoff/policy audit trail, latest 250 |

New shared React page: `client/src/pages/FiscalCloseReview.tsx`.

| Module | Page |
| --- | --- |
| ERP | `/accounting/fiscal-review` |
| Factory | `/factory/accounting/fiscal-review` |
| Properties/Rentals | `/properties/accounting/fiscal-review` |

The page includes a company-local Equity account selector, period dates, live booked-source diagnostics, database guard status, current/stale signoffs, Owner policy enable/disable with reason, the explicit Owner reviewed close action, reopened close history and an audit event listing. Linked from the shared Accounts UI, ERP/Properties sidebars and Factory access registry.

React Query keys are company-specific. Neither changing companies, reading the readiness report nor opening the signoff tab automatically changes accounting records. Approval/close/revoke/policy operations have separate explicit POST actions.

## Production invariants

- Existing date-lock and opening-balance protection still control all voucher writers and company openings.
- Fiscal close runs only once per company/contiguous period and retains its original atomic posting identity.
- Reopen remains restricted to the **latest** closed period with audited reason. Phase 13 stores reviewed-close history through that reopen instead of inventing a replacement.
- No automatic adjustment from ERP inventory, Factory mix/production, loading, freight, bank reconciliations, Properties rent/deposit, cross-company loans or Net Position.
- Source financial statements in Phases 10/11 continue to exclude fiscal closing journals from period P&L, while retaining the close in balances and equity.
- A pure legacy FX-readiness compatibility gate alone is not proof of valid foreign-currency historical base; the close-readiness source check independently flags missing non-USD base fields.
- Historical fiscal close source audit evidence is **retrospective**, not a complete immutable version history of old master and posting records.
- The Owner enforcement policy is disabled until a real Owner explicitly opts in. Legacy closings under compatibility mode may not carry dual review evidence; absence of a Phase 13 reviewed-close record must never be presented as a past certification.

## Claude source and financial certification checklist (NOT run)

1. Compile TypeScript/React, check all new imports, route order, LazyPage routing, company-session handling, POST permission and UI state changes.
2. Check always-on schema creation idempotency, role flags, review uniqueness, all RLS policies and protected foreign keys; test forced RLS and direct cross-company ID rejection.
3. Validate signoff and reviewed-close database immutability triggers:
   attempted approval rewrite/delete; single audited revocation before use;
   refusal to revoke a consumed signoff; cross-company signoffs; different
   period, wrong Equity account, wrong source hash, same reviewer in both
   capacities; verified closure after audited reopen may only null out its
   current fiscal-closure FK.
4. Verify scope for `closeFiscalPeriod` now explicitly sets transaction-local `app.current_company_id` before reading the RLS-protected enforcement policy; no privileged-role bypass.
4. Compare trial-balance amount/side and P&L categories with existing `buildTrialBalance`, fiscal closing writer and Phase 11 statements for a controlled company/date.
5. Check first-close earliest P&L date, contiguous later periods, duplicate endings, invalid date, business timezone and period date boundary.
6. Test balance-sheet not balanced, deleted Income/Expense accounts, legacy single-sided stock journals, line on wrong-company account, missing historic FX bases and master opening-side assumptions; verify blocking-versus-warning decisions. Explicitly check historical USD base versus legacy fiscal close debit/credit on income/expense lines, and refuse certified closing where they materially differ. Confirm non-USD functional-base companies cannot be reviewed without proper translation.
7. Verify the full set of voucher, entry, hash-chain and opening-balance guard triggers. Never treat a single audit trigger as complete certification.
8. Test that a legitimate source mutation after Accounting signoff invalidates the previous hash; Owner sees it as stale and cannot close without fresh review.
9. Test two approvals by separate user IDs, attempted same-user dual approval, simultaneous approvals, duplicate signoff conflicts, revocation and already-consumed signoff immutability.
10. Test a concurrent financial posting while reviewed close holds the exclusive fiscal lock. The hash check must occur under the lock and all metadata + closing voucher must commit or roll back together.
11. Enable mandatory reviewed close through Owner policy and try the old `/api/fiscal-period/close` path: must be refused. Disable with Owner/reason: existing behavior should resume. Verify concurrent policy change serializes against closing.
12. Reopen a reviewed close using the existing Admin/Developer reopen path and its required reason. The fiscal closure row and date lock may be removed as designed, but retained review evidence must remain, reporting "reopened."
13. Examine correct audit actor/name, financial close, signoff, revocation and policy trail. Verify row-hash audit integrity using existing security tooling.
14. Security/privacy: unauthorized POS/regular users, separate company session, Factory View Accounts permission, cross-company account IDs and source account leaks must all be denied.
15. Confirm no GET/preview/approval call writes an accounting voucher and that the reviewed-close POST invokes only the existing original fiscal writer once.
16. Review financial source completeness with Factory finalized containers, ERP inventory cost, Rentals contract terms, intercompany, historic FX, customer/supplier reconciliation and cash/bank tie-out. A passing trial balance alone is not a formal audit.
17. Review performance on large historic companies: exhaustive read-only voucher-entry source fingerprint may need optimization under load, but must not be weakened into an unsafe timestamp-only hash.
18. Run CI, security tests, finance validation and source review **by Claude**. Do not merge or deploy until accounting and permissions have been certified.

**Phase 13 source-level work is committed on the existing feature branch.
No CI/tests/build/merge/rebase/deployment or production financial record changes were performed.**
