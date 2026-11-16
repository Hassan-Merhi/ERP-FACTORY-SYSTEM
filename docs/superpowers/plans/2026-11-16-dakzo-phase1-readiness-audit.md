# Dakzo Systems — Phase 1 Commercial Readiness Audit
Date: 2026-11-16
Status: Phase 1 architecture/design audit completed; SaaS production readiness NOT certified.
Scope: source inspection of repository on feature/dakzo-commercial-launch; no deployment, live database inspection, or executed test suite.

## Executive decision
**GO** for isolated public-site development and synthetic demo design.
**NO-GO** for external customer registration, paid subscriptions, public production demos, and broad paid ads until the Phase 5 / Phase 8 gates below are satisfied.

## Evidence / architecture inventory
| Area | Evidence | Assessment |
|---|---|---|
| Stack | README.md; package.json; docs/architecture.md | React 19 + Vite + TypeScript; Express + PostgreSQL + Drizzle; existing ERP/POS/factory workflows; reusable |
| Company data model | shared/schema/common.ts | companies.id, parentCompanyId, companyType, user-company roles; company is not proof of separate SaaS customer/account |
| Auth | server/index.ts; docs/security-posture.md; server/routes/auth/sessionRoutes.ts | PostgreSQL-backed authenticated sessions, CSRF, rates; needs SaaS account lifecycle and isolation acceptance tests |
| Application tenant boundary | server/routes/tenantBoundaryRegistrar.ts; server/middleware/tenantIsolationBoundary.ts | Global active-company scope; cross-company exceptions, Developer handling and pinned factory contexts must be audited in SaaS |
| Database RLS | docs/architecture.md; docs/security-company-isolation-wave3.md; migrations/0016_company_scope_rls_readiness.sql | Documented FORCE RLS for high-risk tables, not proof of universal isolation; audit remaining tables, exports and jobs |
| Public-site routing | client/src/App.tsx; client/index.html; server/startup/staticServing.ts | Authenticated React SPA with noindex,nofollow index; public marketing should be separately deployed with independent SEO controls |
| Security residuals | docs/security-posture.md | Permissions V2 shadow mode, rolling session lifetime, accepted xlsx risk and privileged break-glass monitoring need review |
| Boot/migrations | README.md; server/index.ts | Runtime schema/repair jobs; avoid applying against production or auto-provisioning customer tenants before migration plan |
| Billing | GitHub source searches for subscription/billing | No dedicated commercial billing/entitlements established; absence not conclusively proved by search alone |
| Brand | client/public/dakzo-mark-light-v2.svg; client/public/dakzo-mark-dark-v2.svg | Existing Dakzo visual assets can be reused |
| Current sales site | Not identified from inspected app files | Marketing domain, DNS, hosting and deployment remain unverified |

## Proposed customer/account architecture
- **Commercial account / tenant**: new top-level tenant entity with independent identity, domain, subscription, owner, lifecycle.
- **Companies**: existing operational company records are mapped to exactly one commercial account, with verified membership checks.
- **Users**: explicit account-scoped membership; company role alone is insufficient authorization for account-wide admin/billing.
- **Entitlements**: subscription controls enforced in API middleware and jobs, not only frontend visibility.
- **Tenant boundary**: every tenant-owned record, search, attachment, export, import, ledger, dispatch, offline sync and websocket is scope checked. Flag any globally unique codes that conflict between unrelated customers.
- **Default posture**: deny by default, account owners cannot access other accounts; platform support access must be time-boxed, audited and approved.
- **Safer initial deployment**: independently isolated customer instances/databases may reduce risks for early pilots, with centralized license control later, if operationally practical; test restore and upgrades.
- **Demo**: separate database, fabricated names, prices and accounting balances; no copied customer/company records or active production service credentials.
- **Marketing**: separately served indexable public website; leave authenticated ERP noindex and isolated on a distinct hostname.

