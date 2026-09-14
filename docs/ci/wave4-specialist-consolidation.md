# Wave 4 Specialist Workflow Consolidation

Wave 4 removes repeated specialist execution after Main Certification became the authoritative post-merge application suite.

## Final ownership

| Capability | Owner | Trigger model |
|---|---|---|
| Release evidence | `release-verification.yml` | explicit `workflow_dispatch` only |
| Disposable backup/restore rehearsal | `resilience-rehearsal.yml` | weekly schedule + manual |
| Live production backup restore proof | `backup-restore-verification.yml` | weekly schedule + manual; kept separate |
| Dependency policy | `security.yml` / `Dependency audit` | pull request + scheduled/manual deep scan |
| Secret scanning | `security.yml` / `Secret scan` | pull request + scheduled/manual |
| Focused security readiness | `security.yml` / `Focused security readiness` | pull request + scheduled/manual |
| Dependency Review compatibility context | `security.yml` / `Dependency Review` | mirrors canonical dependency-audit result without rerunning it |
| CodeQL | `codeql.yml` | separate specialist analysis |
| Semgrep | `semgrep.yml` | separate specialist analysis |
| i18n ratchet | `ui-quality.yml` / `Classified untranslated-text audit` | every PR context; audit work only for relevant paths |
| RTL/accessibility | `ui-quality.yml` / `RTL / Accessibility` | relevant UI/i18n paths + manual |
| Rendered mobile/responsive regression | `ui-quality.yml` / `Mobile Responsiveness` | relevant UI/mobile paths + manual |

## Retired duplicate automation

The following active workflow files were retired because equivalent or stronger ownership now exists elsewhere:

- `dispatch-release-verification-once.yml`
- `release-verification-latest-main.yml`
- `security-readiness-parity.yml`
- `dependency-review.yml`
- `mobile-responsive.yml`
- `rtl-accessibility.yml`
- `i18n-audit.yml`
- `phase15-final-certification.yml`
- `phase3-completion-verification.yml`

`release-verification.yml` remains available, but nothing automatically dispatches it after every `main` commit. Main Certification is the post-merge application authority.

## Safety invariants

- No coverage threshold is lowered by this wave.
- Main Certification remains unchanged as the exact merged-SHA application certification.
- The live production backup workflow is not replaced by a disposable database rehearsal.
- CodeQL and Semgrep stay separate because they provide different security analysis.
- Current ruleset context names `Secret scan`, `Dependency audit`, `Focused security readiness`, `Dependency Review`, and `Classified untranslated-text audit` continue to be produced so Wave 4 cannot strand required checks before the Wave 5 ruleset migration.
- UI specialist workflows keep rendered mobile, RTL, accessibility, multilingual, and i18n ratchet assertions while generic typecheck/lint/frontend regression remains owned by CI.
- The rendered mobile job still builds the application because the browser smoke requires the production server bundle; this is a runtime prerequisite rather than a second generic build gate.

## Wave 5 boundary

Wave 4 does not edit the active ruleset. Wave 5 will replace historical required contexts with the final authoritative PR contexts and prove parity with a controlled PR and exact merged-SHA certification.
