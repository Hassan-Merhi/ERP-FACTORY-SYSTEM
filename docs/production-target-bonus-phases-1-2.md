# Production Targets bonuses — Phases 1 + 2 contract

Branch: `feature/production-bonus-core`
Status: implementation on a feature branch, not merged or deployed.

## Purpose and boundary

This is **Production Targets** per-worker, per-day **extra bale** compensation. It is
**not** the existing production-position planner bonus that flows into
`factory_production_bonus_allocations` and payroll; it is not the existing
manual `worker_bonuses` flow. No approval, payable, voucher, cash movement,
Daybook posting or other financial movement is permitted in Phases 1–2.

**Never approve and pay the same worker/date/production source through both
the position-planner payroll incentive and this proposed incentive.** The
approval/accounting workstreams must implement a company/worker/date/source
claim or equivalent unique constraint, plus a reconciliation check against
existing payroll allocations and manual worker bonuses, before they can enable
any posting.

## Effective-dated rate settings (Phase 2)

Schema ensured from the unconditional
`ensureFactoryStaffTrackingSchema` startup path:
`factory_production_target_bonus_rates`.
Columns: `company_id, scope ('company'|'worker'), worker_id (nullable),
effective_from, enabled, rate_per_extra_bale DECIMAL(20,4), note,
request_key, created_by, created_at`.

- USD currency; up to 4 decimal places per **extra bale**, from 0 to 10000.
- No settings means the bonus is **disabled**, even if workers exceed targets.
- Worker-specific version overrides company-wide version; within each scope
  the latest version effective on/before the production day applies (then
  latest ID if two versions share a date).
- A worker override can explicitly disable that worker; no worker override
  means the worker inherits the company-wide rate.
- Changes **append** history instead of mutating previous version rows.
  Changing a rate with an earlier effective date can change an unapproved
  preview; the approval workstream MUST store and lock an immutable
  calculation/rate snapshot and must not recalculate already-approved items.
- Only privileged Factory Admin/Owner/Developer users or authorized
  active supervisor overrides may read or change bonus settings. Factory
  page/tab permissions are enforced by the backend access boundary.
- A unique per-company request key prevents replay of a save from inserting
  the same version twice; reusing one key for a different change is a 409.

### Settings API

`GET /api/factory/production-target-bonuses/settings?asOf=2026-10-29`

Returns:
`{ currency:"USD", asOf, companyRate, workerRates:[{workerId,effective}],
history:[rateVersion], historyTruncated:boolean, payoutsEnabled:false }`

`POST /api/factory/production-target-bonuses/settings`

Example request:
`
{
  "scope": "worker",
  "workerId": 72,
  "effectiveFrom": "2026-11-01",
  "enabled": true,
  "ratePerExtraBale": "0.5000",
  "note": "November rate for worker",
  "requestKey": "worker72-november-2026-v1"
}
`

Use `scope:"company"` and omit workerId for the general default.
Response: `{ status:201|200, versionId:number, replayed:boolean, currency:"USD" }`
(with status as HTTP response code).

## Calculation API (Phase 1)

`GET /api/factory/production-target-bonuses/preview?startDate=2026-10-26&endDate=2026-10-29`

- Range inclusive, 1 to 84 days, never in the future in Asia/Beirut.
- Source is the company's **saved, finalized daily Production Targets snapshot**
  created by End Production; unfinalized days return **0 eligible bonuses**
  and an explicit `NOT_FINALIZED` warning.
- The daily source retains historical linked workers, attendance, targets,
  and the linked team's shared produced count. Group production is **counted
  once** and split as whole credited bales across eligible workers.
- Two linked workers with 20 produced and per-worker target 7 receive
  10 credited bales each → 3 extra each. At $0.50, each is proposed $1.50.
- If an odd number of bales cannot be split evenly, the remainder goes to
  the smallest worker ID; both receive a `ODD_LINKED_BALES` review flag.
- An absent member is excluded from the linked split if another member is
  present. Ambiguous links / missing linked members / inconsistent group
  produced counts BLOCK the day from payout review; never guess.
- Zero/null/invalid target or a disabled/zero rate gives $0 bonus.
- **Per-day**, not weekly netting: one poor day never offsets a previous day
  that exceeded the target.
- All **money** uses Decimal math and rounds to 2 cents only at the worker
  bonus line; units of bales and target are whole numbers.
- Returns `{ currency:"USD", startDate, endDate, calculationVersion,
source, proposalOnly:true, canApprove:false, canPost:false,
totalProposedBonusUsd:"0.00", finalizedDays, blockedDays,
days:[{date,finalized,payoutReady,totalProducedBales,extraBales,
proposedBonusUsd,workers:[{workerId,workerName,employeeCode,category,status,
linkGroupId,partnerIds,targetBales,creditedBales,extraBales,
ratePerExtraBale,rateVersionId,rateScope,bonusUsd,
eligibleForReview,requiresReview,issues}],warnings}],
workers:[{workerId,workerName,employeeCode,targetBales,creditedBales,
extraBales,proposedBonusUsd,eligibleDays,reviewDays}]}`.

Both endpoints are protected by Factory page
`factory/stock-entry` and tab
`hide_tab_stockentry_production_targets` and by privileged-role checks.

## Next chats: integration responsibilities

**Phases 3 + 4 (UI/review):** consume the two endpoints above. Implement
a settings control for company/worker rates and calendar selection.
Use `rateVersionId` and the full per-day worker snapshot when approving.
Reject/hold ambiguous days. Persist review decisions with actor, timestamp,
reason, source fingerprint and exact source snapshot. Review and approve
**must not directly create cash movement**.

**Phases 5 + 6 (accounting/duplicate protection):** do not post from this
calculator endpoint. Build a single transactional idempotent posting path,
after approval, with explicit payable-vs-immediate-payment mode,
currency/FX, active company cash/bank account, expense classification,
cash sufficiency checks, Daybook/voucher traceability, and reversal flow.
Before payment, reconcile against existing production-position payroll
allocations, worker bonuses and any other worker/date claims, with a
database-level uniqueness guard.

**Phase 7 (reports):** consume immutable approved/paid bonus records from
Phases 3–6, not mutable preview values as if paid. Display credits, target,
extra bales, rate, amount, approver, payment account, voucher and status.

Integration order: merge all workstreams on one integration branch, run
unit/integration/permission and accounting tests, confirm no duplicated
expense/cash effect, then merge to main and deploy. No autonomous CI/deploy
action is part of these core phases.