## Blockers and release risks
| ID | Severity | Risk | Must demonstrate before paid customer launch |
|---|---|---|---|
| C-01 | Critical | Existing company ID != independently owned tenant; cross-tenant administrators | Schema and authorization model with two unrelated customer organizations, multiple companies each; negative access tests |
| C-02 | Critical | Privileged Developer and intentional cross-company reads | SaaS platform role segregation, break-glass approval and logged tests across all exceptions |
| C-03 | Critical | Partial RLS coverage and background worker / storage / export paths | Cross-tenant SQL, async task, WebSocket, offline and download authorization testing |
| C-04 | Critical | Schema changes, boot repair and production data exposure | Separate staging DB, reversible migrations, backup/restore exercise and no production data reuse |
| C-05 | High | No established customer subscription lifecycle | Tested server-enforced entitlements, idempotent webhook, suspended/expired/cancelled flows |
| C-06 | High | No independently verified self-service signup | Secure account invitation, email verification, MFA options, password reset and admin account setup |
| C-07 | High | Public site presently noindex and authenticated SPA | Independent SEO-site deploy, HTTPS, sitemap, metadata, tracking consent and forms |
| C-08 | High | Unverified legal/payment/support operating model | Contracts, privacy/terms, regional tax/payment eligibility, support SLAs and incident channel |
| C-09 | High | Excel import / accepted xlsx vulnerability risk | Import limitations, robust sandbox/file validation and security review |
| C-10 | Medium | No evidence of reliable lead attribution | CRM lead stages, consent, anti-spam, event and campaign tracking |
| C-11 | Medium | Incomplete product packaging proof | Real user acceptance tests and screenshot/video claims for each offered plan |

## Candidate product modules and pricing tests
- Retail: retail POS, inventory, customer records. Proposed validation price $99/month.
- Trading/Distribution: purchase orders, warehouse inventory, accounting, sales, container tracking. $199/month test.
- Factory: production, loading/dispatch, worker operational tools, costing. $399/month test.
- Enterprise: intercompany and complex logistics with separately quoted onboarding. From $799/month test.
All prices are experiments, not published or approved prices. Validate each feature in a customer-specific instance before advertising.

## Implementation separation
1. Keep existing ERP production hostname, cookies, database and noindex metadata intact.
2. Develop marketing site separately, preferably independent deployment, using reused Dakzo assets only.
3. Deploy public lead API with its own store/consent and scoped spam controls; never couple to production ERP credentials.
4. Plan account schema and tenant membership change behind feature gates; no backfills of production company data without migration tests.
5. Build a disposable synthetic two-tenant test harness, including multi-company and unauthorized Developer-equivalent edge cases.
6. Integrate subscriptions only after account isolation and backups are accepted.

## Verified / unverified
Verified by reading source: framework, existing company schema, app-level tenant middleware, documented RLS policy, private-site noindex, branded assets, build and migration constraints.
Not verified: live services and domain, actual production database RLS state, all endpoint scopes, backup restore, fresh deployment, builds/tests, customer separation, commercial payment setup, legal/processor eligibility.
Do not claim SaaS readiness or security certification based on this audit.

## Phase 1 definition of done
[x] Identify relevant stack, operating modules and reuse boundary.
[x] Map current company authentication and tenancy mechanisms from source.
[x] Define independent commercial customer model and critical security constraints.
[x] Identify marketing deployment separation and SEO risk.
[x] Document package/pricing hypotheses and commercial launch dependencies.
[x] Write prioritized risk register and clear go/no-go gates.
[ ] Runtime proof of tenant isolation, migration safety, backup restore and billing (intentionally tracked as prerequisites in later phases, not Phase 1 documentation completion).

## Phase 2 entry criteria
- Marketing implementation must remain in its own deployment context and contain no real ERP data.
- Real screenshots require sanitization; initially use only synthetic product examples.
- Implement inquiry/booking handoff with privacy consent and spam protection.
- Do not disable noindex on existing private ERP.
- Do not merge or deploy until checks are green and authorized.

## Phase 5 / Phase 8 acceptance
- Two unrelated tenant fixtures, including separate admins and at least two companies each; verify cross-tenant GET/POST, export, files, jobs, WebSocket, POS offline state and searches fail closed.
- Unauthorized tenant identifiers never change authorization context.
- Billing downgrade/suspension/renewal correctly gates API routes and jobs.
- Backup + restore of isolated demo/staging; migrations on empty and populated fixtures.
- Build, typecheck, lint, formatting, security checks, backend/frontend suite and smoke flows green.
- Independent marketing-domain indexing and lead tracking validated.
- Human review of external profiles, pricing, privacy/terms and payment processor.
