# Permissions Control Center — Create Only Activation Runbook

**Status (2026-11-07):** the Create Only role is enforced in code and verified by automated tests. It is **not activated**: no one can be assigned the role until an operator sets `PERMISSIONS_V2_CREATE_ONLY_ASSIGNMENT=enabled`, and that must not happen before every gate in `config/permissions-v2-release-readiness.json` is verified. The V2 role/user matrix stays in shadow mode; nothing here switches a company to `active`.

Related: [route review](permissions-control-center-phase3-route-review.md) · [administrator guide](permissions-control-center-admin-guide.md) · [Phase 8 release gates](permissions-control-center-phase8.md).

## What is delivered

| Phase | Delivered |
|---|---|
| 3 — backend | Global, canonical, per-route and offline-sync Create Only enforcement; 13 handler-verified create signatures; every other write denied by default. |
| 5 — assignment | Role schemas accept Create Only; Admin assignment routes refuse to newly grant it (409 `CREATE_ONLY_ASSIGNMENT_NOT_ACTIVATED`) until the switch is set; the role editor offers it only when the server says it is assignable. |
| 6 — frontend | Shared verified-create catalog; client request guard with a readable message; `useCan`/`<Can>` verified creates; `useExistingRecordChangeAccess` gating on Customers, Suppliers, Stock Items, the Daybook table, Properties rentals and Retail products; Create Only banner; English/Arabic/French strings. |
| 7 — verification | Pure security suite, HTTP suite against PostgreSQL, isolated migration validation (below). |
| 8 — release | This runbook, the route review, the updated admin guide and readiness register. |

## Verification evidence (automated, reproducible)

| Check | Command | Result on this branch |
|---|---|---|
| Write boundary over every manifest route, legacy-role parity, request rules, dates, offline sync, assignment switch | `npx vitest run tests/access-control-v2-create-only-activation.test.ts` | pass |
| Real app + PostgreSQL: 1,100+ write routes refused with 403, unchanged business fingerprints; verified creates; own records immutable; cross-company; stale session | `DATABASE_URL=… npx vitest run tests/access-control-v2-create-only-http.test.ts` (CI "Backend / Database Tests") | pass locally on PostgreSQL 16 |
| Shadow migration: atomic, idempotent, FORCE RLS isolation, override/audit triggers, unchanged business data, concurrent-save 409 | `npm run verify:permissions-shadow-migration` | pass locally on PostgreSQL 16 |
| All Permissions V2 suites | `npx vitest run tests/access-control-v2-*` | pass |

The migration validation uses a **throwaway** cluster with the application's real company-scope functions. It is evidence about the SQL's behaviour, not a staging certification: it does not use the production schema, data volume, service role or backups.

## Remaining release blockers

The live list, with evidence and the commit each gate refers to, is `config/permissions-v2-release-readiness.json`. As of 2026-11-07:

1. **Frontend parity** — every catalogued page is gated for View Only and Create Only and verified by the page audit's import scan ([page audit](permissions-v2-frontend-page-audit.md)); a walkthrough on a deployed staging build is still needed.
2. **Staging migration, data integrity and rollback drill** — tooling and procedure ready ([staging certification](permissions-v2-staging-certification.md)); needs a staging database and written approval.
3. **Cross-company matrix on staging** — all nine roles pass locally; the location and lifecycle matrix must be repeated on staging data.
4. **Monitoring owner and alert destination** — monitoring is implemented; a named owner, escalation path and a confirmed test alert are needed.
5. **CI on the final release SHA** and **owner sign-off**.

The V2 role/user matrix itself can now be activated per company ([effective engine](permissions-v2-effective-engine.md)), behind two more operator switches that stay off.

## Staging procedure (operator, not automated)

1. Take and **verify** a backup of the staging database (restore it once to a scratch instance).
2. Run `npm run verify:permissions-shadow-migration` on the release commit and keep the output.
3. Snapshot per company: voucher counts and totals, voucher_entries sums, ledger balances, inventory quantity/kg/cost, stock journal, container statuses, payroll accruals and payments, `role_feature_permissions`, `user_company_roles`.
4. Apply `migrations/20261024_001_permissions_control_center_shadow.sql` and then `migrations/20261107_001_permissions_v2_policy_mode_audit.sql` with the **service role**, each in one transaction (or run `scripts/permissions/staging-certification.sh`, which does every step of this procedure). Confirm five `access_*` tables with FORCE RLS and the two triggers.
5. Repeat the snapshot; any difference is an automatic stop.
6. Run the HTTP suite against staging-like data with a test company; confirm 403s and unchanged fingerprints.
7. Rollback drill (below), then re-apply.
8. Record the evidence for each gate in `config/permissions-v2-release-readiness.json`.

## Rollout (after every gate is verified and the owner approves)

1. Deploy the approved commit with `PERMISSIONS_V2_CREATE_ONLY_ASSIGNMENT` **unset**. Behaviour for existing roles is unchanged.
2. Watch the signals below for one business day.
3. Set `PERMISSIONS_V2_CREATE_ONLY_ASSIGNMENT=enabled` and restart.
4. Assign Create Only to **one** pilot user in **one** company (Settings → Users & Permissions → Company Roles). The user is signed out of other sessions automatically.
5. With the pilot user, confirm: allowed creates work; edits, deletes, approvals and imports are refused with a clear message; dates are today only.
6. Widen company by company.

## Rollback

- **Stop new assignments:** unset `PERMISSIONS_V2_CREATE_ONLY_ASSIGNMENT` and restart. Existing Create Only users keep the same restrictions.
- **Remove the role from a person:** change their company role in Company Roles; the change is audited and their sessions are ended.
- **Code rollback:** redeploy the previous commit. Create Only users would then match no legacy role rule, so change their role first.
- **Never** delete `access_*` tables or audit rows, and never reverse posted vouchers to hide a discrepancy. If the migration itself fails, the transaction rolls back completely (verified); restore staging from the verified backup only if something else changed.

## Monitoring and troubleshooting

| Signal | Where | Meaning / action |
|---|---|---|
| `access_denied` with `reason: "Create Only attempted an unverified business write"` | application logs | Expected when a Create Only user tries an edit/delete; investigate repeated attempts on the same record. |
| `tenant_request_scope_denied` with `code: CREATE_ONLY_WRITE_NOT_VERIFIED` | application logs | A session whose stored role differs from the database tried to write; normally a role changed mid-session. |
| 403 `BUSINESS_ACTION_DENIED` on a verified create | HTTP logs | The request carried a refused field (opening balance, opening stock, lifecycle field, other company, backdated contract). |
| 409 `CREATE_ONLY_ASSIGNMENT_NOT_ACTIVATED` | HTTP logs | Someone tried to assign the role while the switch is off. |
| `PHASE9_ACTOR_ROLE_NOT_PERMITTED` | offline sync conflicts | An offline event from a Create Only actor; review and discard. |
| Policy revision jumps / 409 `POLICY_STALE_REVISION` | permission audit viewer | Concurrent administrator edits; reload and review. |

Pause the rollout on any unexplained change in voucher, stock, container or payroll totals.
