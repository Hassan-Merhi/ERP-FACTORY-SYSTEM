# Documentation

Everything in this directory describes **how the system behaves now**. Anything
that describes finished work — a phase write-up, a completion record, a dated
audit — lives in [`archive/`](archive/) and is history, not reference.

That split is enforced, not conventional: `npm run audit:doc-index` fails on a
doc with no classification, a stale classification row, a record filed outside
the archive, a current reference missing from this landing page, or a bound
figure that has drifted from the config it describes. See Phase 3 of
[`system-quality-program.md`](system-quality-program.md).

Every current reference document except this README must be linked from this
page. Adding a reference without adding it here is a documentation-state audit
failure, so a correct document cannot quietly become undiscoverable.

## Start here

| Doc | What it covers |
|---|---|
| [what-is-this.md](what-is-this.md) | What the system is, in one page |
| [onboarding.md](onboarding.md) | First login through first transaction |
| [architecture.md](architecture.md) | How the codebase fits together |
| [core-concepts.md](core-concepts.md) | Companies, modes, tenancy, the vocabulary |
| [contributing.md](contributing.md) | Project layout and how to work in it |

## How the business logic works

| Doc | What it covers |
|---|---|
| [accounting-flow.md](accounting-flow.md) | Voucher types, posting, the ledger |
| [inventory-flow.md](inventory-flow.md) | Stock data model and cost calculation |
| [inventory-cost-memory-policy.md](inventory-cost-memory-policy.md) | Cost-memory rules for the current implementation |
| [vouchers-flow.md](vouchers-flow.md) | Voucher lifecycle |
| [containers-flow.md](containers-flow.md) | Import shipments, PO to warehouse receipt |
| [factory-flow.md](factory-flow.md) | Bales, production, payroll, raw materials |
| [pos-flow.md](pos-flow.md) | Point of sale, including offline |
| [financial-close-and-migrations.md](financial-close-and-migrations.md) | Period locks and production migrations |
| [golden-coast-phase16-audit.md](golden-coast-phase16-audit.md) | Golden Coast payable/equity separation invariants and the unmerged phase branches |
| [group-net-position.md](group-net-position.md) | Combined What We Have, What We Owe and Net Position across active ERP companies |
| [multi-currency-phase8-account-api.md](multi-currency-phase8-account-api.md) | Account statement currency contract and safety boundaries |

## Operating it

| Doc | What it covers |
|---|---|
| [deployment.md](deployment.md) | Local and production deployment |
| [production-deployment-checklist.md](production-deployment-checklist.md) | Pre-release checklist |
| [operations/database-backup-rollback-recovery.md](operations/database-backup-rollback-recovery.md) | Backup and recovery runbook |
| [operations/external-alerting-checklist.md](operations/external-alerting-checklist.md) | Wiring health signals to a monitor |
| [monitoring/health-metrics.md](monitoring/health-metrics.md) | Health and internal metrics endpoints |
| [render-production-logging.md](render-production-logging.md) | Logging configuration on Render |
| [program-1-incident-response-runbook.md](program-1-incident-response-runbook.md) | Incident response |
| [troubleshooting.md](troubleshooting.md) | Common failures and fixes |
| [fresh-db-bootstrap.md](fresh-db-bootstrap.md) | Known gap bootstrapping an empty database |

## Building and testing

| Doc | What it covers |
|---|---|
| [testing.md](testing.md) | Test tiers and how to run them |
| [backend-verification.md](backend-verification.md) | CI-sized backend shards, timing, and merged coverage |
| [development-checklist.md](development-checklist.md) | Run before every push |
| [ci/branch-protection.md](ci/branch-protection.md) | Required checks on `main` |
| [mobile-tablet-web-regression.md](mobile-tablet-web-regression.md) | Browser regression checklist |
| [ux-consistency-program.md](ux-consistency-program.md) | Shared responsive, translation, route-boundary, and filter-state contracts |
| [api-quickstart.md](api-quickstart.md) | Calling the API |
| [compatibility.md](compatibility.md) | Supported browsers and platforms |

## Security and permissions

| Doc | What it covers |
|---|---|
| [permissions-security.md](permissions-security.md) | Roles and permission model |
| [security-privacy.md](security-privacy.md) | Authentication, sessions, data handling |
| [program-8b-approval-exception-workflows.md](program-8b-approval-exception-workflows.md) | Control model for high-risk actions |
| [audit-framework.md](audit-framework.md) | Server-side audit foundation |

## Ongoing programs

Both describe work in progress and carry live figures bound to their sources.

| Doc | What it covers |
|---|---|
| [erp-90-phases-3-6.md](erp-90-phases-3-6.md) | ERP 90/100 Phases 3–6: tenant isolation, accounting and inventory convergence |
| [god-file-split-program.md](god-file-split-program.md) | Splitting oversized files, and the harness that makes a split provable |
| [system-quality-program.md](system-quality-program.md) | Type safety, test breadth, documentation state, configuration coherence |
| [performance-phase9.md](performance-phase9.md) | Build, bundle, and runtime performance constraints |

## Reference registries

| Doc | What it covers |
|---|---|
| [erp-navigation-registry.md](erp-navigation-registry.md) | Canonical ERP routes |
| [factory-navigation-registry.md](factory-navigation-registry.md) | Factory routes |
| [properties-navigation-registry.md](properties-navigation-registry.md) | Properties routes |
| [supplier-partner-navigation-registry.md](supplier-partner-navigation-registry.md) | Supplier Partner routes |
| [i18n/README.md](i18n/README.md) | Interface language support |
| [i18n/phases-1-4-global-language-foundation.md](i18n/phases-1-4-global-language-foundation.md) | Current global language foundation and rollout contract |

## Using the system

| Doc | What it covers |
|---|---|
| [use-cases.md](use-cases.md) | What each role does day to day |
| [examples.md](examples.md) | Worked examples |
| [faq.md](faq.md) | Frequently asked questions |
| [releases.md](releases.md) | Release notes |

## Known issues

| Doc | What it covers |
|---|---|
| [smart-transfer-known-issues.md](smart-transfer-known-issues.md) | Outstanding Smart Transfer problems |
| [bandwidth-cache-hardening.md](bandwidth-cache-hardening.md) | Why the caching work exists |
| [stock-items-bandwidth-light-callers.md](stock-items-bandwidth-light-callers.md) | Lightweight stock-item payloads for voucher callers |

## `archive/`

Historical documents recording work that finished: phase write-ups, completion
records, dated audits, and per-program verification reports. They are kept
because they explain *why* decisions were made, and they are accurate as of the
day they were written — but nothing in there should be read as a description of
current behaviour.

New phase documents are written straight into `archive/`. Only material that
describes lasting behaviour gets promoted out, and promoting one means
reclassifying it in `config/doc-index.json` — which is the moment to check that
it is actually still true.
