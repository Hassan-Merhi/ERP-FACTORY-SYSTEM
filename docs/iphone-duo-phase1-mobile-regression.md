# iPhone Duo — Phase 1 full-system mobile audit

Branch: `feature/iphone-duo-phase1-full-mobile-regression-20261105`

## Scope

**Tests and fixtures only.** This phase does not change production components,
permissions, accounting, data, scanners or deployment configuration.

The inventory is extracted from the actual ERP, Factory, Properties and POS
router source. It separates seven contexts: ERP, Factory, Properties,
Supplier Partner, Retail (Developer), POS (actual POS role), and Retail POS.
Parameterized detail routes without seeded record IDs are **reported as
uncovered**, not silently counted as a passing test.

The browser harness extends the established multilingual Puppeteer checks:
login, company switch, shell visibility, direction/RTL, horizontal overflow,
responsive viewport, screenshot evidence and independent per-route failures.
Selected high-value routes also switch viewport sizes within the **same tab**,
checking route continuity, workspace visibility, horizontal overflow, and
ordinary search-field values. No browser-script mutation of business data.

## Screen profiles

| Profile | CSS width × height | Purpose |
| --- | --- | --- |
| duo-cover | 466×678 | Closed portrait |
| duo-cover-landscape | 678×466 | Closed landscape |
| duo-inner | 626×890 | Open portrait |
| duo-inner-landscape | 890×626 | Open landscape |
| duo-split | 393×890 | Narrow split-window simulation |

These derive approximately from Apple's native display pixels at DPR 3;
they are **not** guaranteed Safari CSS viewport measurements. Dynamic island,
browser chrome, Display Zoom, physical hinge behavior and iOS camera permission
transitions still need physical-device verification.

## Commands (test-only environment)

```bash
# Test-only local database. The fixture script refuses non-local database hosts.
ERP_DUO_CREATE_FIXTURES=1 NODE_ENV=test node scripts/prepare-phase9-browser-smoke-fixture.mjs

# No app server, database or credentials required:
node scripts/verify-iphone-duo-phase1-inventory.mjs

# Start a test build at ERP_SMOKE_BASE_URL and run the Developer route inventory.
ERP_SMOKE_REQUIRE_AUTHENTICATED=1 ERP_DUO_TRANSITIONS=1 \
ERP_SMOKE_USERNAME="$DEV_TEST_USER" ERP_SMOKE_PASSWORD="$TEST_PASSWORD" \
node scripts/verify-iphone-duo-phase1-browser.mjs

# Use the actual POS role fixture. Do not use a Developer session for POS certification.
ERP_SMOKE_REQUIRE_AUTHENTICATED=1 ERP_DUO_ROLE=POS ERP_DUO_TRANSITIONS=1 \
ERP_SMOKE_USERNAME="${DEV_TEST_USER}_duo_pos" ERP_SMOKE_PASSWORD="$TEST_PASSWORD" \
node scripts/verify-iphone-duo-phase1-browser.mjs
```

Use `ERP_DUO_LANGUAGES=en,ar,fr` and `ERP_DUO_VIEWPORTS=...` to select
languages/profiles, `ERP_DUO_WORKSPACES=...` to narrow workspaces, and
`ERP_DUO_ROUTES=/factory/stock-entry,...` to run focused paths.
Default is **all discovered static routes for the chosen role**.
`ERP_DUO_REQUIRE_COMPLETE=1` deliberately fails when any parameterized
route lacks seeded data; the saved report lists each one.

## Evidence and completion criteria

- `artifacts/iphone-duo-phase1/route-inventory.json`: declared routes by workspace
- `artifacts/iphone-duo-phase1/report.json`: rendered routes, failures, unresolved
  parameterized routes, transitions and screenshots
- `artifacts/ux-regression-browser/duo-developer` and `duo-pos`: CI evidence,
  retained with the UI Quality artifact
- PR gate: route contract + selected Developer/POS role-specific rendered cases
- Full certification: every intended active route with seeded data in a safe test
  company, no unclassified route skips, 3 languages, five viewport profiles,
  same-page transitions, manual iPhone Safari portrait/landscape/fold tests,
  no regressions on existing tablet and desktop matrix

**Not a certification claim:** repository/source coverage and Chrome emulation
do not replace a real signed-in Duo Safari run, and unresolved dynamic routes
block any claim of 100% authenticated coverage. Do not run data-seeding
commands against production.
