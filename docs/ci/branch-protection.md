# Branch Protection, Required Checks, and CI Ownership

This document defines the current protection model for the `main` branch of `Hassan-Merhi/ERP-FACTORY-SYSTEM` and records the Wave 1 CI-consolidation audit completed on 2026-09-13.

Audit baseline: `cefa631f157559ceca6d604818a9a003d63dc338`.

Wave 1 is an inventory and ownership exercise only. It does **not** weaken, delete, rename, or change the trigger of any check. Later consolidation waves must preserve equivalent or stronger coverage before retiring a workflow or required status context.

## Live main ruleset

The active repository ruleset is `Phase 1 - Protect main and Release Governance`. It targets `refs/heads/main` and currently enforces:

- pull requests before merge;
- review-thread resolution;
- non-fast-forward protection;
- branch-deletion protection;
- strict required status checks.

The live ruleset currently names 16 required status contexts:

1. `Protect main and release path`
2. `Check / Build / Lint / Test`
3. `Secret scan`
4. `Dependency audit`
5. `Focused security readiness`
6. `Analyze JavaScript / TypeScript`
7. `Semgrep CE new-findings gate`
8. `Dependency Review`
9. `actionlint`
10. `zizmor`
11. `Classified untranslated-text audit`
12. `ci/circleci: static-build`
13. `ci/circleci: postgres-regression`
14. `ci/circleci: backend-core-regression`
15. `ci/circleci: frontend-regression`
16. `ci/circleci: security-readiness`

## Required-context audit

Only one of those 16 contexts currently has a normal pull-request execution path: `Check / Build / Lint / Test`, produced by `ci.yml`.

| Required context | Current producer | Normal PR producer? | Wave 1 finding |
|---|---|---:|---|
| `Protect main and release path` | `release-governance.yml` | No | Post-merge governance; unsuitable as a PR-required check |
| `Check / Build / Lint / Test` | `ci.yml` | Yes | Correct canonical PR gate |
| `Secret scan` | `security.yml` | No | Main/scheduled/manual only |
| `Dependency audit` | `security.yml` | No | Main/scheduled/manual only |
| `Focused security readiness` | `security-readiness-parity.yml` | No | Main/manual only |
| `Analyze JavaScript / TypeScript` | `codeql.yml` | No | Main/scheduled only |
| `Semgrep CE new-findings gate` | `semgrep.yml` | No | Job has PR logic, workflow has no PR trigger |
| `Dependency Review` | `dependency-review.yml` | No | Main/manual only |
| `actionlint` | `actions-quality.yml` | No | Workflow has PR-aware code, but no PR trigger |
| `zizmor` | `actions-quality.yml` | No | Main/scheduled/manual only |
| `Classified untranslated-text audit` | `i18n-audit.yml` | No | Main push only |
| `ci/circleci: static-build` | CircleCI compatibility bridge | No | Main-only alias of GitHub CI |
| `ci/circleci: postgres-regression` | CircleCI compatibility bridge | No | Main-only alias of GitHub CI |
| `ci/circleci: backend-core-regression` | CircleCI compatibility bridge | No | Main-only alias of GitHub CI |
| `ci/circleci: frontend-regression` | CircleCI compatibility bridge | No | Main-only alias of GitHub CI |
| `ci/circleci: security-readiness` | CircleCI compatibility bridge | No | Main-only alias of GitHub CI |

This mismatch must be corrected together with workflow-trigger cleanup. Removing or renaming a producer before the ruleset is migrated would make the policy less coherent, not more secure.

## Wave 1 workflow inventory

The repository has 37 GitHub Actions workflow files plus CircleCI compatibility plumbing. Runtime class is based on configured timeout and workload, not an observed wall-clock guarantee.

