# Wave 5 — PR Protection Policy

Wave 5 moves branch protection from historical/post-merge compatibility statuses to checks that genuinely execute on pull-request heads.

## Target required PR contexts

The final strict required-check list for `main` is:

1. `Check / Build / Lint / Test`
2. `Secret scan`
3. `Dependency audit`
4. `Focused security readiness`
5. `Analyze JavaScript / TypeScript`
6. `Semgrep CE new-findings gate`
7. `actionlint`
8. `zizmor`
9. `Classified untranslated-text audit`

The machine-readable source of truth is `config/pr-protection-policy.json` and `scripts/verify-pr-protection-policy.mjs` verifies that every required context has a pull-request producer.

## Contexts removed from PR protection

`Protect main and release path` remains a post-merge/scheduled governance check and is not a PR gate. `Main Certification` remains the authoritative exact-merged-main certification and is not a PR gate.

The following compatibility-only contexts are retired from required branch protection:

- `Dependency Review` — compatibility alias for the canonical dependency audit.
- `ci/circleci: static-build`
- `ci/circleci: postgres-regression`
- `ci/circleci: backend-core-regression`
- `ci/circleci: frontend-regression`
- `ci/circleci: security-readiness`

The five CircleCI statuses do not provide independent coverage; they mirror GitHub CI and can be removed after the live ruleset stops requiring them.

## Trigger corrections

Wave 5 gives real PR execution paths to the security/static-analysis contexts that the historical ruleset named without actually producing on PRs:

- CodeQL: PR + scheduled/manual.
- Semgrep regression: PR; full repository scan remains scheduled/manual.
- actionlint: PR/manual; only changed workflows are linted on PRs.
- zizmor: PR/manual plus scheduled audit.

Security and UI Quality already gained PR ownership in Wave 4.

## Safe migration order

1. Merge/land the Wave 4 specialist consolidation.
2. Prove all nine target contexts on a real PR head.
3. Replace the live ruleset's required-status list with the nine target contexts while retaining strict status checks, pull-request enforcement, review-thread resolution, non-fast-forward protection, and deletion protection.
4. Verify the live ruleset through the GitHub API.
5. Remove the `Dependency Review` compatibility job and `.circleci/config.yml` only after the live policy no longer requires those contexts.
6. Run a final PR to prove the reduced policy cannot be stranded by post-merge-only statuses.

No coverage threshold, migration gate, application test, secret scan, semantic security scan, release governance rule, or exact-main certification is weakened by this migration.
