# Supplier Partner Navigation Registry

## Purpose

This document is the authoritative route, hierarchy, access, and compatibility registry for Supplier Partner navigation. It covers navigation behavior only and does not redefine Supplier Partner accounting, stock, payable, profit split, export, setup, alias, opening-stock, or migration business rules.

## Company-type boundary

Supplier Partner routes are valid only when the selected company has:

```text
companyType === "supplier_partner"
```

Any direct `/sp` or `/sp/*` request while another company type is selected redirects with replacement history to `/tracking`.

## Final route inventory

SP Reports is the Supplier Partner home. The Overview, Opening Stock, Aliases and Golden Coast
pages were removed on 2026-11-17 (owner decision 6, 2026-11-16); their URLs stay as replacement
redirects so old links and bookmarks keep working. Their server APIs and stored data are unchanged.

| Route | Screen | Access | Parent / compatibility behavior |
|---|---|---|---|
| `/sp/reports` | Supplier payable, profit and loss, sales-form exports (SP home) | Supplier Partner companies | Top level |
| `/sp/setup` | Supplier Partner Setup | Admin or Developer (others redirect to `/sp/reports`) | Back / Escape → `/sp/reports` |
| `/sp` | Retired Overview | Supplier Partner companies | Replacement redirect → `/sp/reports` |
| `/sp/opening-stock` | Retired Opening Stock | Supplier Partner companies | Replacement redirect → `/sp/reports` |
| `/sp/aliases` | Retired Aliases | Supplier Partner companies | Replacement redirect → `/sp/reports` |
| `/sp/golden-coast` | Retired Golden Coast operations | Supplier Partner companies | Replacement redirect → `/sp/reports` |
| `/sp/migration` | Historical compatibility path | Supplier Partner companies | Replacement redirect → `/sp/setup` |
| `/sp/gc-migration` | Historical compatibility path | Supplier Partner companies | Replacement redirect → `/sp/setup` |
| Unknown `/sp/*` | Invalid Supplier Partner route | Supplier Partner companies | Replacement redirect → `/sp` → `/sp/reports` |

## Sidebar hierarchy

One "Supplier Partner" section:

- Setup — `/sp/setup`
- SP Reports — `/sp/reports`

Supplier Partner pages are registered with Recent navigation from the same shared route source used by the sidebar.

## Reports sub-navigation

- Supplier Payable — `/sp/reports`
- Profit & Loss — `/sp/reports?tab=profit`
- Sales Form — `/sp/reports?tab=sales-form`

Invalid report-tab values canonicalize to Supplier Payable using replacement history. Refresh restores the selected canonical tab.
SP Reports also carries the monthly profit-split close (`QuickMonthlyClose`).

## Final decisions

- `/sp/reports` is the Supplier Partner home; `/sp` remains a compatibility URL that lands there.
- The migration tab is retired; both historical migration URLs land on Setup and cannot bypass its permissions.
- Back and Escape behavior is deterministic within the Supplier Partner hierarchy.
- Unknown Supplier Partner URLs never fall through to the generic ERP 404.
- Removed pages have no replacement screen: SP sale reversal (`POST /api/sp/sales/:id/reverse`), opening-stock entry,
  alias management and the Golden Coast HADI / savings / sales-cash / settlement panels. Their APIs and data remain.
- No Supplier Partner business logic, APIs, calculations, exports, setup actions, balances, posting behavior, or historical data behavior changed.
