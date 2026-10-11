---
name: Per-worker payroll accounting groups
description: How salary/bonus ledger accounts are structured for factory workers — per-worker accounts under group headers, not city-based flat lists.
---

## Rule
Payroll expense accounts use a two-tier structure:
- **Group header**: "Salary Expense - Workers" (subType: "Group", accountType: "Expense") — no direct journal entries
- **Worker accounts**: "Salary Expense - Ahmad Hassan" (parentId = group.id, accountType: "Expense") — one per worker

Same pattern for bonuses: "Bonus Expense - Workers" → "Bonus Expense - [Name]".

**Why:** City-based grouping ("Salary Expense - Beirut") made it impossible to trace per-worker salary expense; individual accounts with a collapsible group header give both granularity and a clean chart-of-accounts view.

**How to apply:**
- `findOrCreateLedger` in both `payrollCoreRoutes.ts` (local) and `_payrollAccountingHelper.ts` (shared) accepts `opts?: { parentId?, subType? }`.
- Generation pre-resolution: always create group headers first, then pass `parentId` when creating worker accounts.
- The migration endpoints (`migrate-worker-names`, `migrate-salary-groups`, `migrate-city-split`, `runs/migrate-group-expenses`) are retired (wave 18 B, phase 19 A): they rewrote posted lines with no audit.
- The UI (AccountTable.tsx) already supports parent/child hierarchy via `parentId` + `subType === "Group"`; no frontend changes needed.
- `findOrCreateLedger` truncation bug: the Edit tool has truncated the sql template literal on line 93 multiple times. Use Python script to fix if it recurs — replace lines 76-93 directly.
