# CI Consolidation — Wave 1 Audit

Audit baseline: `cefa631f157559ceca6d604818a9a003d63dc338` on `main` (2026-09-13).

Wave 1 is documentation and ownership mapping only. It intentionally does **not** weaken, delete, rename, or change the trigger of any check. Later waves must preserve equivalent or stronger coverage before retiring a workflow or status context.

## Executive summary

The repository currently has **37 GitHub Actions workflow files** plus CircleCI compatibility plumbing. The main issues are not lack of coverage; they are duplicated ownership, stale phase-specific automation, trigger/policy drift, and repeated execution of the same expensive command families.

Key findings:

1. `ci.yml`, `exact-main-certification.yml`, and `release-verification.yml` overlap heavily across build, database preparation, backend/frontend regression, coverage, smoke, and production-readiness checks.
2. `pr-tests.yml` duplicates the backend/database and frontend coverage work already owned by `ci.yml` for pull requests.
3. `resilience-rehearsal.yml`, `exact-main-certification.yml`, and `phase15-final-certification.yml` each perform a disposable backup/restore rehearsal. `backup-restore-verification.yml` is different and valuable because it verifies the live production backup source.
4. `scorecards.yml` and `maintenance-scorecard.yml` both run the OpenSSF Scorecard action and upload SARIF. This is a direct duplicate.
5. Dependency/security checks are repeated across `security.yml`, `dependency-review.yml`, `dependency-toolchain-health.yml`, `architecture-drift.yml`, `exact-main-certification.yml`, `release-verification.yml`, and `phase15-final-certification.yml`.
6. i18n/accessibility work overlaps across `i18n-audit.yml`, `rtl-accessibility.yml`, `mobile-responsive.yml`, and `release-verification.yml`; `rtl-accessibility.yml` also re-runs generic build/lint/frontend regression already covered elsewhere.
7. `dispatch-release-verification-once.yml` dispatches Release Verification after main pushes while `release-verification-latest-main.yml` independently watches and redispatches it when current main lacks a run. That is overlapping orchestration around the same heavyweight workflow.
8. `ci-repair-failure-trigger.yml` is trigger-broken: it declares only `workflow_dispatch`, but its main job requires `github.event_name == 'pull_request'`, so that job cannot run from the declared trigger.
9. `dependabot-automerge.yml` has the same trigger-shape defect: it is manual-only but gates the job on `github.event.pull_request`, so a manual dispatch cannot satisfy the job condition.
10. Three branch-specific verification workflows target branches that no longer exist: `pr-company-parent-verify.yml`, `pr-po-import-verify.yml`, and `phase3-completion-verification.yml`.
11. The active `main` ruleset requires 16 status contexts, but only the aggregate CI context is produced by a normal PR workflow. The other GitHub required contexts are currently produced by main/scheduled workflows, while the five CircleCI compatibility contexts are configured only for `main`. This makes the ruleset inconsistent with the workflow trigger model and encourages bypass-based merging instead of normal required-check enforcement.
12. `docs/ci/branch-protection.md` is stale: it still names the old `Hassan-Merhi/etshadierp` repository and documents only three required checks, while the live ruleset currently contains 16 contexts.
13. Several step labels still say Node.js `24.19.0` while the actual configured toolchain is `24.21.0`. This is naming/documentation drift, not a runtime mismatch.

## Current workflow inventory

Runtime is expressed as a **budget/class**, based on each workflow's configured timeout and the work it performs, not as an observed wall-clock guarantee.