| Workflow | Trigger summary | Purpose | Runtime class | Consolidation classification |
|---|---|---|---|---|
| `actions-quality.yml` | main, weekly, manual | actionlint + zizmor | Medium | Keep capability; align PR ownership later |
| `ai-repair-intake.yml` | workflow-run, manual | Opens/reconciles repair issues | Light | Separate automation |
| `architecture-drift.yml` | weekly, manual | Dependency/toolchain/migration drift | Medium | Keep scheduled |
| `backup-restore-verification.yml` | weekly, manual | Restore verification from live production backup source | Medium | Keep; unique operational evidence |
| `browser-e2e.yml` | path-filtered main, manual | Transactional browser E2E | Heavy | Keep specialist coverage |
| `build-windows.yml` | desktop tag, manual | Windows MSIX build | Medium | Keep release artifact workflow |
| `ci-repair-bot.yml` | every 15 min, manual | Trusted-PR repair automation | Light/Medium | Separate automation |
| `ci-repair-failure-trigger.yml` | manual only | Intended PR failure watcher | Up to 75 min | Broken trigger; retire or repair |
| `ci-repair-sweep.yml` | `workflow_call` | Shared trusted-PR failure scan | Light | Keep if repair bot remains |
| `ci.yml` | PR, main, manual | Audits, typecheck, lint/format, build, backend/frontend coverage, aggregate gate | Heavy | Target PR owner |
| `codeql.yml` | main, weekly | CodeQL JS/TS | Medium | Keep specialist security |
| `dependabot-automerge.yml` | manual only | Intended Dependabot auto-merge | Light | Broken trigger; retire or repair |
| `dependency-review.yml` | main, manual | Production dependency policy | Light/Medium | Duplicate security ownership |
| `dependency-toolchain-health.yml` | path-filtered main, weekly, manual | Lockfile/toolchain/dependency health | Medium | Keep periodic/path-specific capability |
| `dispatch-release-verification-once.yml` | main + historical phase branches | Dispatches Release Verification | Light | Remove from normal main path later |
| `exact-main-certification.yml` | main, manual | Exact merged-SHA certification | Very heavy | Target main-certification owner |
| `i18n-audit.yml` | main | Untranslated-text classifier + ratchet | Light | Keep capability; make path/PR appropriate |
| `maintenance-scorecard.yml` | weekly, manual | OpenSSF Scorecard + SARIF | Light/Medium | Direct duplicate; retain one Scorecard owner |
| `mobile-responsive.yml` | path-filtered main, manual | Responsive/multilingual rendered regression | Very heavy | Keep specialist coverage |
| `performance-database-safety.yml` | path-filtered main | Query/resource/residency safety | Light/Medium | Keep specialist contract |
| `phase15-final-certification.yml` | workflow-file changes on main, manual | Historical final 100/100 certification | Very heavy | Legacy; retire after parity confirmation |
| `phase3-completion-verification.yml` | deleted branch, manual | Historical Phase 3 capacity verification | Heavy | Legacy/dead automatic trigger |
| `pr-company-parent-verify.yml` | deleted branch | Historical company-parent regression | Medium | Legacy/dead automatic trigger |
| `pr-po-import-verify.yml` | deleted branch | Historical PO import regression | Medium | Legacy/dead automatic trigger |
| `pr-tests.yml` | PR | Backend/database coverage + frontend coverage | Heavy | Direct duplicate of CI PR lanes |
| `production-canary.yml` | every 15 min, manual | Production health probe | Light | Keep if endpoint configured |
| `realtime-verification.yml` | path-filtered PR, manual | Focused realtime/browser verification | Medium/Heavy | Keep specialist PR coverage |
| `release-governance.yml` | main, daily, manual | Protected-main and merged-PR ancestry | Light | Keep post-merge governance |
| `release-verification-latest-main.yml` | release workflow completion, hourly, manual | Forces latest-main Release Verification | Light | Remove continuous-main coupling later |
| `release-verification.yml` | manual | Broad release evidence | Very heavy | Keep release/manual only |
| `repository-janitor.yml` | daily, manual | Safe branch cleanup/reporting | Light | Keep maintenance |
| `resilience-rehearsal.yml` | main, weekly, manual | Disposable backup/restore | Medium | Remove every-main duplication; keep scheduled/manual if useful |
| `rtl-accessibility.yml` | main, manual | RTL/accessibility/i18n plus generic build/lint/frontend | Heavy | Keep unique contracts; remove generic repetition |
| `scorecards.yml` | protection event, weekly, main, manual | OpenSSF Scorecard + SARIF | Light/Medium | Direct duplicate of maintenance Scorecard |
| `security-readiness-parity.yml` | main, manual | Focused `check:security` | Medium | Duplicate security owner |
| `security.yml` | main, weekly, manual | Dependency gate + full-history secret scanning | Medium | Target dependency/secret owner |
| `semgrep.yml` | main, weekly, manual | Semgrep regression/full scan | Medium | Keep; restore coherent PR trigger if required |

## Direct duplication found

### PR application tests

