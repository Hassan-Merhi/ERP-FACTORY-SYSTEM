# Permissions V2 — security and regression test report

Date: 2026-11-07 · Branch `claude/modest-cerf-ftyp48` · PostgreSQL 16 (local, isolated) · Node 22 locally, Node 24 in CI.

All results below were produced by running the commands shown. "Local" means a throwaway database on this machine; none of it is staging evidence.

## Roles covered

Developer, Admin, Owner, Manager, POS, Normal User, View Only, ERP Tester and Create Only, each signed in to the same company over HTTP against the real application (`tests/access-control-v2-role-matrix-http.test.ts`).

## Security scenarios

| # | Scenario | Result | Evidence |
|---|---|---|---|
| 1 | Unauthorized direct API calls | Pass | View Only refused on every registered write route (1,000+); Create Only on 1,100+ (`create-only-http`); user and role administration refused for all but Admin/Developer |
| 2 | Cross-company requests | Pass | Body `companyId`, query `companyId` and company switch to a non-member company refused for every role; other company's data fingerprint unchanged |
| 3 | Company switching and stale sessions | Pass, **fixed** | A session demoted to View Only or ERP Tester while open kept its old writes if session removal failed. The tenant boundary now refuses them against the canonical role (`VIEW_ONLY_WRITE_DENIED`, `ERP_TESTER_SETTINGS_DENIED`). Create Only already had this check |
| 4 | Location and POS cashbox restrictions | Pass (existing suites) | `pos-operational-permission-policy`, `operational-permission-scope-http`, `properties-rent-cashbox-policy` in the full backend run. Not repeated on staging |
| 5 | Editing existing records | Pass | View Only and Create Only refused on supplier/customer edits, including a record the Create Only user just created |
| 6 | Deleting existing records | Pass | Same, for deletes; fingerprints unchanged |
| 7 | Finalize, approve, reverse, void | Pass | Voucher reverse/delete and stock-transfer bulk approve refused for read-only roles; every such route refused in the manifest sweeps |
| 8 | Bulk actions and imports | Pass | Covered by the manifest sweeps; Create Only import/bulk feature keys always denied |
| 9 | Offline synchronization | Pass (existing suites) | Phase 9 apply handlers refuse View Only and Create Only actors (`PHASE9_ACTOR_ROLE_NOT_PERMITTED`) |
| 10 | Unauthorized employee and user management | Pass | Owner, Manager, POS, Normal User, View Only, ERP Tester and Create Only cannot create users or assign roles; Admin cannot grant Developer or assign in another company; self role change and last-Admin removal refused |
| 11 | Forged roles, company IDs, client dates | Pass | Forged role headers and body fields ignored; `/me` reports the canonical role; forged `X-Client-Date` cannot widen Create Only's "today" (`create-only-activation`) |
| 12 | Concurrent permission changes | Pass | Two saves on one revision: exactly one wins, the other gets 409; two Admins demoting each other at once: exactly one succeeds |
| 13 | Unavailable permission service / database failures | Pass | Enforcement fails closed with 503; missing V2 schema falls back to legacy decisions; `ACCESS_POLICY_SCHEMA_REQUIRED` for policy storage |
| 14 | Closed periods and protected document states | Pass (existing suites) | `accounting-closed-period-guard`, `fiscal-period-close-reopen` and document-state suites in the full backend run |

## Business integrity

Per-company row count and md5 fingerprints were compared before and after every refused attempt for: vouchers, voucher entries, ledger accounts, suppliers, customers, stock items, inventory, valuation movements, canonical stock movements, bales (ERP, factory, production), containers (ERP, factory), payroll (ERP, factory), employee, worker and target bonuses, rental units, contracts and payments, closed periods, role feature permissions and company roles. **No refused request changed any of them.**

A verified Create Only customer create changed exactly `customers` (+1) and at most `ledger_accounts`; nothing else moved, and the new record could not then be edited or deleted.

V2 enforcement (company active, switch on) refused a denied supplier create with the supplier count unchanged; rollback restored access on the next request with no deploy.

## Legacy role parity

With `PERMISSIONS_V2_ENFORCEMENT=enabled` and the company in shadow mode, Developer, Admin, Owner, Manager, POS, Normal User and ERP Tester returned identical status codes for list, create, edit, delete and voucher reads as with the switch off.

## Suites run

| Suite | Result |
|---|---|
| All `tests/access-control-v2-*` (including the four new suites) and the other permission, tenant, role-administration and ERP Tester suites | Pass |
| Full frontend suite (`vitest.config.frontend.ts`) | 338 files, 3,236 tests: all pass |
| Full backend suite (`vitest.config.ts`) | Still running when this report was committed: 2102 tests passed and 0 failed so far. The final result is recorded on the pull request and in CI's "Backend / Database Tests" job. |
| `npm run verify:permissions-shadow-migration` | Pass (both migrations, RLS, triggers, store checks) |
| Staging certification rehearsal (`CERT_MODE=rehearsal`) | Every step pass (not staging evidence) |

No test was skipped, weakened or given a larger allowance to pass. One existing suite (`voucher-purchase-adjustment-update-routes`) failed against the first version of the stale-session fix, which pre-empted each route's own View Only check; the fix was narrowed to stale sessions only, and the suite passes unchanged.
