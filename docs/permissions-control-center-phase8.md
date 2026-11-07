# Permissions Control Center — Phase 8 Release, Audit and Monitoring

**Branch:** `feature/permissions-control-center`  
**PR:** #2480, draft  
**Certification:** BLOCKED. Source is a safe shadow-only increment, NOT a production release.

## Completed Phase 8 source handoff

- Read-only company-scoped **Permission change audit** viewer in Settings > Users & Permissions. Shows latest 100 saved role/user policy revisions, actor, subject, reason, time and exact changed rules.
- Admin documentation: `docs/permissions-control-center-admin-guide.md`.
- Machine-readable readiness registry: `config/permissions-v2-release-readiness.json`, all nine gates explicitly blocked until evidence is attached.
- Test `tests/access-control-v2-phase8-release-readiness.test.ts` verifies gate completeness, real SHA, evidence and owner authorization prerequisites and that Create Only cannot silently be assigned or activated.
- Existing phase-specific protections retained and no production change performed.

## Independent release gates (must all pass)

1. **Complete server-side Phase 3 handler review:** every Create Only operation classified by its business action and data side effects; unknown writes fail closed.
2. **Complete Phase 6 UI coverage:** all ERP/Factory/retail/properties controlled pages gated, with legacy parity.
3. **Review and apply the additive policy SQL on staging only**, with backup and mandatory company RLS verification.
4. **Run staging data-integrity comparisons** across vouchers, ledger balances, stock/kg/cost, containers and payroll. Any unexpected difference is an automatic no-go.
5. **Prove cross-company and direct API authorization** and protected role restrictions for all business roles.
6. **Perform and document rollback drill** that preserves audit evidence and restores previous access correctly.
7. **Pass final SHA checks:** full CI, typecheck, lint/format, docs, i18n, RTL/accessibility, mobile, security and browser tests.
8. **Approve and distribute training and set up monitoring:** document responsible operator and escalation path; review deny-rate changes, unexpected 403s, policy revision increments, failed overrides and database errors.
9. **Explicit owner sign-off** for production merge, deployment and any company-specific activation.

## CI issues detected during preparation

Previously observed PR run at commit `99e30f35b74e1dc906fcfd9f43c06e138eeee9df` had Repository Audits failure (unlinked Phase 1/2/plan docs), and the classified untranslated-text audit reported 58 more actionable UI literals relative to the PR base. The three documentation links were added in commit `0a05fa8224e94e2c4e5f37d17e9a126e4282115d`. Rechecks on later commits, including current Phase 8, have **not been verified green**. New code must not be deployed until these and any other findings are resolved.

## Release procedure once all gates pass (not authorized or executed)

- Verify the exact reviewed HEAD and clean required checks; lock the expected version, then get explicit approval for each distinct production operation.
- Validate pre-deployment backup and rollback procedure, release notes and environment secrets.
- Merge only after approval and branch protection checks.
- Deploy to a staging environment first; confirm auth, company switching, access matrix, shadow audit and existing business flows. Do not expose the unreviewed Create Only role.
- For production, initially keep V2 `shadow` and live legacy authorization unchanged. Record feature flag/operator/approved company scope for any later trial activation.
- Monitor 403 denial anomalies, policy changes, V2 API errors, stale revision conflict rates, role-page parity and business invariants; pause rollout on unexplained changes.
- If unexpected denials, cross-company exposure or stock/ledger differences occur, disable V2 activation, preserve logs, return to previously verified deployment, and conduct an incident review. Never rewrite posted financial history merely to mask a discrepancy.

**No migration execution, merge, Render deployment, or active policy modification is claimed here.**

## Shadow-only merge to main (2026-11-06)

The repository owner approved merging this branch into `main` as a **shadow-only** increment. That approval covers the merge only. It does not apply the SQL migration, switch `rolloutMode` to `active`, or assign the Create Only role, and every gate in `config/permissions-v2-release-readiness.json` stays blocked.

Work done to make the branch mergeable:

- Merged current `main`, kept the eight reviewed `/api/permissions-v2/*` route allowances, and corrected the route-manifest count that a `main` commit left one short.
- Added Arabic and French translations for every new Permissions Control Center string, so the untranslated-text ratchet no longer grows.
- Exposed `scripts/audit-access-control-v2-routes.mjs` as `npm run audit:access-control-v2-routes`.
- Fixed the audit viewer accepting records when no company is selected, and hardened the User Access panel so a malformed members response cannot crash the Settings page.
- Formatted all branch source files with Prettier and made the route-contract tests whitespace-insensitive.

Until the API's migration is applied, the new endpoints answer `503 ACCESS_POLICY_SCHEMA_REQUIRED` and live authorization is unchanged.

## Create Only activation work (2026-11-07)

Phases 3, 5, 6 and 7 are implemented on `feature/permissions-control-center-activation`: server enforcement with 13 handler-verified creates, the assignment switch, frontend gating and request guard, and automated plus isolated-database verification. One release gate (`handler-review`) is verified with evidence; the others stay blocked with the remaining work recorded in `config/permissions-v2-release-readiness.json`. See [the activation runbook](permissions-control-center-activation.md) and [the route review](permissions-control-center-phase3-route-review.md).