| Workflow | Trigger summary | Purpose | Runtime class | Wave 1 classification |
|---|---|---|---|---|
| `actions-quality.yml` | main push, weekly, manual | actionlint + zizmor | Medium | Keep capability; move/align PR ownership later |
| `ai-repair-intake.yml` | workflow-run of CI/CodeQL/Semgrep/Security, manual | Opens/reconciles evidence-backed repair issues | Light | Separate automation; not test duplication |
| `architecture-drift.yml` | weekly, manual | Dependency/toolchain/migration drift | Medium | Keep scheduled; overlaps dependency audits by design |
| `backup-restore-verification.yml` | weekly, manual | Dump/restore **live production** DB read-only backup source | Medium | Keep; unique operational evidence |
| `browser-e2e.yml` | main push with app path filters, manual | Transactional browser E2E | Heavy | Keep specialist coverage; avoid generic build duplication later |
| `build-windows.yml` | `desktop-v*` tag, manual | Windows MSIX build | Medium | Keep; separate release artifact |
| `ci-repair-bot.yml` | every 15 min, manual | Detect/repair trusted PR failures | Light/Medium | Separate automation; review polling cost later |
| `ci-repair-failure-trigger.yml` | manual only | Intended PR failure watcher | Up to 75 min | **Broken trigger; retire or repair** |
| `ci-repair-sweep.yml` | reusable `workflow_call` | Shared trusted-PR failure scan | Light | Keep if repair bot remains |
| `ci.yml` | PR to main, main push, manual | Canonical repo audits, typecheck, lint/format, build, DB/backend/frontend coverage, ratchet, aggregate gate | Heavy | **Target PR owner** |
| `codeql.yml` | main push, weekly | CodeQL JS/TS analysis | Medium | Keep specialist security; add/align PR trigger if required |
| `dependabot-automerge.yml` | manual only | Intended Dependabot patch/minor auto-merge | Light | **Broken trigger; retire or repair** |
| `dependency-review.yml` | main push, manual | Reviewed high/critical production dependency gate | Light/Medium | Duplicate security ownership; consolidate later |
| `dependency-toolchain-health.yml` | main push on toolchain paths, weekly, manual | Lockfile/workspace/toolchain/dependency health | Medium | Keep scheduled + path-specific capability; remove duplicate push work later |
| `dispatch-release-verification-once.yml` | main + old program-phase branch pushes | Dispatches Release Verification | Light | Overlaps latest-main watchdog; retire from normal main path later |
| `exact-main-certification.yml` | main push, manual | Exact merged SHA static/build/DB/backend/frontend/smoke/security/DR certification | Very heavy (120 min budget) | **Target main certification owner** |
| `i18n-audit.yml` | main push | Untranslated-text classifier + ratchet | Light | Keep capability; make path/PR appropriate later |
| `maintenance-scorecard.yml` | weekly, manual | OpenSSF Scorecard + SARIF | Light/Medium | Duplicate of `scorecards.yml`; keep one only |
| `mobile-responsive.yml` | main push with UI paths, manual | Responsive/multilingual rendered regression | Very heavy (75 min budget) | Keep specialist coverage; remove generic repeats later |
| `performance-database-safety.yml` | main push with server/scripts paths | Query/resource/scheduler/route-residency safety | Light/Medium | Keep specialist contract; path-filtered |
| `phase15-final-certification.yml` | main push only when this workflow changes, manual | Historical final 100/100 certification | Very heavy (120 min budget) | Legacy certification; retire after parity confirmation |
| `phase3-completion-verification.yml` | deleted Phase-3 branch, manual | Historical proforma-capacity Phase 3 verification/mutation | Heavy (55 min budget) | Legacy/dead automatic trigger; retire |
| `pr-company-parent-verify.yml` | deleted branch only | Historical company-parent regression | Medium | Legacy/dead automatic trigger; retire |
| `pr-po-import-verify.yml` | deleted branch only | Historical PO import regression | Medium | Legacy/dead automatic trigger; retire |
| `pr-tests.yml` | PR to main | Backend/database coverage + frontend coverage | Heavy | **Direct duplicate of CI PR lanes; retire after CI parity** |
| `production-canary.yml` | every 15 min, manual | Production health endpoint probe | Light | Keep if configured; scheduled no-op if secret absent |
| `realtime-verification.yml` | PR with realtime path filters, manual | Focused realtime unit/server/browser verification | Medium/Heavy | Keep specialist PR coverage |
| `release-governance.yml` | main push, daily, manual | Verifies protected-main governance and merged-PR ancestry | Light | Keep post-merge governance; should not be a PR-required context |
| `release-verification-latest-main.yml` | Release Verification completion, hourly, manual | Ensures current main has a Release Verification run | Light | Overlaps dispatcher; remove hourly/main coupling when release verification becomes release-only |
| `release-verification.yml` | manual only | Phase-9-era heavyweight release verification incl. multilingual browser evidence | Very heavy (90 min budget) | Keep as release/manual verification, not every main commit |
| `repository-janitor.yml` | daily, manual | Safely deletes unchanged merged branches; reports stale branches | Light | Keep maintenance |
| `resilience-rehearsal.yml` | main push, weekly, manual | Disposable backup/restore + scheduler isolation | Medium | Remove from every main push; keep scheduled/manual if still useful |
| `rtl-accessibility.yml` | main push, manual | RTL/accessibility/i18n contracts plus generic build/lint/frontend regression | Heavy (45 min budget) | Keep specialist contracts; remove generic duplicate work and path-filter |
| `scorecards.yml` | branch-protection event, weekly, main push, manual | OpenSSF Scorecard + SARIF | Light/Medium | Direct duplicate of maintenance Scorecard; consolidate |
| `security-readiness-parity.yml` | main push, manual | Focused `check:security` against disposable DB | Medium | Duplicate security owner; consolidate |
| `security.yml` | main push, weekly, manual | Production dependency gate + full-history secret scanning | Medium | **Target dependency/secret security owner** |
| `semgrep.yml` | main push, weekly, manual | Semgrep regression/full scans | Medium | Keep specialist security; declared PR logic is unreachable without PR trigger |

