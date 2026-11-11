# ERP Phase 1 — Financial integrity verification (2026-11-11)

**Scope:** ERP and ERP-related company types only. Read-only primary Render Postgres audit (workspace `tea-d42ik0c9c44c73878jsg`, database `dpg-d75mfh0ule4c73ctksfg-a`) and current repository source. No financial mutations, migration, deployment or production code changes.

## Current evidence
- Selected-company row security rejects broad voucher and ledger queries without `app.current_company_id`; individual company-scoped queries succeeded.
- Posted voucher counts in the scoped review: HADI 5,870; Beira 201; Kinshasa 1,198; Mali 505; GC 1,074; POS Jnah 166; DOHA 1; Zambia 4; TEST 0 = **9,019**.
- **50 adjustment header-to-item-total differences** (prior convention with 0.02 tolerance): HADI 45; Mali 2; GC 2; Kinshasa 1. Treat as comparison exceptions pending historical convention and cost-basis review, **not** 50 confirmed accounting losses.
- **19 one-sided stock-adjustment vouchers**: HADI 9; Kinshasa 6; Mali 3; Beira 1. Zero unbalanced *non-adjustment* vouchers in these checks. `PERPETUAL_INVENTORY_POSTING_READY = false` and the production `gl_inventory_cutovers` table has **zero** rows; periodic inventory has intentionally one-sided adjustment postings. Do **not** add balancing entries without an approved perpetual-inventory cutover.
- HADI contains **15 unresolved ledger-account references**, one voucher entry without any target, and historical mixed-purpose ledger links. References unresolvable within company RLS scope must be traced from originals, not simply reclassified or deleted.
- The existing stock-convergence reader compares original `stock-adjustment` evidence (adjustment ID) against current documents while edits use `stock_adjustment_edit_apply` and `stock_adjustment_edit_reverse` (voucher ID).

## Post-journal current-adjustment analysis (last edit-apply batch)
- HADI 36 nonzero documents, 12 edited; 1 without initial evidence; 3 document/movement quantity/value mismatches.
- Kinshasa 13 nonzero documents, 3 edited: zero mismatch in this read-only check.
- Mali 6 nonzero documents, 2 edited: zero mismatch.
- GC 1 nonzero document, 1 edited: zero mismatch.
- HADI exceptions (adjustment/voucher):
  - **244 / 12612**: document quantity 2, canonical quantity 4; value 246.09 vs 410.07.
  - **245 / 12614**: document quantity 21, value 1,894.16; no original canonical evidence.
  - **251 / 12886**: document quantity 34 vs canonical 35; value 4,461.04 vs 4,555.24.
  - **299 / 16521**: document quantity 9 vs canonical 8; value 996.77 vs 912.267424.
- The source comparison requires broader company/window certification and an independent inventory balance tie-out before any repair.

## Hard safety boundaries
1. No auto-insertion of movements for adjustment 245. First prove whether stock moved using contemporaneous inventory/audit records.
2. No automatic edits to historic stock-adjustment header amounts, historical exchange rates, unit costs, journal entries, deleted account links, or balances.
3. No blanket balancing journal for periodic inventory adjustments. An Owner-approved perpetual cutover needs dated openings, inventory control tie-outs, and tested effective-date posting.
4. Any approved financial correction must be separately previewed, verified in a test database, approved with original voucher/ledger evidence, posted as an auditable transaction, and re-reconciled.

## Acceptance criteria for Phase 1 financial sign-off
- [ ] Draft PR #3131 passes targeted and full CI, code review, and runtime-compatible stock convergence checks before merge.
- [ ] Each of HADI 244/245/251/299 is explained and independently validated against pre/post inventory, item lineage, original source document and journal.
- [ ] The 50 header discrepancies are classified by accounting convention vs actual document/stock faults, with signed-off disposition.
- [ ] The 15 unresolved HADI account references and one targetless line are traced and corrected only if supported.
- [ ] All ERP companies pass per-company voucher, ledger, stock and account-ownership reconciliation after any approved remediation.
- [ ] Periodic vs perpetual inventory accounting treatment and cutover readiness are explicitly accepted by the owner.
- [ ] Exact-commit backend/frontend certification, security role matrix and recovery evidence pass.

**Status:** Audit evidence captured. Phase 1 financial sign-off **blocked** pending historical provenance and runtime testing. This document itself makes no financial changes.
