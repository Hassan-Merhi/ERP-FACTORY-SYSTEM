# Universal Excel Export — Phase 10 integration and release certification

**Branch:** `feature/universal-excel-export-system` · **PR:** [#3204](https://github.com/Hassan-Merhi/ERP-FACTORY-SYSTEM/pull/3204) · **Release state:** HOLD — draft only, do not merge or deploy.

## Phase 10 objectives

Bring Phase 1–9 Excel exporters together on current `main`, preserve importing templates and financial source values, close EN/AR/FR localization, verify company/role isolation with a disposable PostgreSQL service, and obtain evidence from required GitHub checks before release approval.

## Integration evidence and limits (2026-11-14)

- `main` is the PR base `ced40d990eac68ee4fe4c7497fc523518f5650f7`; GitHub comparison showed feature ahead with **zero commits behind** at inspection. The PR reports **mergeable: true**, which is not equivalent to CI passing.
- Latest inspected head `a8898619c5e05c07d99b6555982734db2e80fc33` had **queued/pending required checks**; there was no justified full-green result at inspection.
- Temporary certification workflows on this branch: `.github/workflows/universal-excel-phase10-i18n.yml` for base-relative translation findings, and `.github/workflows/universal-excel-phase10-database.yml` for isolated PostgreSQL workbook, settings, import and report tests. These workflows must produce **successful results at the final commit**, not at an older SHA.
- The database workflow uses disposable local PostgreSQL `heliumdb`, not a deployed company's database. The appearance persistence test explicitly guards against modifying any non-local database; passing it never proves company data on production.
- Prior Phase 9 focused CI evidence: [run 43574393804](https://github.com/Hassan-Merhi/ERP-FACTORY-SYSTEM/actions/runs/43574393804), 76 core and 18 frontend tests plus lint/type/build/doc checks. That does **not** certify Phase 10.
- No SQL migrations, financial posting, production data edits, `main` merge or Render deploy are authorized by this phase.

## Required gates — all must be satisfied

| Gate | Acceptance evidence | At inspection |
| --- | --- | --- |
| Branch integration | Feature based on newest `main`, no unresolved conflicts | **Pass** relative to inspected main |
| EN/AR/FR | Phase 10 i18n workflow passes on final head; all new actionable literals fixed | **Not yet certified** |
| Workbook data integrity | Financial DR/CR, currency and precision tests pass; export never recalculates source accounting | **Not yet certified** |
| Import compatibility | Row-one exact headers, article aliases, barcode/quantity, zero unsafe formula inputs; XLSX round-trip | **Not yet certified** |
| Company and role security | Saved appearance, company switch, View-Only/Owner/POS access boundaries and hidden-cost exports | **Not yet certified** |
| Operational coverage | ERP stock/containers/PO/suppliers and Factory inventory/production/dispatch export scopes, all filtered rows | **Not yet certified** |
| Legacy specialized exports | SP V2 hidden formulas, invoices, production matrix, financial multi-sheet, print/layout unchanged | **Not yet certified** |
| Full repository CI | Required CI, security, CodeQL, UI quality and protection checks all green on the **exact final SHA** | **Queued/pending at inspection** |
| Real-company/UAT | Admin, Developer and ordinary user screenshots/workbook checks on representative staging companies, permissions and page filters; sign-off | **Not performed** |
| Release approval | Explicit owner permission to merge and deploy | **Not requested** |

### Safety invariants

1. Import-format sheets are contracts: the header row, sheet names and required codes must not shift for appearance preferences.
2. Currency amounts, signed DR/CR, price precision, FX provenance and cost-hidden permissions must come unchanged from their existing authorized report sources.
3. Exports must use the active server company and effective role; a browser company switch must not reuse cached appearance or hidden costs from another company.
4. Spreadsheet-controlled strings beginning with formula operators must be treated as text; no formula injection through names, branding, or imported values.
5. Preserve invoice and specialized report layouts when auto-styling would change formulas, coordinates or print areas.
6. Any CI failure should be fixed on **this branch** and revalidated; no skipping checks or weakening ratchets.

## Next release decision

Keep PR #3204 **draft and unmerged** until successful Phase 10 workflows, full repository CI, database-backed security and workbook integrity, staging UAT, and owner sign-off are attached to this document. CI results may arrive after this inspection; update status only from verified results. Remove the two temporary certification workflows before final merge if the permanent CI has equivalent coverage, documenting the run URLs and exact final SHA.