## CircleCI inventory

`.circleci/config.yml` explicitly says canonical build/test/security work now runs in GitHub Actions. CircleCI retains five historical status names only for protection-policy compatibility. A `github-ci-gate` waits for the GitHub Actions `CI` run on the exact same SHA and then releases these five no-op compatibility jobs:

- `ci/circleci: static-build`
- `ci/circleci: postgres-regression`
- `ci/circleci: backend-core-regression`
- `ci/circleci: frontend-regression`
- `ci/circleci: security-readiness`

These jobs do **not** provide independent test coverage. They are status aliases around GitHub CI and should be removed from the ruleset before the CircleCI bridge is retired.

## Active ruleset mapping

The active ruleset `Phase 1 - Protect main and Release Governance` targets `refs/heads/main` and currently requires the following contexts.

| Required context | Producer | Normal PR producer exists? | Finding |
|---|---|---:|---|
| `Protect main and release path` | `release-governance.yml` | No | Post-merge governance; unsuitable as PR-required check |
| `Check / Build / Lint / Test` | `ci.yml` aggregate gate | **Yes** | Correct canonical PR gate |
| `Secret scan` | `security.yml` | No | Main/schedule/manual only |
| `Dependency audit` | `security.yml` | No | Main/schedule/manual only |
| `Focused security readiness` | `security-readiness-parity.yml` | No | Main/manual only |
| `Analyze JavaScript / TypeScript` | `codeql.yml` | No | Main/schedule only |
| `Semgrep CE new-findings gate` | `semgrep.yml` | No | Job has PR logic, workflow trigger does not |
| `Dependency Review` | `dependency-review.yml` | No | Main/manual only |
| `actionlint` | `actions-quality.yml` | No | Workflow has PR-aware code but no PR trigger |
| `zizmor` | `actions-quality.yml` | No | Main/schedule/manual only |
| `Classified untranslated-text audit` | `i18n-audit.yml` | No | Main push only |
| `ci/circleci: static-build` | CircleCI compatibility bridge | No | CircleCI filter is main-only; alias of GitHub CI |
| `ci/circleci: postgres-regression` | CircleCI compatibility bridge | No | Same |
| `ci/circleci: backend-core-regression` | CircleCI compatibility bridge | No | Same |
| `ci/circleci: frontend-regression` | CircleCI compatibility bridge | No | Same |
| `ci/circleci: security-readiness` | CircleCI compatibility bridge | No | Same |

**Conclusion:** only 1 of 16 configured required contexts has a normal PR execution path. Ruleset cleanup must be coordinated with workflow-trigger cleanup; deleting or renaming producers first would make the policy even less coherent.

## Duplicate command / responsibility map

