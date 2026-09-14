# Release Governance

This document is the authoritative repository policy for protecting `main` and for deciding which commit may be released.

## Main branch policy

`main` must be targeted by an **active GitHub branch ruleset** with no routine bypass path. The ruleset is used instead of an undocumented manual convention because `.github/workflows/release-governance.yml` can read the active rules that apply to `main` and prove the repository remains governed.

Required rules:

- Require a pull request before merging. Direct pushes are not permitted.
- Block force pushes (`non_fast_forward`).
- Block branch deletion (`deletion`).
- Require status checks to pass before merging.
- Require branches to be up to date before merging (`strict_required_status_checks_policy`).
- Administrators follow the same release rule; emergency bypass is not part of the normal release process.
- Review conversations should be resolved before merge when GitHub exposes that control.

The repository does not require an arbitrary approval count solely to satisfy this policy. The safety requirement is a reviewable PR plus the full automated gate set.

## Status checks required by the main ruleset

These contexts are permanent merge requirements and are machine-verified by Release Governance:

### GitHub Actions

- `Protect main and release path`
- `Check / Build / Lint / Test`
- `Secret scan`
- `Dependency audit`
- `Focused security readiness`
- `Analyze JavaScript / TypeScript`
- `Semgrep CE new-findings gate`
- `Dependency Review`
- `actionlint`
- `zizmor`
- `Classified untranslated-text audit`

### CircleCI

- `ci/circleci: static-build`
- `ci/circleci: postgres-regression`
- `ci/circleci: backend-core-regression`
- `ci/circleci: frontend-regression`
- `ci/circleci: security-readiness`

A check from an older SHA never satisfies the gate for a newer PR head.

Other permanent workflows that are conditional by path or event—such as RTL and Accessibility, Mobile Responsiveness, Browser E2E, Performance & Database Safety, Release Verification, and resilience rehearsals—must still pass whenever they are triggered. They are not listed as global required contexts because a path-filtered workflow that does not create a check for every PR cannot safely be made a universal required status.

## Permanent governance audit

`.github/workflows/release-governance.yml` independently verifies the repository-level contract:

- `main` reports as protected through the GitHub API;
- active rules on `main` include `pull_request`, `required_status_checks`, `non_fast_forward`, and `deletion`;
- required status checks use strict/current-branch mode;
- every permanent context listed above is present in the active ruleset;
- PR heads targeting `main` are not behind current `main`;
- a force push to `main` fails the audit;
- a new `main` SHA without an associated merged pull request fails the audit.

This workflow is defense in depth. The ruleset prevents a prohibited write or merge; the workflow detects governance drift and prevents an ungoverned commit from being treated as release-ready.

## Main Certification

A green PR is necessary but is not the final application-certification authority. After the PR merges, the exact resulting `main` SHA must pass the post-merge status:

`Main Certification`

`.github/workflows/main-certification.yml` is the single post-merge application certification. It verifies the exact merged SHA, installs dependencies, runs static/build contracts, provisions disposable PostgreSQL, executes startup migrations, verifies backend and frontend regression/coverage, performs the API smoke sweep, and checks the server bundle, production-readiness, observability/stabilization, bandwidth, and mobile-routing contracts.

Normal `.github/workflows/ci.yml` protects the pull request and does not automatically rerun its complete heavy suite on a `main` push. Security, release verification, and resilience workflows remain separate specialist authorities for guarantees Main Certification does not duplicate.

Render is configured to deploy from `main` only after checks pass. Therefore a release is valid only when both conditions are true:

1. the change entered governed `main` through a current, green pull request; and
2. the exact merged `main` SHA passed Main Certification plus any specialist checks applicable to the release.

## Emergency changes

An emergency does not convert a direct push into an acceptable release path. Use a narrowly scoped pull request, keep the branch current with `main`, run the required gates, merge normally, and certify the resulting `main` SHA. If GitHub itself is unavailable, record the incident and restore the normal protection policy before the repository is considered release-ready again.
