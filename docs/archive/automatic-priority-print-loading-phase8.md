# Automatic Priority Printing & Loading — Phase 8 Claude handoff and rollout plan

**Status (2026-10-09):** Implementation phases 1–7 and final source-level integration review are on one feature branch: `feat/automatic-priority-print-loading`, targeting `main`. This document is the final implementation handoff, **not a test certification**.

## What was and was not performed

- Code was committed through the GitHub connector.
- The final review was **source inspection only**. It did not compile, lint, format, execute any test, migrate a database, print a label, run CI, or exercise the app.
- The company mode must remain **OFF** by default and must not be enabled in production before review.
- The branch is **two commits behind `main`** as observed before the PR was opened. Claude must fetch the latest `main`, inspect the intervening changes, resolve conflicts safely, and certify the **actual final head SHA**.
- No workflow runs were explicitly requested. The final Phase 8 handoff commit includes GitHub's `[skip ci]` instruction to avoid automatically launching `pull_request` workflows before Claude begins verification. **GitHub required checks may remain pending; other providers or triggers may behave differently.** Claude must make a later non-skip commit / deliberately trigger checks before approval.
- Do not merge this draft PR until Claude completes the checks and reviews the accounting/production-printing implications.

## Final integration scope

| Phase | Implementation surface |
| --- | --- |
| 1. Settings | Authorized, company-wide OFF-by-default flag; changing OFF does not undo previous bales |
| 2. History | Original loading, priority, color, operator, article, timestamps; reversible scan/physical deletion audit |
| 3. Labels | A4, A5, sticker HMD wordmark whose small `HMD` letters use the **saved** priority color; large logos unchanged |
| 4. Stock Entry | In-stock bale receipt + automatic prioritized loading, proforma capacity/price checks, scan, totals, queue advancement and daybook in transaction |
| 5. Printing | Factory/Stock Entry reprints, Bale History, Location Inventory, Wipers, Relabeling, Pressing and Production print paths; repeat/reprint does not duplicate assignment |
| 6. Deletion | Shared physical deletion service: loading/history reversal, one ERP stock debit, canonical journal, daybook and durable audit |
| 7. Recovery | Auto-completed editable loading returns to #1 when demand reopens, advances again on completion; no movement of already allocated bales |
| 8. Handoff | Final source review, modest fixes to stock-removal quantities, Wipers cleanup reporting and reversal-user audit, rollout and rollback instructions, one draft PR |

### Critical business acceptance scenarios

1. **OFF workflow:** Company never enabled: regular stock, manual scanning and all ordinary labels must behave as before. Turning OFF later must leave prior links/colors/history untouched.
2. **Automatic batch:** Red loading #1 requires two Jogger bales, Blue #2 requires two. New batch of five: Red, Red, Blue, Blue and one ordinary unallocated bale. Both order totals correct and physical inventory received **five, not one or nine**.
3. **Capacity:** Two loadings sharing the same proforma have independent per-loading article demand; the same article cannot exceed a loading's needed quantity.
4. **Reprint:** Reprint Red after Red finishes and the active queue changes; the small HMD lettering must stay its original Red. Reprint while OFF must preserve Red. No new order link or scan history.
5. **Manual scan:** Already manually Priority Scanned bale retains its original assignment/color on reprint. Nonpriority ordinary bale never receives a guessed color.
6. **Physical deletion:** Deleting a loaded Red bale removes its active loading link, updates totals, debits the ERP location exactly once, writes canonical movement/daybook evidence, and keeps original history marked reversed. Second deletion must not debit twice.
7. **Reopen:** When deletion reduces auto-completed Red from 2/2 to 1/2 and Red still LOADING, return Red to priority #1 and shift Blue down. Blue's already loaded bales and original labels remain untouched.
8. **Manual OFF/finalized:** Do not reopen manually disabled, verified, finalized, cancelled, deleted or sold/dispatched loading situations without controlled accounting reversal.
9. **Color reuse:** If Red's live color was reassigned during its completion, reactivating Red chooses a distinct available current color, preserving historic Red label snapshots.
10. **Multi-bale deletion:** A batch with an invalid/deleted/foreign/finalized bale must not partly succeed. Two reopened loadings must be ordered deterministically.
11. **Print uncertainty:** Server allocation can commit before browser/user physically prints. A popup/printer failure must display a retryable print problem, **never undo committed stock or automatically reassign the bale**.
12. **Security:** No cross-company bale, product, location, order, history or operational settings leakage. Role restrictions and supervisor-verified deletion must remain enforced.
13. **Print hardware:** Scan real reference barcodes, compare actual color-printer A4/A5/sticker output with user's provided label image; monochrome Zebra cannot represent the colored HMD priority mark.