| Responsibility | Current owners | Target owner after consolidation |
|---|---|---|
| PR repository audits | `ci.yml` | `ci.yml` |
| PR typecheck/lint/build | `ci.yml`; also repeated by `pr-tests.yml` build lane indirectly and specialist workflows | `ci.yml`; specialists run only their unique checks |
| PR backend/database coverage | `ci.yml`, `pr-tests.yml` | `ci.yml` |
| PR frontend coverage | `ci.yml`, `pr-tests.yml`; full frontend also in RTL workflow on main | `ci.yml` |
| Exact merged-SHA regression | `ci.yml` main push, `exact-main-certification.yml`, auto-dispatched `release-verification.yml` | Main Certification only |
| Backend verify + merged coverage | Exact Main, Release Verification, Phase 15 | Main Certification; release workflow only when explicitly releasing |
| Frontend verify + coverage | Exact Main, Release Verification, Phase 15, RTL generic regression | Main Certification; release workflow only when explicitly releasing |
| Disposable DB/schema/startup | CI, PR Tests, Exact Main, Release Verification, Phase 15, browser/mobile/realtime specialists, historical branch workflows | CI/Main Certification plus only specialist fixtures that truly need browser state |
| API smoke sweep | Exact Main, Release Verification, Phase 15 | Main Certification; optional explicit release repeat |
| Production readiness/observability/bandwidth contracts | Exact Main, Release Verification, Phase 15, resilience subset | Main Certification |
| Focused app security | Exact Main, Release Verification, Phase 15, Security Readiness | One security owner + Main Certification only where exact-main proof is required |
| Production dependency vulnerability policy | Security, Dependency Review, Dependency Toolchain Health, Architecture Drift, Exact Main/Release/Phase15 npm audit | Security for blocking; scheduled toolchain/drift for deeper periodic audit |
| Secret scanning | `security.yml`, Release Verification TruffleHog | Security; release-only repeat optional |
| Disposable backup/restore | Exact Main, Resilience Rehearsal, Phase 15 | Main Certification; optional scheduled resilience evidence |
| **Live production** backup restore | `backup-restore-verification.yml` | Keep separate; unique operational test |
| Untranslated-text/i18n | i18n Audit, RTL/Accessibility, Release Verification, multilingual browser workflows | Consolidated UI/i18n specialist workflow with path filters |
| Responsive/browser | Mobile Responsiveness, Browser E2E, RTL/Accessibility, Release Verification multilingual browser smoke | Specialist browser/mobile lanes; no duplicate generic build/test work |
| OpenSSF Scorecard | `scorecards.yml`, `maintenance-scorecard.yml` | One scheduled Scorecard workflow |
| Release Verification dispatch | direct dispatcher + latest-main watchdog | Explicit release/manual trigger only |
| CircleCI required statuses | Five compatibility aliases after waiting on GitHub CI | Remove after ruleset migration |

## Historical / stale automation confirmed in Wave 1

The following automatic branch triggers point to branches that do not currently exist:

- `fix/company-parent-configuration` → `pr-company-parent-verify.yml`
- `fix/po-import-non-parent-suppliers` → `pr-po-import-verify.yml`
- `fix/proforma-capacity-phase3-finalize-20260910` → `phase3-completion-verification.yml`
- no current `program/erp-90-phase-*` branches were found, so that half of `dispatch-release-verification-once.yml` is also historical.

`phase15-final-certification.yml` is likewise a phase-specific certification artifact. Its automatic main trigger is restricted to changes to that workflow file itself, so it does not normally validate application commits.

## Trigger-broken automation

### `ci-repair-failure-trigger.yml`

Declared trigger: `workflow_dispatch` only.

Primary job condition: `github.event_name == 'pull_request'`.

Result: the job cannot run from its declared event. It should be retired if superseded by the scheduled/sweep repair mechanism, or restored to a real PR trigger in a later wave.

### `dependabot-automerge.yml`

Declared trigger: `workflow_dispatch` only.

Job condition and inputs depend on `github.event.pull_request`.

Result: a manual dispatch has no pull-request payload, so the intended auto-merge job cannot become eligible. It should be repaired to a safe Dependabot PR event or retired.

