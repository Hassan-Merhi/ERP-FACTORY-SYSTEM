# Zambia ZMW integration — independent verification and completion (2026-10-23)

**Status:** Phases 1–8 implementation-complete on `feature/zambia-zmw-multicurrency` and verified locally
(typecheck, lint, changed-file formatting, migration registry, documentation index, targeted backend suites on a
real PostgreSQL schema, full frontend suite). No hosted CI run, deployment, merge or production database change
was made. Release still requires the items listed under **Remaining before production** below.

## What the verification found and fixed

| Area | Defect found on the branch | Fix |
| --- | --- | --- |
| Compile | JSX syntax error in `PaymentDraftAndRateBar.tsx`; dead `never`-typed spread in the chatbot PO confirm route; `HistoricalOpeningResolver` draft currency widened to `string` | Corrected; `tsc --noEmit` is clean |
| Lint | `react-hooks/exhaustive-deps` warning in `ExchangeRateSettings.tsx` (ceiling is 0) | Dependency added; lint reports 0 errors / 0 warnings |
| Formatting | 69 branch files had never been run through Prettier (CI "Format changed source files" would fail) | Formatted; changed-file check passes |
| Excel PO import | A Kwacha invoice for a USD/ZMW company was only treated as ZMW when the sheet carried a `Currency` column; without it the Kwacha prices would have been posted as USD into inventory, goods in transit and the parent's supplier credit | `server/routes/import/poImportCurrency.ts`: a USD/ZMW company must state the invoice currency (`currency: "USD" \| "ZMW"`) on validate and import; it is stamped on every line and a contradicting sheet label is refused. `POImport.tsx` adds the required **Invoice Currency** selector and shows `K` in the preview. Mali and other companies keep the sheet-driven labels |
| AI PO import | The chatbot draft defaults the currency to USD from the sheet; the review card did not let the operator confirm it | `confirm-po-import` returns 409 `PO_IMPORT_CURRENCY_UNCONFIRMED` for a USD/ZMW company unless the request carries an explicit USD/ZMW currency and `currencyConfirmed: true`; `POImportDraftCard.tsx` adds the confirmation selector |
| AI PO import | Rate-date mismatch: a confirmation without `importDate` valued the Kwacha at today's rate but passed an undefined voucher date to the storage guard | One effective document date is used for the rate, the container, the PO and the vouchers |
| Mali compatibility | Journal/payment PATCH ignored the caller's currency for USD/CFA vouchers (changed branch behaviour) | Only a posted **ZMW** voucher locks its currency and rate; the USD/CFA contract is unchanged |
| Mali compatibility | `CurrencyContext.convertToUSD` stopped dividing by the pair rate when USD was selected, and the legacy `selectedCurrency` browser key was no longer written for CFA companies | Original contract restored for CFA; a Kwacha amount with no rate converts to `NaN`, never to USD |
| POS edit | A Kwacha sale edit did not re-verify supplied original Kwacha prices against the locked voucher rate | `updateSaleService` runs the same original-price check as sale creation when `originalCurrencyRate` is supplied |
| Account currency route | Importing the Zambia cash-conversion service at module load pulled the whole posting engine into a read-mostly route (its unit test mocks the module graph) | Service loaded on demand inside the handler |
| Migration registry | `20261023_001_zambia_historical_purchase_cost.sql` was not registered in `migrations/meta/_journal.json`, so the versioned runner would never apply it | Registered as idx 40 |
| Documentation index | The nine phase documents were unclassified (CI documentation audit fails) | Classified as references and linked from `docs/README.md` |
| Legacy test | `tests/currency-amounts-behavior.test.ts` asserted that an unknown daybook currency bridges to a silent rate of `1` | Updated to expect the rejection (Phase 2 safety decision); ZMW bridges to `0.0400000000` at 25 per USD |

## Accounting verification (local PostgreSQL schema, `tests/zambia-phase8-purchase-lifecycle.database.test.ts`)

Illustrative approved rates: 25 ZMW per USD effective 2026-10-20 and 28 effective 2026-10-22 (not production rates).

- A native Kwacha PO (K125 × 2, K1 × 1, K50 freight) stores `native_*` columns of K251.00 / K50.00 and historical USD
  `items_total` 10.04 / `freight` 2.00 at the locked rate; each line keeps `native_rate` and `native_line_total`.
- The subsidiary purchase voucher and the parent `INTERCO-PARENT-…` voucher both post 12.04 USD, balanced, with the
  parent crediting the supplier 12.04 USD. No Kwacha amount reaches either ledger.
- A Kwacha PO whose rate is 26 or 28 (not the approved rate of its date) and a bare `currency = ZMW` label without
  native evidence are refused with HTTP 409 before any purchase, voucher or stock row is written.
- Editing the PO (K150 × 2) re-prices at the **locked** 25 (12.00 USD), not the later 28; changing the currency or
  the rate is refused; editing after offload is refused.
- Offloading the container values the stock at the USD landed value (14.00 USD for 2 bales), never K300.
- The Excel import route refuses an unstated currency, a missing or mismatched rate and a USD-labelled sheet
  imported as Kwacha; a stated ZMW import converts K1000 + K100 freight once to 40.00 + 4.00 USD, posts 44.00 USD in
  the subsidiary and the parent, and a replay of the same file is refused.
