# Permissions Control Center — Phase 7 Verification and Staging Gate

**Status: NOT COMPLETE / RELEASE BLOCKED**  
**Branch:** `feature/permissions-control-center` — draft PR #2480.  
**Policy mode:** shadow-only. Never infer successful authorization from a hypothetical preview.

## Verified by source review / automated test definitions

- `tests/access-control-v2-phase7-middleware.test.ts`: direct denial for edit/delete/reverse/finalize/approve/void/import, create-looking existing-record edits, hard denials, company mismatch and failed membership lookups. The denied request must never dispatch to its business handler.
- `tests/access-control-v2-phase7-release-invariants.test.ts`: registered write route inventory remains deny-by-default for Create Only, no candidate route is treated as handler verified, Create Only isn't selectable, and migration cannot rewrite vouchers, inventory or live role permissions.
- Earlier Phase 2 store tests assert serializable revision-checked policy writes, stale editor rejection, cross-company override denial, self-grants forbidden and append-only audit.
- Phase 4–6 tests cover protected role decisions, company-scoped user access and legacy frontend permission parity.

**Tests have been committed. A passing CI run on the final HEAD is required to treat the checks as validated.**

## Existing CI evidence observed 2026-11-06

At commit `99e30f35b74e1dc906fcfd9f43c06e138eeee9df`, the following workflow statuses were observed:

- Passing: GitHub Actions Quality, Protection Policy, CodeQL, Semgrep, Security Property Fuzzing, Android wrapper integrity.
- Failing: Repository Audits (documentation index did not link Phase 1, Phase 2 and plan; links corrected in commit `0a05fa8224e94e2c4e5f37d17e9a126e4282115d`).
- Failing: Classified untranslated-text audit, which reported 58 more actionable literals vs PR base across several affected UI categories.
- Pending at inspection: CI, Security, UI Quality and other tests. Do not treat these as passes.

## Mandatory staging verification (do not run on live production)

1. **Baseline**: Choose an isolated staging database with a validated backup and known test users across at least two companies. Snapshot role memberships, permissions, vouchers, voucher lines, stock ledger, inventory totals, container state, payroll accruals and policy revision for *each* company.
2. **Migration**: Review `migrations/20261024_001_permissions_control_center_shadow.sql` and its RLS policy against the actual service database role. Apply only after explicit staging approval. Confirm all five additive tables exist and no legacy table was updated.
3. **Cross-company**: From a Company A Admin, attempt Company B member listing, role edits, user overrides, preview and audit reads via direct API. Every unauthorized request must fail. Verify cross-company POST/body/header role spoofing is ignored.
4. **Role parity**: For Developer, Admin, Owner, Manager, Normal User, POS, View Only and ERP Tester, compare 403/200 outcomes before and after shadow migration for representative vouchers, suppliers, stock, containers, Factory, POS and Properties routes.
5. **Create Only**: In a test-only code path after Phase 3 is fully handler-verified, attempt new draft creation versus editing own draft, bulk delete, approval, finalize, reverse, import, offload, transfer or repair. These must return 403 where forbidden. For allowed create, verify exact expected side effects; all denied requests must leave state identical.
6. **Race and revalidation**: Two admins edit the same company policy revision; second writer must get 409. Test role removal mid-session and company switches across browser tabs, independent company policy revisions, stale read caches, and rollback behavior.
7. **Integrity assertions**: Compare before/after snapshots of accounting balances, voucher counts and totals, inventory quantity/kg/cost, stock journal and container statuses, payroll payments/accruals; the *shadow-only* transition must produce zero differences. Compare audit rows and revisions only for authorized policy changes.
8. **Rollback**: Disable any experimental policy flag and restore legacy read behavior first. Preserve audit evidence. Do not delete policy tables, revoke current admins or reverse business ledger entries. If the migration itself fails, rollback the uncommitted transaction and restore staging from the validated backup if required.
9. **Sign-off**: Require all CI/security checks on final HEAD, typecheck, browser/mobile/light/dark and i18n audits, full backend handler review, a signed test report, and explicit release authorization.

## Open gates

- Phase 3 has only one reviewed business-write route: `POST /api/suppliers`. Candidate review is not complete.
- Phase 5 Create Only role assignment is deliberately disabled while the server is not fully reviewed.
- Phase 6 UI permission integration is not complete across ERP, Factory, POS and Properties.
- The DB migration has not been applied; no staging isolation/migration comparison, active rollout or rollback drill is verified.
- CI and i18n failures above require resolution and a new green run.

**Do not merge, deploy, activate policy modes, or claim Phase 7 complete while any gate remains open.**
