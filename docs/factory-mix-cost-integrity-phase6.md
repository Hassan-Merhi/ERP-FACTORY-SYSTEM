# Factory Mix Cost Integrity — Phase 6: completion, used kilograms and carry-forward

Date: 2026-11-09 (Asia/Beirut)  
Branch: `fix/factory-mix-cost-integrity-20261109`, same branch as Phases 1–5.  
**Code:** Committed. **Live production inspection:** read-only. **CI execution:** Deferred by owner request.  
**New schema / TablePlus SQL:** None. **Historical records modified:** None.  
**Merge/Render deploy:** Not performed; requires Phase 8 integration/testing.

## Live audit, Factory company 12

| Measurement | Observed |
| --- | ---: |
| Total mixes | 229 |
| Active mixes | 222 |
| Deleted | 7 |
| Active completed | 222 |
| Completed with recorded remaining kg | 27 |
| Combined positive recorded remainder | **128,193 kg** |
| Indicative value at saved batch rates | **$89,611.05** |
| Completed over-used mixes | **3** |
| Total used kg above recorded weight | **179 kg** |
| Active carry-forward child batches | 0 |
| Factory daily-usage records | 0 |
| Open/active mix batches | 0 |

The calculated remainder's $89,611.05 **does not establish that the kilograms still physically exist** or are owed to WIP. It is only (recorded total kg - recorded used kg) × recorded historical mix USD/kg, summed over these completed batches. Phases 3–5 found no source-header arithmetic errors, yet almost all mix production lacks direct downstream bale lineage. No historical waste, carry-forward, inventory or COGS adjustment can be justified solely from these counters.

Overused:
- FMB-2026-0039: 5,754 kg used / 5,593 kg total = **+161 kg**.
- FMB-2026-0035: 7,084 kg used / 7,067 kg total = **+17 kg**.
- FMB-2026-0159: 16,884 kg used / 16,883 kg total = **+1 kg**.

Largest positive recorded remainders:
- FMB-2026-0130: 19,404 kg.
- FMB-2026-0145: 17,630 kg.
- FMB-2026-0137: 16,727 kg.
- FMB-2026-0143: 16,605 kg.
- FMB-2026-0147: 13,676 kg.
- FMB-2026-0140: 12,525 kg.

**Not done**: No rewriting 30 historical counters to make the KPIs appear balanced, no fabricated carry-forward batches for historical completed mixes, no fake stock receipts or write-offs, no new vouchers.

## 1. Read-only lifecycle and lineage report

- `server/services/factory/mixPhase6LifecycleAudit.ts`: tenant-scoped, `REPEATABLE READ READ ONLY` database snapshot covering every saved mix, including deleted rows.
- Compares saved status, weight and used kg, negative overdraw, completed/closed remainder, active zero stock, daily usages, carry-forward parent company/date/status, carry-source kg/USD and cost rate, plus child counts.
- Full per-batch history and issues are available in a formula-safe CSV. It never computes an automatic quantity correction.
- Existing authenticated endpoint, privileged to Admin/Owner/Developer:
  - `GET /api/factory/mix-batches?profile=lifecycle-audit`
  - `GET /api/factory/mix-batches?profile=lifecycle-audit&format=csv`
- Factory Mode Mix Batch list: **Audit Used KG** and **Lifecycle CSV**, alongside existing Phase 3–5 audit controls.

## 2. Future-state safeguards

`server/services/factory/mixLifecyclePhase6.ts` and the existing create/top-up/consume/finalize/delete routes implement:

- Reject invalid/fractionally rounded kg, non-positive source or consumption amounts, invalid business date, duplicate batch IDs, already deleted/completed/closed batches, and usage exceeding the exact remaining kg. Three decimal places are enforced.
- Consume multiple batches **atomically**, row-locking each batch and serializing carry-forward code assignment with mix creation. An invalid entry rolls back the full transaction, including earlier daily usage rows.
- New carry-forward child has its **parent ID, original recorded USD/kg, exactly conserved leftover kg and USD**, and an explicit `factory_mix_batch_sources` row with source type `BATCH`; the parent is closed only in the same transaction. No second raw-stock debit.
- Explicit transactional audit logs document used kg, business date, parent/child links and carry-forward USD.
- The legacy consumption route is refused if perpetual inventory was active on the usage date; it has no balancing output or journal posting for its WIP consumption.
- Top-up, opening-mix and upstream batch source selection cannot silently reopen consumed, closed, deleted or completed historical batches. New material sources require positive, exact three-decimal kg.
- Finalization re-reads the batch with a row lock. If recorded remainder is nonzero, the caller must provide `confirmRemainderAsWaste: true`, an **exact** `wasteKg` match, and a **10–1000-character** `wasteReason`. Waste finalization and its audit are committed in the same transaction as any applicable stock event. A zero-remainder close needs no waste confirmation.
- Ordinary soft deletion is refused for completed, used, carry-forward or downstream-linked mixes; otherwise, reverting sources could re-credit raw stock that has already reached production or customers. Such an operation requires a separate controlled historical reversal with verified evidence.
- For an eligible, unused open mix, deletion must prove each original source's **exact physical raw-stock row** or upstream batch and reverse its recorded kg under a row lock. A container with multiple possible raw rows, insufficient recorded used kg, supplier-only/manual sources or ambiguous attribution causes transaction rollback. The old blanket container update and clamp-to-zero behavior has been removed.
- Deleted Items restore for Factory mixes has a matching fail-closed rule. It only restores a uniquely attributable, unused open mix with available original raw stock/upstream batch kg; it refuses completed, consumed, carry-linked, supplier-only, ambiguous, or ADD-backed unverified sources and restores after perpetual GL cutover. It cannot add usage to multiple rows of one container.

For normal factory mix creation, the existing legacy behavior of making a completed mix at creation time is preserved; Phase 6 does **not** invent bale-level production or change the company's workflow from completed to open automatically.

## 3. Regression tests added

`tests/factory-mix-phase6-lifecycle.test.ts`:
- Positive exact 3dp kg, invalid negatives/overprecision and date validation.
- Duplicate and invalid usage requests fail rather than being silently skipped.
- Completed, overused, deleted, closed and overdrawn batches are refused for future consumption.
- Waste confirmation exact weight and explanatory reason.
- Soft-deletion refusal for downstream/consumed/carry-linked mixes.
- Historical remainder vs overuse classifications.
- Carry-forward parent/source kg and USD conservation.
- Deleted-history exclusion from active KPI counts, safe CSV output, read-only transactions and rollback.

Tests are **committed but not executed** until the owner requests CI/testing.

## 4. Remaining before historical repair

The original production sheets, inventory movements, daily consumption records and other dated documents must be reconciled to distinguish the old incomplete `usedKg` values from genuinely available mixed stock. The Phase 6 exception report supplies the 30 affected batch IDs and signed quantity differences. A real correction must remain reviewed, reversible and account for linked bales and GL periods (Phase 5).

Next Phase 7: proactive diagnostics and invariant monitoring. Phase 8: execute tests, resolve divergent `main`, verify deployment, and perform an approved release.
