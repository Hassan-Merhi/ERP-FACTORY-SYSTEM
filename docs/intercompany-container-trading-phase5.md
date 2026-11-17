# Intercompany Container Trading — Phase 5 destination receiving and cancellation

**Branch-only implementation:** `feature/intercompany-container-trading`. This reference describes the implemented feature-branch behavior and **does not certify a release**. The draft PR must remain unmerged. No production migration, route activation, physical stock receipt, journal posting or historical repair has been authorized.

## Canonical identity and ownership

A container originally imported by Hassan Properties is one physical `containers` row owned by Properties, even when its destination ERP purchase order belongs to HADI, MALI or another verified company. There is **never** a duplicate destination physical container. While it is travelling, the destination company has Goods in Transit (GIT) and a supplier balance payable to Properties. Source external supplier invoices and physical tracking remain in Properties.

The normal `/api/containers/:id/offload` path is **not** a linked intercompany receiving service: its owning-company and source PO assumptions do not match this arrangement. The Phase 2 legacy-offload guards remain active. Phase 5 uses its own verified `intercompany_destination_receipts` row and append-only stock evidence.

## Receiving into the actual destination ERP

Use the **Receiving & Cancellation** screen while signed in to the destination ERP. The signed-in Owner/Admin/Developer chooses a valid active destination location and an existing active destination `INVENTORY` asset ledger account, then confirms actual arrival, complete approved cost, document evidence, date and reason. The server rechecks both companies' verified PO linkage and cost version under the same per-source advisory transaction lock used by import, synchronized PO edits, payment and shared-invoice reallocation.

The operation posts **one destination Journal**: debit inventory for the exact confirmed landed cost, credit that destination's mapped GIT account by the same amount. It receives each destination-company stock item into that location at an exact allocated landed cost and writes an independent canonical receipt movement and immutable item evidence. This is **not** a new purchase, new supplier payable, bank transfer or cash entry.

Every item must belong to the destination company. The deterministic cent-allocation includes confirmed charges/discounts while preserving the total exactly. Existing negative stock, unexplained residual valuation, missing line correspondence, nonexistent stock, wrong account, unverified amounts or legacy offload make the whole database transaction fail. No source-company physical stock is created or booked; the original container is retained. A request key and evidence fingerprint prevent duplicate posting. After receipt, further ordinary PO prices/shared-charge edits and trade cancellation are blocked, because downstream inventory/COGS revaluation needs a separately audited correction path.

## Cancel before destination goods are received

This is **not physical stock deletion**. The Owner/Developer reviews documentation that the destination goods were never received and acknowledges that cash/bank transfers are **not** automatically reversed or refunded. The cancel operation has one trade-version check and one source-company advisory lock. If the destination has an actual Phase 5 receipt, a legacy offload, closed or mismatched PO status, or any unreconciled shared invoice allocation, cancellation is rejected.

For an unreceived verified trade, three separate **append-only** central-engine journals post together:

| Company | Debit | Credit | Reason |
| --- | --- | --- | --- |
| Properties | Internal Sales | Internal Receivable | Reverse at-cost internal sale |
| Properties | Original Purchases | Internal COGS | Reverse cost reclassification but **preserve** external supplier purchase/payable |
| Destination ERP | Properties supplier payable | Destination GIT | Reverse the linked purchase in transit |

All three have the original confirmed landed value, and the Phase 5 SQL trigger checks both exact voucher entries and all company/partner mappings; posting only one side cannot commit. The original PO, source external supplier invoice, payment vouchers and historical currency evidence are never deleted. Every still-applied PO payment allocation gets an append-only negative `cancel_release` entry returning unused value to **its own original real payment and company pair**. It cannot be spent by another ERP destination, and the cancellation makes no fictional cash entry. The canceled trade carries immutable evidence and cannot be revived through legacy editors.

### Confirmed shared-charge invoice handling

The external invoice face total is never changed by canceling a container. If the trade has a nonzero shared charge, cancellation refuses until an authorized **Shared Charge Editor** has explicitly redistributed that share to other active containers with the existing Phase 3 invoice revision, preserving its full invoice amount. The cancel request must say `redistributed`, and the server checks that associated confirmed invoices were revised and the departing container's shares are zero. If there was never a shared invoice, the disposition must be `none`. An Owner/Developer's ordinary company role is not a substitute for a Shared Charge Editor grant.

## Schema and code

- `migrations/20261105_005_intercompany_phase5_lifecycle.sql`: additive receipt, receipt-line and cancellation evidence, payment allocation kind extension, exact GL/stock ownership checks, and immutable post-cancellation voucher/PO protection.
- `shared/schema/intercompanyTrading.ts`: matching Drizzle models.
- `server/services/intercompany/phase5Receipt.ts` and `phase5Cancel.ts`: atomic posting services with idempotency.
- `server/routes/import/intercompany-phase5.ts`: signed-in company scoped read/receive/cancel endpoints.
- `client/src/pages/intercompany/IntercompanyLifecycle.tsx`: destination receipt and cancellation review UI in Properties and ERP navigation.
- `tests/intercompany-phase5-lifecycle-math.test.ts` and `tests/intercompany-phase5-database-guards.test.ts`: exact values/replay and fresh isolated PostgreSQL migration/ownership regression.

## Phase 5 certification and isolated rollout checklist

**Release state: NOT CERTIFIED until all the following evidence exists.** Do not treat a passed TypeScript-only test as a successful database test; the DB scenario returns early when `DATABASE_URL` is unset.

1. Record exact branch SHA. Run migration verification and startup compatibility, typecheck, changed-file Prettier, lint, backend/frontend tests, account-scope/write-route/security audits, build and static mobile/i18n checks. Do not waive failures.
2. Use **disposable PostgreSQL** with `DATABASE_URL` set: run `node node_modules/vitest/vitest.mjs run tests/intercompany-phase5-lifecycle-math.test.ts tests/intercompany-phase5-database-guards.test.ts`, plus Phases 1–4 DB tests. Verify the five migrations apply in order, with the runtime-only canonical movement journal schema installed as required.
3. Staging receipt: confirm one real source container, one destination location and ERP inventory movement, Dr Inventory/Cr GIT equality, per-item quantity/value equality and no changes in Properties inventory, external suppliers or real cash.
4. Staging cancellation: test unreceived zero payment, partial payment, multiple credited payments, simultaneous retries, wrong pair, invalid currency/history, supplier mapping, shared invoice redistribution, stale version and closed accounting date. Verify all three exact journal pairs, initial external supplier POs and bank/cash untouched, and every payment released to its original pair.
5. Reject duplicate receipt, incorrect journal, forged stock movement, incorrect destination location/account, cost misallocation, edited receipt proof, unauthorized actor, post-receipt price edits and post-receipt cancellation.
6. Capture baseline and posttest snapshots for each company's supplier subledger, cash/bank accounts, A/R, Sales, Purchases, COGS, GIT, Inventory, canonical stock, audit and voucher identities. Have an independent accountant sign off before any feature activation.
7. Keep the PR draft and `main` unmodified until the owner explicitly authorizes merge/deploy. Back up databases before future production migration. If staging fails, stop access and repair through reviewed compensating vouchers or migrations, **never** delete historical source, cash or received stock journals.

**Outside Phase 5:** deliberate corrections after the destination has sold/transferred/consumed receipt stock, non-USD source Excel imports, account consolidation, historical repair and cross-company supplier payment reconciliation. These require later phase review and must not be simulated by modifying original vouchers or silently enabling permissions.
