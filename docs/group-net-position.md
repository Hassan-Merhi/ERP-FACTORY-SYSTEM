# Group Net Position

The live **Group Net Position** view is available from **Settings → System Tools**, directly beside the existing Net Position card in both ERP and Factory workspaces. It is intentionally hidden from the Properties workspace.

## Accounting contract

- The page reuses `calculateNetPositionAsOf()` for every included company; it does not maintain a second Net Position formula.
- Active companies are included automatically except companies whose `company_type` is `properties`.
- Properties is filtered on the server before any company calculation, so it cannot appear in API totals or exports.
- `What We Have` and `What We Owe` are summed from the exact per-company snapshots.
- `Group Net Position` is the sum of the exact per-company `netPosition` values.
- If an existing company rule makes `netPosition` differ from `What We Have - What We Owe` (for example Supplier Partner equity treatment), the difference is exposed as a Net Position adjustment so the group total still reconciles exactly.
- Ordinary `Intercompany` ledger accounts are already excluded by the shared Net Position classifier. The group layer therefore does not apply a second blanket elimination that could double-remove internal balances or interfere with special company rules.

## UI

The view provides:

- Total What We Have
- Total What We Owe
- Group Net Position
- company overview table
- expandable What We Have / What We Owe detail for every included company
- as-of date selection
- manual refresh
- responsive mobile stacking
- Excel export

## API

- `GET /api/stats/group-net-position?toDate=YYYY-MM-DD`
- `GET /api/stats/group-net-position-excel?toDate=YYYY-MM-DD`

Both routes use the Admin/Developer access boundary used by the Settings financial tools.

## Excel

The workbook contains:

- Group Summary
- What We Have
- What We Owe
- one detailed worksheet per included company

## Verification

Focused tests pin the server-side Properties exclusion, exact per-company reconciliation, special Net Position adjustment handling, and workbook structure.
