# Dakzo Systems — Commercial Launch Plan
Date: 2026-11-16
Branch: feature/dakzo-commercial-launch
Status: Initial planning; no production changes.

## Objective
Commercialize the existing ERP + Factory platform via recurring subscriptions while preserving source-code ownership and protecting the current production operation.

## Repository facts (verified)
- Stack: React 19 / TypeScript / Vite; Express / Drizzle / PostgreSQL.
- Existing ERP, factory, retail/POS, properties and multi-company workflows.
- Existing CI, security audit, and tenant isolation mechanisms described in README; external-customer separation requires independent validation.
- Do not run db:push against any persistent/production database; see README.

## Principles
1. Keep commercial work on this branch; do not merge into main or deploy to production until approved and verified.
2. No sensitive production data, secrets, pricing lists, supplier/customer records, or financial transactions in public demos.
3. New paying organizations are independent tenants, not merely additional companies in an existing customer's tenant.
4. Every marketing claim must reflect features verified in a working commercial build.
5. No advertising spend, listing submission, domain DNS change, payment activation, or external outreach without reviewing the destination, budget, and account authority.
6. Avoid unreviewed lifetime deals and unlimited support commitments.

## Phase 1 — Product and commercial readiness audit
- Identify the public website/domain deployment, route layout and auth entry points.
- Map organization/company/user relationships, session scopes, API/DB filters, background workers, exports/files, caching, and offline sync.
- Audit whether tenant data can leak via APIs, search, reporting, file URLs, and admin tools.
- Identify and separate commercial licensing/tenant-admin/marketing logic from operational ERP code.
- Inventory customer-ready modules and unresolved blockers by package.
- Define compliance/security readiness, backup/restore, incident response, logging, and support obligations.
- Deliverable: documented architecture, feature matrix, risk register, and rollout gates.

## Phase 2 — Public sales site
- Build accessible fast mobile-friendly pages for Home, Retail ERP, Trading & Distribution, Factory ERP, Logistics, Pricing, Book Demo, FAQ and Contact.
- Use branded genuine product imagery with sanitized or synthetic data; do not publish operational screenshots containing real data.
- Strong, measured CTA: Book Demo. Include contact consent and privacy/legal basics.
- Add regional positioning in English; add languages after validating demand.
- Deliverable: staging preview and QA.

## Phase 3 — Safe live demo
- Deploy isolated demo instance using synthetic accounts/data only.
- Create read-only or resettable profiles for retail, trading and factory where feasible.
- Rate-limit and restrict risky endpoints; verify no emails, payment posts or external integrations run.
- Deliverable: repeatable demo seed/reset scripts and verified separation tests.

## Phase 4 — Lead capture
- Create demo lead capture: name, business email, company, industry, country, employee count, core problem, consent.
- Protect against spam, validate inputs and prevent duplicate notifications.
- Lead tracking: new, qualified, demo booked, proposal, won/lost; role-restricted admin reporting.
- Event tracking for form view, submitted qualified lead, demo booking and paid conversion.
- Deliverable: tested lead routing and conversion funnel.

## Phase 5 — SaaS subscriptions
- Confirm billing eligibility and supported countries/payment rails.
- Define licensed plan tiers and limits; enforce entitlements server-side.
- Build tenant signup, invite/roles, tenant isolation, subscription webhook idempotency and lifecycle actions.
- Test cancellation, failed payments, restore, migrations, backup and tenant deletion/export.
- Deliverable: separate-customer staging acceptance test.

## Phase 6 — Listing readiness and SEO
- Create sitemap, robots, canonical, schema.org SoftwareApplication, Open Graph, analytics consent management.
- Prepare product profile copy, privacy policy, company and support pages, screenshots, demo video and listing materials.
- Prioritize Capterra/G2 and relevant software directories subject to each platform's eligibility.
- Marketplace accounts must be submitted by an authorized account holder; no listing assumed live until approval.
- Deliverable: application pack and live-indexing verification.

## Phase 7 — Paid acquisition
- Start with Google Search, then Microsoft Search and selective LinkedIn/Meta retargeting.
- Separate campaigns by product and buyer intent, geography and dedicated landing page.
- Negative keywords for free/software jobs/training/templates.
- Track qualified demos, proposals and revenue not only clicks.
- Use a small capped pilot budget approved by owner; stop poor-performing groups after sufficient data.
- Deliverable: campaign creative and tracked conversion report.

## Phase 8 — Go-live and optimization
- Enforce CI checks: typecheck, lint, format, build, backend/frontend tests, security, data isolation, payment lifecycle.
- Validate performance, backups, restore exercise, accessibility, contact form and booking flows.
- Merge only when green and authorized; deploy a separately configured public SaaS environment.
- Weekly funnel review and feedback-driven pricing refinement.

## First implementation batch
1. Inspect frontend route table, current brand website, auth and tenancy.
2. Draft supported product descriptions and pricing experiments.
3. Build public marketing pages in isolation with no production data/API dependencies.
4. Add tests for public routes, metadata and lead flow once implemented.
5. Report exact changes and verification; do not merge or deploy without green gates.

## Proposed pricing experiments (not market validated)
Retail $99/month; Business $199/month; Factory $399/month; Enterprise from $799/month.
Setup and migration priced separately. Test willingness to pay before publishing final claims.

## Required external decisions
- Official marketing domain; business support email and legal company identity.
- Ad budget and regions; ad account authority.
- Subscription processor and legal jurisdiction for terms/tax.
- Approved public demo features and support/service commitments.

## Success metrics
- Qualified demo requests, booked and attended demos, paid customers.
- Lead-to-demo and demo-to-paid conversion, CAC, churn, MRR and gross margin.