### PR-aware code without PR triggers

`actions-quality.yml` and `semgrep.yml` contain explicit `pull_request` handling/conditions, but their declared `on:` blocks do not include `pull_request`. This is strong evidence of workflow-trigger drift and explains why their required contexts are not produced as normal PR checks.

## Documentation drift

`docs/ci/branch-protection.md` currently:

- names `Hassan-Merhi/etshadierp` instead of `Hassan-Merhi/ERP-FACTORY-SYSTEM`;
- documents only `Check / Build / Lint / Test`, `Dependency audit`, and `Secret scan` as required checks;
- does not reflect the active 16-context ruleset or CircleCI compatibility bridge.

The document must be updated in the ruleset-migration wave, after the final required-check model is chosen.

Several workflow step labels also still say `Node.js 24.19.0` while `actions/setup-node` actually installs `24.21.0`. Consolidation should normalize labels without changing the pinned runtime.

## Proposed ownership after consolidation

This is the Wave 1 ownership target; later waves implement it.

| Final owner | Responsibility | Trigger model |
|---|---|---|
| **CI** | repo audits, typecheck, lint/format, build, startup migration proof, backend/frontend tests + coverage, coverage ratchet | PR; optional lightweight main confirmation only if needed |
| **Main Certification** | exact merged SHA, disposable schema/startup, backend/frontend verification, smoke, production-readiness/observability contracts, exact-main DR proof | main push |
| **Security** | dependency policy + full-history secret scanning | PR where safe/needed, main/scheduled for deep scans |
| **CodeQL** | semantic code scanning | PR and/or main + scheduled |
| **Semgrep** | new-findings regression + scheduled full scan | PR for regression; scheduled for full scan |
| **Browser E2E** | transactional rendered flows | relevant PR/main paths |
| **UI Quality** | mobile/responsive, RTL, accessibility, i18n contracts and rendered multilingual checks | relevant UI/i18n paths |
| **Performance / DB Safety** | query/resource/residency contracts | relevant server/script paths |
| **Release Governance** | proves main was protected and reached via merged PR | main + scheduled |
| **Release Verification** | heavyweight release evidence, not continuous main certification | explicit release/manual |
| **Operations** | live backup restore, canary, architecture drift, repository janitor, one Scorecard | scheduled/manual |
| **Repair Automation** | intake/sweep/bot | workflow-run/scheduled/manual, independent of required test coverage |
| **Desktop Release** | Windows MSIX | desktop tag/manual |

## Wave 2 safety constraints derived from this audit

1. Do not remove `pr-tests.yml` until `ci.yml` is proven to provide equivalent backend/database and frontend coverage on the same PR head.
2. Do not remove/rename any ruleset-required status context until the active ruleset is migrated or a compatibility context is deliberately retained.
3. Do not remove the live backup workflow when removing disposable backup rehearsal duplicates.
4. Do not collapse CodeQL and Semgrep into generic unit-test CI; they provide distinct static-analysis coverage.
5. Do not remove specialist browser/realtime/mobile checks simply because they also build the app; remove only the generic repeated steps once their unique assertions remain intact.
6. Preserve all current coverage thresholds and stronger per-file ratchets. Consolidation must reduce duplicate execution, not reduce thresholds.
7. Preserve fail-closed behavior for security, migrations, exact-main certification, and release governance.
8. Fix trigger drift before making affected contexts required on PRs.

## Wave 1 exit criteria

- [x] Inventory every GitHub Actions workflow file.
- [x] Inventory CircleCI compatibility jobs referenced by the active ruleset.
- [x] Map the 16 active required contexts to producers.
- [x] Identify duplicated command/responsibility families.
- [x] Identify historical/dead branch workflows.
- [x] Identify trigger-broken workflows.
- [x] Identify documentation drift.
- [x] Define target ownership for later waves.
- [x] Make no gate/threshold/trigger changes in Wave 1.

Wave 1 is complete when this audit is reviewed/merged. Wave 2 can then consolidate PR execution around `ci.yml` without guessing which checks are authoritative.
