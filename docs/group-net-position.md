# Group Net Position

The live **Group Net Position** view is available from **Settings → System Tools**. It is an ERP-side consolidated balance-sheet view.

## Accounting contract

- Active `supplier_partner`, `factory`, `factory_v2`, and `properties` companies are excluded on the server before any company calculation, so they cannot enter the API totals or Excel export.
- Ordinary ERP and retail companies reuse the live `/api/stats/net-profit` calculation so each company's **What We Have** and **What We Owe** match its normal Net Position page, including the current cash/bank translation rules.
- Every included company is calculated inside that company's own authorized request and PostgreSQL tenant scope. The result does not depend on which company happens to be selected in the browser.
- `Intercompany` ledger accounts are excluded by the shared Net Position classifier before the per-company totals are returned.
- Group **What We Have** is the sum of the included companies' What We Have totals.
- Group **What We Owe** is the sum of the included companies' What We Owe totals.
- Group **Net Position** is always `Total What We Have - Total What We Owe`. Supplier Partner/equity adjustments are outside this report.

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

Both routes use the Settings financial-tool access boundary and intersect the requested group with companies the authenticated user is allowed to access.

## Excel

The workbook contains:

- Group Summary
- What We Have
- What We Owe
- one detailed worksheet per included company

## Verification

Focused tests pin the server-side company-type exclusions, per-company tenant/database scope, current and historical Net Position behavior, group reconciliation, and workbook structure.
