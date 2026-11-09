# Phase 1 — Manual Runtime Baseline Capture Protocol

**State:** REQUIRED BUT NOT EXECUTED. This is a safe, repeatable capture plan and acceptance record, not evidence that a browser, backend or fixture database was available.

**Working branch:** `factory/unification-8-phases-2026-11-09`
**CI:** Do not run. Run targeted checks only in a user-controlled **nonproduction** checkout/environment. Do not edit production DB or execute inventory/accounting mutations to obtain baseline data.

## Suggested safe fixture identities
Use pre-existing nonproduction test identities with distinct access grants and sample data:
- Company A and Company B, with clearly different stock/customer/account records.
- View Only and Create Only users, ordinary Factory user, Admin, Owner, Developer. Do not put credentials into fixtures or Git history.
- Read-only sample historical snapshot date for Net Position and read-only nonproduction dispatch report closure.

For every captured result, record: capture timestamp (UTC), branch commit SHA, sanitized company ID alias (A/B, not production ID), role label, URL, query string, expected/actual HTTP response status, permission state, expected UI state, screen size and anonymized evidence artifact name. Remove bearer/cookie headers, passwords, customer names, account numbers, phone numbers, employee details and financial production values.

## Capture matrix (not executed)

| ID | Workflow | Expected contract to verify safely | Evidence record |
|---|---|---|---|
| A01 | Login role and page registry | Unauthorized roles cannot open protected Factory routes, with server 403 where applicable; bonuses require Admin or Owner only | Role/page matrix + sanitized response |
| A02 | Company A → B → A | No company A stock, prices, cost flags, access or customers are displayed while B is selected; pending requests do not leak | Company transition timeline + redacted screenshot |
| A03 | Sidebar and deep links | Canonical pages resolve; aliases land at the correct permission-gated destination; tab query and back behavior survive | Route/navigation table |
| A04 | Containers and OTW | Accurate read-only availability/partial offload quantities; no editing needed | Sanitized JSON schema/field comparison |
| A05 | Inventory and cost fields | View Only cannot access hidden costs; permitted role sees correct price visibility | Permission-specific screenshots |
| A06 | V5 allocation versus V2/V3 | Availability, loaded, expected, free-to-promise and draft proforma preview figures agree for fixture | Redacted numerical comparison |
| A07 | Proforma create/edit UI | Allowed operations and computed previews match source baseline; do not submit a write | Screen capture + HTTP GET only |
| A08 | Loading dispatch report | Closed report is frozen/read-only; scanner UI does not post invoice/voucher/stock writes | Historical closure read + request-log summary |
| A09 | Attendance | Beirut calendar, prior-date warning and Admin approval UI are displayed; do not submit passwords or prior-date writes | Browser date/time snapshots |
| A10 | Pressing scanner | Camera permission, manual fallback, duplicate-frame feedback and cleanup; offline status explicitly not counted | Device-only manual observation |
| A11 | Daybook and Net Position | Date filtering, read-only totals, known-at-cutoff and partial-history warnings | Sanitized GET payload shape + screenshots |
| A12 | Exports | Read-only permitted report exports preserve structure/columns/date labels without leaking hidden costs | Export headers and anonymized hashes |

**Status of all rows:** NOT CAPTURED. No API output or screenshot file is claimed to exist from this phase.

## Repeatable source checks (without CI)

In a local checkout at the working branch, a developer may run these manually:
```bash
npx vitest run tests/factory-unification-phase1-baseline.test.ts
npx vitest run tests/ui/factory-mobile-route-registry.test.ts
```
These commands are documentation only; **not executed by this implementation**. The Phase 1 source fixture at `docs/factory-unification/phase-1-source-fixture.json` captures the registry/route inventory from the current unification branch. If an intentional route changes in Phase 8, update the source fixture with a documented review rather than disabling assertions.

## Completion / release gates
- Source baseline: inventory, fixture, regression cases, original observations and current source reconciliation are committed.
- Runtime baseline: **open** until the above matrix is actually captured in a safe environment, not just declared.
- Manual UI screenshots or API bodies cannot be manufactured from code inspection.
- No sign-off for role enforcement, historical accounting parity, stock accuracy or UI regressions without real observations.
