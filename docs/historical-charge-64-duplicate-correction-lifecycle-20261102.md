# Company 12 charge #64 duplicate posting: correction lifecycle and replay safety (2026-11-02)

## Evidence

Production **SELECT-only** inspection found exactly **145 unique active POC source charge families represented by 146 active POC vouchers**. A source family is the exact `containerId + chargeId` parsed from the voucher number. **Only one family has multiple active vouchers: container 83, charge 64.** Both post exactly the same accounts on June 17, 2026:

| Record | Voucher ID | Charge amount in USD | Debit | Credit | Current status |
|---|---:|---:|---|---|---|
| Original `FACTORY-POC-83-64-1781674089261` | 9309 | 1,692.96 | FACTORY_CHARGES_PAYABLE | WALMDACLE | active |
| Backfill `FACTORY-POC-BACKFILL-83-64` | 9341 | 1,692.00 | FACTORY_CHARGES_PAYABLE | WALMDACLE | active |
| Historical correction `FACTORY-CORRECTION-20261014-83` | 15976 | 1,692.96 | WALMDACLE | FACTORY_CHARGES_PAYABLE | **soft-deleted October 19, 2026** |

Both active vouchers are balanced, nonoptional, same business date, same currency (USD), and both have exactly two ledger lines. They represent **one** source charge ID. The current `factory_offload_additional_charges` record #64 is USD **1,692.00**, links to voucher **9341** and was updated July 18, 2026. The matching June 17 `factory_daybook_entries` record #**14136** shows `chargeId=64`, `amount_currency=1692`, and `amount_usd=1692`. There is **only one** such daybook event for container 83 on that date.

The earlier `scripts/reconcile-factory-freight-20261014.ts` explicitly identified the source voucher #9309 as the extra and created a compensating journal #15976 on October 14. That journal was subsequently soft-deleted on October 19, and the read-only investigation found **no active replacement voucher with the same correction identity**. Its entry lines remain in the database for audit, but its soft-deletion excludes it from the live posted ledgers. Prior script's other corrections for freight containers **89** and **122** remain active; re-running the full script could introduce new errors or revive a previously retired reversal.

**Accounting implication:** the live GL contains the duplicate original $1,692.96 clearing debit and the matching $1,692.96 credit to the named **WALMDACLE — WALID MDAWAR CLEARANCE** liability. This anomaly is **separate from** the 38 historical goods and 48 commission vouchers totaling $389,442.28. Reversing #9309 in isolation would mean Dr WALMDACLE / Cr FACTORY_CHARGES_PAYABLE $1,692.96 (a supplier-party-neutral *GL* journal), but would **change this specific creditor/payable ledger balance**. It should not be represented as a zero-change correction to all supplier-related liabilities, and its business treatment needs accounting authorization. Because the prior offset was deleted, this proposal is NOT automatically reposted or revived.

## Safety actions implemented (no financial writes)

1. The one-time historical `scripts/reconcile-factory-freight-20261014.ts --apply` now fails **before starting any transaction**. Dry-run verification is preserved. Any future correction must be separately reviewed, posted using a new source-specific identity and backed by creditor-balance reconciliation, never a replay of the 2026-10-14 batch.
2. The company-12 `POST /api/admin/backfill-postoffload-vouchers` returns a conflict with `HISTORICAL_POC_BACKFILL_REPLAY_DISABLED`, preventing another broad legacy POC backfill for that already-reconciled company. This is a legacy administrative operation; ordinary container receipt, offload, sales, and stock accounting flows are untouched.
3. For other companies, this same legacy admin route now scopes candidate charges to the selected tenant, rejects cross-company counterpart ledger IDs, excludes deleted source charges and checks **exact source `containerId + chargeId` voucher identities rather than descriptions**. It refuses to recreate a source that has an existing or deliberately retired original voucher.
4. The private historical supplier audit now lists every duplicate active POC source family with voucher identities/amounts and prior correction status. All proposed reclassification/reversal amounts remain null. It flags the soft-deleted correction explicitly instead of treating an earlier posting as if it were still active.

## Invariants and release gate

No existing voucher is removed/restored/replaced; no source charge, supplier balance, raw stock, customer, bank, journal, or account type is modified. The audit contains no application mechanism. Existing production values stay intact.

The source data supports a **strong $1,692.96 duplicate-posting candidate**, not a user-approved reclassification or a blanket profit correction. Before real posting, validate WALMDACLE creditor statements and any subsequent settlements, the reason/source of the October 19 deletion, fiscal period lock/review, and source-specific idempotent journal approval. Distinguish the company-12 creditor account from a factory supplier party. The historic $389,442.28 goods/commission direct expenses remain separately unresolved and must not be combined into this duplicate amount.

**Validation:** source-link and duplicate SQL tested with Render production SELECT-only access. Pure unit tests added, but full CI and end-to-end CLI execution have not been confirmed passing.
