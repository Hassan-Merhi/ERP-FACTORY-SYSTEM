# Phase 4 — main ruleset hardening (administrator action required)

Repository: `Hassan-Merhi/ERP-FACTORY-SYSTEM`

Live ruleset: [Protect main](https://github.com/Hassan-Merhi/ERP-FACTORY-SYSTEM/rules/24630833), ID `24630833`.

## Verified state on 2026-11-04

The live ruleset **exists and is active**. Do not create a second overlapping
ruleset or turn off the existing status checks.

Verified through the GitHub repository rulesets read API:

- Target: `~DEFAULT_BRANCH` (currently `refs/heads/main`)
- Enforcement: `active`
- Rules: no branch deletion, no non-fast-forward pushes, PR required, conversation
  resolution required, strict up-to-date required status checks
- Required contexts: `Check / Build / Lint / Test`, `Secret scan`,
  `Dependency audit`, `Focused security readiness`,
  `Analyze JavaScript / TypeScript`, `Semgrep CE new-findings gate`,
  `Dependency Review`, `actionlint`, `zizmor`, and
  `Classified untranslated-text audit`
- **Gap:** `required_approving_review_count: 0`
- **Gap:** `dismiss_stale_reviews_on_push: false`
- **Gap:** `require_last_push_approval: false`
- **Gap:** `require_code_owner_review: false`
- **Gap:** a `RepositoryRole` actor (ID 5) has `bypass_mode: always`

The existing read-only GitHub integration can inspect this configuration,
but it cannot edit repository administration settings. A conventional
`GITHUB_TOKEN` used by CI should not be given a fictitious admin permission.
This finding must not be marked "fixed" merely by changing documentation.

## Minimum secure change in GitHub Settings

1. Open [Rulesets > Protect main](https://github.com/Hassan-Merhi/ERP-FACTORY-SYSTEM/rules/24630833)
   with an account authorized to edit repository rulesets.
2. Preserve the existing active target, no-deletion / no-force-push rules, and
   **all** required check contexts. Do not weaken required checks to unblock a PR.
3. Require at least **one independent approving review**; two independent
   reviewers meet OpenSSF Scorecard's stronger tier. A PR author cannot approve
   their own PR, so confirm there is a second authorized human reviewer
   before activating this setting.
4. Enable **dismiss stale approvals** and **approval of the most recent push**.
   Require conversation resolution (already enabled).
5. Remove the unconditional repository-role bypass or restrict it to
   documented emergency actors with approval/audit. Verify administrators
   cannot silently bypass routine branch protections.
6. If code-owner review is to be required, first create `.github/CODEOWNERS`
   with real maintainers who are **independent of the PR author**. Do not
   enable a rule that can never be satisfied by the project's actual team.
7. Save, then inspect the REST `GET /repos/{owner}/{repo}/rulesets/24630833`
   response to verify the new parameters (not merely the settings UI).
8. Run OpenSSF Scorecard on `main` and check the specific branch-protection
   finding after the next successful SARIF upload. It may take another scan for
   the GitHub alert to close.

**Do not enable review thresholds that make the repository impossible to
operate.** A project with one human maintainer must add another qualified
reviewer before requiring outside approvals. Security findings should be
reported as awaiting administration rather than dismissed.

## Supply-chain closeout

- The two Factory Edge Docker stages are pinned to the same verified immutable
  Docker Hub manifest digest, with a successful Docker build on the security PR.
- The Pullfrog action is pinned to the exact `v0.1.101` release commit SHA,
  verified against the upstream tag.
- The OpenSSF vulnerability alert is aggregate evidence of vulnerable releases
  on `main`; Phase 2's lockfile changes must be merged and scanned before it
  can be considered resolved.

**Phase boundary:** Phase 4 changes remain on
`fix/security-quality-36-20261104` / draft PR #2845. Do not merge or start
Phase 5 without explicit approval.

## Phase 5b closeout verification

Before merging the shared security PR, require fresh CI checks on its latest
commit after merging current `main` into the security branch. Earlier green
checks on an ancestor commit are not equivalent evidence.

The Phase 5b sync preserves the Factory Invoicing button removal and sidebar
label already merged to `main`, verifies the documentation index and
`docs/README.md` reference, and runs the new security regression tests.
The PR still requires an independent GitHub code-scanning rescan and a live
ruleset-admin change to establish closure of the original alerts. Never close
alerts by dismissal or relax the required check policy to permit merging.

## Pre-merge synchronization

The security branch was synchronized with the Properties cashbox implementation on `main` (commit `35e915f6678b218cf9a456801d7006fc0189392b`). The synchronized route manifest contains 2,312 registered routes, and `docs/system-quality-program.md` was updated to that count. The existing voucher minimum 48px touch target is preserved. Final GitHub checks must run against the current PR HEAD; older successful runs must not be substituted.

The subsequent `main` update introduced narrated training recordings (H.264/AAC, 60–1,200 seconds). The protected training publisher now retains those codec and duration requirements inside the read-only validation job before any environment-approved publication. The shared security PR includes the newest `main` at the time of this verification; all required CI results must apply to its final head.
