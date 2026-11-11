# Factory blue-theme unification — Phase 4 visual QA and regression gates

**Date:** 2026-11-10
**Baseline:** `main` at `9be1b4227ca35b4dcc8e88b8e1e288c369dabc29`
**Scope:** Factory-only color consistency, dark/light appearance, responsive rendering, portal inheritance, and regression protection; no production data changes.

## Completed local validations

The existing Factory theme source regression suite passed **4/4** tests. A production frontend/server bundle built successfully using `npm run build`.

### Compiled-CSS browser visual QA

Added `scripts/verify-factory-blue-theme-browser.mjs`, a deterministic Chromium + Puppeteer visual fixture that imports the **actual compiled Vite CSS assets**, including Factory, ERP, Properties, and Factory page chunks. This is not a hand-painted replacement stylesheet.

| Fixture coverage | Verified |
| --- | --- |
| Factory light and dark modes | **2 modes** |
| Mobile, tablet and desktop widths | **320px, 390px, 768px, 1440px** |
| Rendered browser combinations | **8/8 passed** |
| All six legacy blue/indigo/purple/violet/sky/fuchsia palette aliases | Same Factory blue at hue 217 |
| Factory-style card gradients | Present and rendered |
| Pressing shadow and Container Loading stripes | Rendered from Factory hue |
| Blue theme inside body-level portal outside the workspace DOM | Verified |
| Changing `--factory-hue` to 260 | Palette, stripes and shadow update |
| Green, red and amber status colors during hue change | Unchanged |
| Responsive fixture document horizontal overflow | None at four tested widths |
| Touch action height | At least 44px |
| ERP and Properties shells | Factory-only hue absent and independently scoped |

Eight PNG screenshots and a machine-readable `report.json` are generated under `artifacts/factory-theme-phase4/`; a contact sheet of phone/desktop light/dark screenshots was also inspected. The screenshots are **controlled component-style fixtures**, not full application pages.

### Authenticated Factory page visual QA in disposable CI

Added `scripts/verify-factory-blue-theme-auth-browser.mjs` to the already-existing `.github/workflows/ui-quality.yml` **Mobile Responsiveness** job. It uses the established disposable PostgreSQL test fixture and temporary login supplied by CI. The script performs read-only navigation (apart from switching the active CI test company) and captures real application pages at three viewport widths in both modes.

| CI page group | Path |
| --- | --- |
| Location Inventory | `/factory/location-inventory` |
| Production | `/factory/production-report?tab=production` |
| Invoicing | `/factory/invoicing?tab=pending` |
| Container Hub | `/factory/containers-hub` |
| Financial Snapshot | `/factory/financial-snapshot` |
| Payroll / Insurance | `/factory/payroll-hub?section=insurance` |

That is **6 representative authenticated Factory routes × 3 viewports (390/768/1440) × 2 modes = 36 visual cases**. The script checks the Factory shell marker, shared hue, matching blue/violet aliases, and requested appearance while capturing viewport screenshots and a JSON report under `artifacts/ux-regression-browser/factory-theme-light-dark/`.

The UI Quality job already independently runs broad Factory mobile browser coverage at **320/360/390px, landscape phone, tablet and desktop**, including seeded detail routes and safe dialogs. Phase 4 leaves that existing browser coverage intact. Both Factory scripts now run in the same CI job; the screenshot artifacts are retained by its existing upload step.

### Post-merge regression protection

The `Browser E2E` main-branch workflow now runs the compiled CSS visual fixture after its production build and retains the screenshots as CI artifacts. It also triggers when the Factory theme browser script changes.

## Local verification performed before the pull request

- `npm run build` — passed.
- `node scripts/verify-factory-blue-theme-browser.mjs` — passed (8 of 8 render cases; two shell-isolation cases).
- `node scripts/verify-mobile-responsive-phase7-factory.mjs` — passed, 51 protected contracts.
- `node scripts/verify-mobile-responsive-wave2-factory-floor.mjs` — passed.
- `node node_modules/vitest/vitest.mjs run --config vitest.config.frontend.ts client/src/styles/factory-unified-theme.test.ts` — passed, 4/4.
- Puppeteer authenticated CI runner: syntax and formatting checked locally; its **real-page execution depends on the disposable CI login and test database**, so results must be read from GitHub's UI Quality check rather than asserted as locally verified.

## Completion boundary and next phase

Phase 4's implementation and reproducible browser checks cover the requested Factory palette, light/dark rendering and responsive contracts. Authenticated visual case results are enforced by the GitHub UI Quality job and provide per-run evidence. A passing compiled-css fixture alone must not be represented as proof that all 468 Factory TSX pages have been visually inspected. Remaining production deployment verification and final roll-up belong to **Phase 5**.

No inventory, finance, shipping, account, ERP or Properties business logic changed.
