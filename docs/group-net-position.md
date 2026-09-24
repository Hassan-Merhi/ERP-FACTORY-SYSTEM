# Group Net Position

The live **Group Net Position** view is available from **Settings → System Tools**. It is an ERP-side consolidated balance-sheet view.

## Accounting contract

- Active `supplier_partner`, `factory`, and `factory_v2` companies are excluded on the server before any company calculation. Active `properties`, ERP, and retail companies are included in API totals and Excel export.
- Included companies reuse the live `/api/stats/net-profit` calculation so each company's **What We Have** and **What We Owe** match its normal Net Position page, including the current cash/bank translation rules.
- Every included company is calculated inside that company's own authorized request and PostgreSQL tenant scope. The result does not depend on which company happens to be selected in the browser.
- Intercompany balances are excluded from the group: this includes `accountType=Intercompany`, legacy `IC-TO-*` / `IC-FROM-*` transfer accounts, child-side configured parent-credit accounts, and parent-side `[Subsidiary] Credit` receivables.
- Group-only presentation exclusions also remove the exact account names `HMD INTERNATIONAL GROUP LEBANON CREDIT` and `BANK LOAN`; their underlying accounts remain unchanged everywhere else.
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