- A plain USD purchase posts exactly as before with all native columns `NULL`.

Unit coverage: `tests/zambia-phase8-purchase-costing.test.ts` (costing and explicit import currency),
`tests/zambia-phase8-intercompany-boundary.test.ts` (ZMW intercompany legs, stable retry identities, legacy USD shape),
`tests/currency-amounts-behavior.test.ts` and `tests/currencyAmounts.test.ts` (engine), `tests/ui/currency-context-behavior.test.tsx`
(Mali CFA display contract).

## Verification runs

| Check | Result |
| --- | --- |
| `npm run check` (tsc) | pass |
| `npm run lint` | pass, 0 warnings against ceiling 0 |
| `node scripts/check-changed-file-formatting.mjs` | pass |
| `node scripts/verify-migration-registry.mjs` | pass (41 registered) |
| `node scripts/audit-doc-index.mjs` | pass |
| Application startup migrations against a fresh local database | `/api/health/db` reports 0 failures |
| Targeted backend suites (imports, purchasing, offload, rates, transfers, chatbot, opening balances, route guards) | pass after the fixes above |
| Full frontend suite | 2246 passed; 6 failures in `tests/ui/barcode-lookup-page-behavior.test.tsx` are unrelated to this work (the branch carries main's pre-fix copy; `origin/main` already contains the fix) |
| `npm run build` (Vite client, server bundle, bundle and runtime-dependency verification) | pass |

## Merge of `main` (2026-10-23, later the same day)

`origin/main` (through `21be382`) was merged into the branch (`128dbed`). Conflicts and follow-ups:

- `currencyAmounts.ts`: main added AUD to its known-currency set, which this branch replaced with the shared
  catalog; AUD is registered in `shared/currencyCatalog.ts`.
- main's FX settings change (#2440) left an unterminated arrow in `FxRatesCard.tsx`, breaking typecheck, lint and
  build of any branch that merges it; closed on this branch.
- Rate saves: a company **with** a configured display currency may only save that pair; a company **without** one keeps
  the original contract (any pair against its accounting base), which three pre-existing suites assert.
- Dated factory rate lookup returns 404 (not 500) when no stored rate or external quote exists, as main's new test asserts.
- Ratchets: route manifest and report characterization re-pinned for the Zambia route and native PO columns; god-file
  caps met by extracting `poImportZambia.ts`, `purchaseOrderZmwEdit.ts` and `usePosZmwSaleRate.ts`; main's Node
  24.22.1 bump completed in `render.yaml`, README, workflow names, the coherence test and the deployment docs.

Full-suite results on the merged tree (`7fbc03d`):

| Check | Result |
| --- | --- |
| `npm run check` | pass |
| `npm run lint` | pass, 0 warnings |
| `npm run build` | pass |
| Changed-file Prettier, migration registry, doc-index, toolchain audits | pass |
| Startup migrations on a fresh local database | 0 failures |
| Full backend suite (`vitest run`) | 1091 files, 7509 passed, 12 skipped, 0 failed |
| Full frontend suite | 244 files, 2265 passed, 0 failed |

## Production schema path (2026-10-23)

A read-only look at the production database showed no `__drizzle_migrations` table: production has never been
migrated by the versioned runner, and the application's startup statements (`server/startup-schema`) are the live
schema path (`replit.md`: "direct SQL in `server/index.ts` is the active migration method"). Stage 036
(`036-zambia-historical-purchase-cost.ts`) therefore mirrors `20261023_001_zambia_historical_purchase_cost.sql`
statement for statement: twelve `ADD COLUMN IF NOT EXISTS` and one guarded `NOT VALID` constraint. It was run twice
against a local database to prove idempotency, and the startup-schema pin test records the appended stage. The SQL file
stays registered for environments that use the runner.

Production state observed read-only before release: Zambia (company 19) is `erp`, USD base, no display currency,
parent HADI L'SHI (1), no USD/ZMW rates, 4 purchase orders, 4 vouchers, 6 ledger accounts; Mali (9) is USD/CFA.

**Release observation (2026-10-23, after PR #2446 merged and deployed):** production boots with the bulk startup pass
disabled (`RUN_STARTUP_MIGRATIONS=false`, the kill-switch kept since the #2443 deploy deadlock), so stage 036 was skipped
and the columns did not appear. Only the always-on guards in `server/index.ts` reach production, so
`server/startup/ensureZambiaHistoricalPurchaseCost.ts` now applies the same thirteen stage-036 statements before HTTP
starts (idempotent; deferred on an empty database until the purchase tables exist), proven on a pre-change table shape by
`tests/zambia-runtime-schema.test.ts`.

## Remaining before production

1. Run hosted CI on the merged branch (every check above was run locally, not on GitHub Actions).
2. Deploy: the Zambia columns are created by startup stage 036 at boot (additive, `NOT VALID`); the versioned SQL
   file remains for runner-based environments.
3. Activation is configuration, not code: set Zambia (company 19) display currency to ZMW, keep USD base, set the
   Africa/Lusaka timezone, and record the business's own approved daily USD/ZMW rate before any Kwacha transaction.
4. Permissioned before/after reconciliation of Zambia and Mali balances on production data (blocked by tenant
   isolation in this environment, as recorded in Phase 1).
5. Phases 9–11 (Factory, reporting, final integration) remain outside this verification.