`ci.yml` already provides backend/database coverage and frontend coverage on pull requests. `pr-tests.yml` independently runs the same expensive families again. A documentation-only pull request demonstrates the difference clearly: `ci.yml` can correctly skip application build/backend/frontend lanes based on changed files, while `pr-tests.yml` still starts the full backend/database and frontend coverage jobs.

Target: `ci.yml` becomes the single authoritative PR application-test owner once parity is proven.

### Main certification

Three systems overlap heavily:

- `ci.yml` on `main` push;
- `exact-main-certification.yml` on `main` push;
- automatically dispatched `release-verification.yml` for current `main`.

They repeat substantial portions of build, disposable database setup, startup migration verification, backend/frontend regression, coverage, smoke, and production-readiness checks.

Target: Main Certification owns exact merged-SHA validation. Release Verification becomes explicit release/manual evidence rather than another every-commit main test suite.

### Resilience

Disposable backup/restore rehearsal is repeated in Exact Main Certification, Resilience Rehearsal, and Phase 15 Final Certification.

`backup-restore-verification.yml` is **not** a duplicate to remove: it uniquely dumps a configured live production database source read-only and proves that backup restores into an isolated database.

### Security and dependencies

Production/security checks are distributed across:

- `security.yml`;
- `dependency-review.yml`;
- `dependency-toolchain-health.yml`;
- `architecture-drift.yml`;
- `security-readiness-parity.yml`;
- Exact Main Certification;
- Release Verification;
- Phase 15 Final Certification.

Target: one blocking dependency/secret security owner, distinct CodeQL/Semgrep analysis, and deeper scheduled drift/toolchain work.

### UI, accessibility, and translation

`i18n-audit.yml`, `rtl-accessibility.yml`, `mobile-responsive.yml`, and Release Verification overlap. `rtl-accessibility.yml` also repeats generic typecheck/build/lint/frontend regression that belongs to CI/Main Certification.

Target: retain the unique responsive, browser, RTL, accessibility, and translation assertions while removing generic duplicate build/test execution.

### OpenSSF Scorecard

`scorecards.yml` and `maintenance-scorecard.yml` both run `ossf/scorecard-action` and upload SARIF. This is direct duplicate security work. One scheduled owner is sufficient.

### Release Verification dispatch

`dispatch-release-verification-once.yml` dispatches Release Verification on main pushes. `release-verification-latest-main.yml` independently watches Release Verification and checks hourly whether current main has a run, redispatching when needed.

Target: release verification should be explicit release/manual evidence, not continuously forced for every main commit.

## CircleCI compatibility inventory

`.circleci/config.yml` states that canonical build/test/security validation has moved to GitHub Actions. CircleCI keeps five historical status names for policy compatibility. Its `github-ci-gate` waits for the GitHub Actions `CI` run on the exact SHA, then releases five compatibility jobs:

- `ci/circleci: static-build`
- `ci/circleci: postgres-regression`
- `ci/circleci: backend-core-regression`
- `ci/circleci: frontend-regression`
- `ci/circleci: security-readiness`

These are not independent test coverage. The active ruleset must stop requiring them before the compatibility bridge is retired.

## Historical and dead automatic triggers

The following branch-specific workflows target branches that no longer exist:

- `pr-company-parent-verify.yml` → `fix/company-parent-configuration`
- `pr-po-import-verify.yml` → `fix/po-import-non-parent-suppliers`
- `phase3-completion-verification.yml` → `fix/proforma-capacity-phase3-finalize-20260910`

No current branch matching `program/erp-90-phase-*` was found, so that part of the old Release Verification dispatcher is historical as well.

`phase15-final-certification.yml` is also phase-specific. Its automatic main trigger is limited to changes to that workflow file itself, so it does not normally certify application commits.

## Trigger drift

### `ci-repair-failure-trigger.yml`

The workflow declares only `workflow_dispatch`, but its principal job requires `github.event_name == 'pull_request'`. That job cannot execute from the workflow's declared event. It should be retired if superseded by the repair sweep/bot, or restored to a real safe PR trigger.

### `dependabot-automerge.yml`

The workflow declares only `workflow_dispatch`, while its job condition and inputs require `github.event.pull_request`. A manual event does not contain that payload, so the intended auto-merge job cannot become eligible.

### `actions-quality.yml` and `semgrep.yml`

Both contain explicit PR-aware logic, but neither currently declares a `pull_request` trigger. This is workflow-trigger drift and explains why their contexts are not normal PR checks despite being present in the required-status list.

