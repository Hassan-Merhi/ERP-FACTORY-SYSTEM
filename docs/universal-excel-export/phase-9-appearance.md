# Universal Excel Export — Phase 9 appearance settings

**Branch:** `feature/universal-excel-export-system` — still draft PR [#3204](https://github.com/Hassan-Merhi/ERP-FACTORY-SYSTEM/pull/3204). No merge or deployment.

## What is implemented

**Settings → Tools → Excel Export Appearance**, visible and editable only for users whose **active company role** is Admin or Developer. Owner, POS, Tester and View-Only do not see the item. The API checks effective session role again server-side: base Admin privileges are not enough after switching to View-Only.

The page supports:
- Dakzo Navy or Slate preset, custom six-digit RGB accent and branded organization name.
- Small PNG/JPG data-URL logo (135 KB maximum) and removal.
- Show/hide branding, company name and export date; zebra rows; printed report headers/footers.
- Date display format **DD/MM/YYYY** or **MM/DD/YYYY**.
- Editable custom print header/footer text (no Excel control tokens or unsafe characters).
- Live on-page preview, **Download sample XLSX** (unsaved changes), Save, Restore Defaults draft.

**Saved scope:** current company only, not global or user-specific. A row in the existing `system_settings` table has key `excel_appearance_c_<companyId>`; no new tables or migrations. GET `/api/excel-export/appearance` returns only the session company's setting to any authenticated member (for applying appearance to exports); PUT allows current Admin/Developer role only. Both endpoints explicitly use `req.session.currentCompanyId` and ignore arbitrary target IDs. The API returns `Cache-Control: private, no-store`. The settings serializer validates length, type, palette, logo media type and PNG/JPEG signature before persisting.

**Report application:** all browser-generated reports that use `downloadUniversalExcelWorkbook` read appearance **at export click**; a company switch cannot reuse another company's branding. The server `sendUniversalExcelWorkbook` and attachment adapter accept a company ID for server-scoped settings. Monthly Production Matrix and Stock Transfer Order use optional saved styling and retain their existing cell positions; server SP Sales Form V2 and the per-container report read current company settings.

The shared engine embeds small PNG/JPG logos only on regular branded report sheets with **at least five columns**, within the existing metadata area, without shifting the first data row or table columns. More compact reports retain text branding without a potentially obscuring image. Custom company-facing invoices, customer-editable import templates, strict barcode/price-list formats and hidden SP costing/sales sheets keep their original workbook structures and company logos. Original/legacy specialized exports keep their own render logic; the common style adapter honors print preferences when given a saved appearance.

**Security/privacy:** uploads are local PNG/JPG files; no external logo URLs, SVG, HTML, scripts, untrusted Excel formula data or file-system paths. The server rejects oversized/invalid payloads and stores no external image references. Existing authorization over cost, FX, ledger, stock and supplier/customer records is unchanged. Settings do not mutate Excel data or company transactions.

## Verification

Tests:
- `tests/universal-excel-appearance-settings.test.ts`: color and image validation, branding, logo XLSX roundtrip, date/company visibility, print text, strict import coordinates and native numeric values.
- `tests/excel-appearance-routes.test.ts`: active-role Admin/Developer guard, session company-only read/write, no target-ID override.
- `tests/ui/universal-excel-appearance-client.test.ts`: no stale company styles, no lookup for import-template, unsaved sample XLSX, fail closed on failed preference lookup.
- Existing engine/design/dynamic column, specialized, financial and Factory Excel tests.

Before deployment: run TypeScript, lint, production build, focused unit and UI tests, PostgreSQL-backed settings persistence and permission integration, XLSX appearance preview with real PNG/JPG and all company roles, full database-backed SP/export round-trip tests. The final PR localization audit and synchronization with `main` remain Phase 10 release blockers.

**No schema migration, SQL script, voucher posting, main merge or Render deployment in Phase 9.** Saving a preference through the UI writes only its existing per-company `system_settings` value.

## Observed Phase 9 validation — 2026-11-14

[Temporary branch validation run #43574393804](https://github.com/Hassan-Merhi/ERP-FACTORY-SYSTEM/actions/runs/43574393804) passed **all seven gates** after fixing one unused settings icon import:

1. TypeScript `npm run check` — passed.
2. Backend/engine/report style tests — **76 passed**, 9 suites, including per-company settings schema, strict logo security, XLSX image round-trip and server active-role route boundaries.
3. Frontend export tests — **18 passed**, 3 suites, including fresh per-company appearance fetch, unsaved preview, strict import-template behavior and failure on wrong-company/403 settings response.
4. Changed-source formatting — passed.
5. Lint — **4,509 files**, zero errors and zero warnings.
6. Production build — passed.
7. Documentation index — passed.

The temporary GitHub Action was removed after success. These are branch and focused regression checks, not proof of deployed live permissions, PostgreSQL persistence or full PR merge compatibility.

### Rollout scope note

Regular browser exports using the universal engine apply the saved company appearance automatically on download. The dedicated server engine adapters can apply a passed company ID, and the SP Sales Form V2 and hierarchical container export read per-company appearance. Specialized browser Monthly Production and Truck Trip workbooks use best-effort preference loading and preserve their original print format if the settings API is unavailable. Canonical invoices, strict import templates and additional legacy direct-to-Excel routes intentionally preserve their original company-facing styling; final compatibility sweep and PR i18n/CI are Phase 10.
