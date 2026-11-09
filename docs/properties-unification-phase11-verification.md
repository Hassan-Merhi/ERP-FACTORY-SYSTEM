# Properties Mode — Phase 11 Regression & Integration Verification

Date: 2026-11-09  
Branch: `properties-unification-phases-7-11`  
Target: `main`  
Outcome: **STATIC REGRESSION PASS; RUNTIME AND INTEGRATION CERTIFICATION BLOCKED**

## Scope and actual execution

The 7–10 implementation changes were checked against the branch's current source and independently compared with current `main`.

### Tests actually executed

A live, GitHub-backed source-verification pass ran **27/27 checks successfully** against freshly fetched branch files. These checks independently inspected:

- Payment deletion and scheduled cancellation middleware; canonical selected-company permission context; reconciliation Admin/Developer rule.
- Company/module/status isolation on deletion, original posted-voucher/cash-account classification, USD-only export guard, immutable 2026-10-26 historical cutoff, Hassan Properties ID/code identity.
- Currency-safe payment/contract overviews, company-business-calendar date filter, removal of impossible reconciliation UI, historical export action eligibility, shared delete confirmation wording.
- Properties cross-module read-only presentation, timezone-neutral date labels, all six pinned links, retained operational dashboard, hidden registry classification, manifest-based old rental redirects, unknown-route replacement, stable sidebar icons.

The equivalent dependency-free repository script is `scripts/verify-properties-unification-phase11.mjs`. It was **authored and committed** for re-execution in a checkout; the GitHub-backed static check was executed separately from this repository script. No Vitest results are claimed.

### Confirmed correction during this phase

- `client/src/pages/properties/RentalPaymentsLog.tsx`: The `Copy Full History` label/test ID now appears only for a verified Hassan Properties unfiltered historical view; other Properties companies correctly get the ordinary `Copy Results` action. This does not change export data.
- `tests/properties-unification-phase9-ui.test.ts`: Added the corresponding regression assertion.
- `tests/properties-unification-phase7-permissions.test.ts`: Corrected the positive company-permission mock to use the same company as the request, avoiding a misleading cross-company test expectation.

## Integration comparison against main

The initial Phase 11 compare reported **44 commits ahead / 149 behind** for the feature branch. Across the merge-base-to-branch and merge-base-to-main diffs, GitHub showed **22 feature-modified file paths**, **71 main-modified file paths**, and **zero overlapping changed file paths** at that snapshot. Subsequent Phase 11 commits increase the ahead count; always rerun the compare before integration.

This is **not proof of a conflict-free or safe merge**. Changed code may still depend on newly altered files in `main`. The upstream main changes include shared ERP/navigation/UI components. An integration branch or controlled merge of `main` into this feature branch, followed by compilation and focused browser checks, remains mandatory.

No merge into `main`, rebase or main-branch update was made.

## Required commands in an executable checkout

```bash
npm ci
node scripts/verify-properties-unification-phase11.mjs
npm run check
node node_modules/vitest/vitest.mjs run \
  tests/properties-unification-phase7-permissions.test.ts \
  tests/properties-unification-phase8-presentation.test.ts \
  tests/properties-unification-phase9-ui.test.ts \
  tests/properties-unification-phase10-navigation.test.ts \
  tests/properties-unification-regression.test.ts \
  tests/properties-payment-history-reconciliation.test.ts \
  tests/phase33e-auth-role-guards.test.ts \
  tests/phase33e-active-company-permissions.test.ts
```

Run the frontend Vitest configuration and relevant browser-based smoke scenarios as appropriate. This phase does not trigger CI or create a workflow.

## Manual/API certification matrix (pending)

| Area | Required verification | State |
| --- | --- | --- |
| Tenant deletion boundary | Admin/Owner/Developer, Manager permission on/off, POS, Create Only, View Only, revoked active-company assignment | Not run |
| Company isolation | Same user assigned to multiple companies; direct foreign payment ID, group ID and company override cannot delete another company's data | Not run |
| Reconciliation authorization | Admin and Developer allowed; Owner, Manager, POS denied under selected-company role even with stale cached role | Not run |
| Properties receipts | Posted cash, noncash billing, scheduled rows, guarantee cash/deposit liability, source-module read-only entry | Not run |
| FX/mixed currency | USD-only total, non-USD withheld total, currency-labeled rows, blocked USD TSV exports | Not run |
| Historical snapshot | Company 13/code HP, 2026-10-26 cutoff, voucher-backed ended/active leases, no synthetic entries | Not run |
| Balance sources | Withdrawal cutoff versus current ALI cash, optional cashbox and deposits; independent voucher/ledger reconciliation | Not run |
| Calendar dates | Company timezone different from browser, midnight and month/year/year-crossing 30-day filters | Not run |
| Navigation | Six pinned pages, Shops/Payments tabs, legacy rental bookmarks with replace, voucher/ledger direct links, role switch, Back/Forward | Not run |
| Legacy dashboard | Direct bookmark access; existing cash/payable account operations in nonproduction test company | Not run |
| ERP and Factory | Payment list parity, contract detail and deletion, no accidental Properties transfer postings | Not run |
| Upstream integration | Incorporate latest main into feature branch without dropping current business fixes; rerun whole matrix | Not run |

**Safety rule:** Never use production funds, postings, voucher deletion or account management to test these flows. Use isolated fixtures/nonproduction environments.

## Final signoff gate

- **Static source review:** PASS (27/27, source-backed).
- **Focused regression test artifacts:** COMMITTED (Phases 7–10, plus Phase 11 script).
- **TypeScript compilation:** NOT RUN.
- **Vitest execution:** NOT RUN.
- **Authenticated browser/API scenarios:** NOT RUN.
- **Live ledger reconciliation:** NOT RUN.
- **Latest-main integration/retest:** NOT RUN.
- **Merge-ready certification:** **NO**.

Reason: The connected GitHub source API supports safe edits and inspections but not an executable checkout or attached test runner. The local sandbox cannot resolve/clone this private repository; `git ls-remote` failed due to DNS/network restrictions. Merely committing tests is not running them.

Phase 11 verification preparation, source review, reproducible static safety checks and confirmed fixes are complete. **Release certification is outstanding** until the unrun checks and upstream integration actually pass. Do not mark the branch as fully tested or ready to merge on the strength of static assertions alone.