## Claude verification procedure (NOT executed by the implementing assistant)

1. Fetch latest `main`, inspect the two intervening commits, and reconcile the branch **before** running certification. Do not modify business logic without reviewing the resulting changes.
2. Create/use disposable PostgreSQL 16 test database and follow `docs/testing.md`. Never run `drizzle-kit push` against live production data.
3. Run `npm run verify:migrations`, `npm run verify:startup-migrations`, `npm run check`, `npm run lint`, `npm run format:check:changed -- --base origin/main`, and `npm run build`.
4. Execute the new Phase 1–7 suites:
   - `tests/automatic-priority-mode-phase1.test.ts`
   - `tests/automatic-priority-allocation-history-phase2.test.ts`
   - `client/src/lib/labelHtml.test.ts`
   - `tests/automatic-priority-stock-entry-phase4.test.ts`
   - `client/src/lib/priorityPrintPreflight.test.ts`
   - `tests/automatic-priority-print-batch-phase5.test.ts`
   - `tests/automatic-priority-physical-deletion-phase6.test.ts`
   - `tests/automatic-priority-loading-progress-phase7.test.ts`
   - `tests/automatic-priority-queue-recovery-phase7.test.ts`
   - `tests/automatic-priority-print-loading.test.ts`.
5. Fix all compile problems and flawed test fixtures as discovered. **The tests were authored without being run and may require correction.** Do not assume their assertions or setup are correct.
6. Run existing manual Priority Scan, proforma capacity, canonical stock journal, factory stock removal, Bale History/reprint, company-scope, route-guard and restored-item suites. Run `npm run test:backend`, `npm run test:frontend`, and other required repository test tiers.
7. Run the complete GitHub Actions and CircleCI PR checks at a **non-skipped latest head commit** (or deliberate supported manual trigger). Check security, CodeQL, Semgrep, migration/DDL contract, UI/mobile, lint/typecheck, build and coverage ratchets. Verify merge-readiness against current main.
8. Do a real-operator staging walkthrough: print A4/A5/sticker in color, scan, switch ON/OFF, create stock concurrently, reprint, delete, verify journal and reopen queues. Require supervisor signoff on deletion/accounting.
9. Only after all validation passes, request approval and merge. The main-branch certification must then validate the exact merged SHA as documented in `docs/testing.md`.

## Release and rollback

**Pre-release:** backup production database; verify migrations/schema are present; preserve all history; take inventory/order/journal baseline snapshots; ensure the switch is OFF for every company; deploy changes without automatic activation.

**Controlled enablement:** authorize one factory company, use a limited nonfinancial staging/dummy loading or agreed controlled production pilot. Confirm approved color printer and label stock. Monitor original/reference ID uniqueness, duplicate snapshots, proforma remaining counts, order totals, stock receipt/removal movements, daily scan history, print failures and queue recovery. Extend only after explicit operator approval.

**Emergency disable:** Admin/Owner turns Automatic Priority Printing OFF in Factory Settings. This prevents **future automatic allocations only**. **It must not undo existing allocations or delete audit history.** Keep original labels and order links. Follow controlled order reversal and inventory journals for any actual corrective work; do not run mass rollback SQL against live records.

**Code rollback:** first disable the feature company-wide, then rollback application code only with a schema/data compatibility review. Newly recorded assignment, scan and physical deletion audits must be preserved. Avoid reverting additive schema tables if they contain business records.

**Residual risks:** production printing is device-dependent; hardcoded operational assumptions are subject to Claude review; verifying invoice/finalized deletion and transactional inventory-journal idempotence is mandatory. The current draft is **NOT CERTIFIED** until all checks and real-workflow tests complete.

## Handoff links

- Phases 1–7 individually documented in `docs/automatic-priority-print-loading-phase{1..7}.md`.
- Relevant project test instructions: `docs/testing.md`.
- GitHub workflows: `.github/workflows/ci.yml`, `ui-quality.yml`, `security.yml`, `codeql.yml`, etc.
- Branch: `feat/automatic-priority-print-loading`. Exactly one draft PR should collect all changes.

**Do not remove `[skip ci]` during this handoff until Claude is ready to certify.**