## Toolchain naming drift

The actual canonical Node runtime used by current workflows is `24.21.0`, while several human-readable step names still say `Node.js 24.19.0`. This is label/documentation drift rather than a runtime mismatch and should be normalized during consolidation.

## Target ownership after consolidation

| Final owner | Responsibility | Trigger model |
|---|---|---|
| **CI** | repository audits, typecheck, lint/format, build, startup migration proof, backend/frontend tests + coverage, coverage ratchet | PR |
| **Main Certification** | exact merged SHA, disposable schema/startup, backend/frontend verification, smoke, production-readiness/observability contracts, exact-main DR proof | main push |
| **Security** | dependency policy + full-history secret scanning | PR/main as appropriate, scheduled deep scans |
| **CodeQL** | semantic code scanning | PR and/or main + scheduled |
| **Semgrep** | new-findings regression + full scheduled scan | PR regression, scheduled full scan |
| **Browser E2E** | transactional rendered flows | relevant paths |
| **UI Quality** | responsive/mobile, RTL, accessibility, i18n and multilingual browser contracts | relevant UI/i18n paths |
| **Performance / DB Safety** | query/resource/residency contracts | relevant server/script paths |
| **Release Governance** | prove main remains protected and arrived through merged PR | main + scheduled |
| **Release Verification** | heavyweight release evidence | explicit release/manual |
| **Operations** | live backup restore, canary, architecture drift, repository janitor, one Scorecard | scheduled/manual |
| **Repair Automation** | intake/sweep/bot | workflow-run/scheduled/manual |
| **Desktop Release** | Windows MSIX | desktop tag/manual |

## Safety constraints for later waves

1. Do not retire `pr-tests.yml` until `ci.yml` is proven to provide equivalent or stronger backend/database and frontend coverage on the same PR head.
2. Do not remove or rename a ruleset-required context until the ruleset is migrated or a deliberate compatibility context exists.
3. Never remove the live backup verification when deduplicating disposable backup rehearsals.
4. Keep CodeQL and Semgrep distinct from generic unit-test CI; they provide different security coverage.
5. Keep specialist browser/realtime/mobile assertions. Remove only their repeated generic build/lint/test work once equivalent prerequisites are guaranteed elsewhere.
6. Preserve all coverage floors and stronger per-file ratchets. Consolidation reduces repeated execution, not thresholds.
7. Preserve fail-closed behavior for security, migrations, main certification, and release governance.
8. Fix workflow trigger drift before making those contexts required on PRs.

## Recommended final protection model

The exact required-check list will be changed only after the replacement workflows exist and are proven. The target is a small set of genuinely pre-merge contexts rather than post-merge contexts masquerading as PR gates.

At minimum, the eventual ruleset should require the canonical CI aggregate plus the security/static-analysis checks that actually run on PR heads. Post-merge Main Certification and Release Governance should remain authoritative main-health evidence but should not block a PR by requiring a context that can only be produced after merge.

## Validation checklist for the consolidation program

Before any later wave is called complete:

- a PR with a real application failure cannot merge;
- backend and frontend coverage floors remain unchanged or stronger;
- migration/startup failures remain blocking;
- secret/dependency/security failures remain blocking where intended;
- the exact merged main SHA receives authoritative certification;
- specialist browser/mobile/RTL/i18n/realtime checks keep their unique assertions;
- the live backup restore verification remains independent;
- no required context can sit pending merely because its workflow has no PR trigger;
- no deleted workflow remains required by the ruleset;
- no CircleCI compatibility alias remains required after the bridge is retired;
- direct pushes, force pushes, deletion, and unresolved review conversations remain protected according to repository policy.

## Wave 1 completion record

Wave 1 completed the following without modifying workflow behavior:

- [x] inventoried all 37 GitHub Actions workflows;
- [x] inventoried the CircleCI compatibility statuses;
- [x] mapped all 16 live required contexts to their producers;
- [x] identified duplicated command and responsibility families;
- [x] identified historical workflows tied to deleted branches;
- [x] identified trigger-broken and PR-trigger-drift workflows;
- [x] identified stale branch-protection and Node-label documentation;
- [x] defined target ownership for the remaining consolidation waves;
- [x] preserved every existing gate, threshold, trigger, test, and required context in Wave 1.

Wave 2 can consolidate PR execution around `ci.yml` using this ownership map rather than guessing which checks are authoritative.
