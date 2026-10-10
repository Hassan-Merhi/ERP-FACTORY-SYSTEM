# Retail Wave 2 — Customers, Pricing/Tax and Physical Stock Count — Design

Status: approved for implementation
Builds on: Retail Wave 1 (color/size variants, barcodes/labels, retail POS sale/return/exchange, reporting)

## Goals

Add four tracks on top of the Wave 1 retail sale model without changing any existing behavior
when the new features are unused:

- **A. Customers** — reuse the ERP `customers` table, keep Walk-in as the default, allow optional
  customer selection, quick create from the POS, and show purchase/receipt/return/exchange history
  plus a historic sale search (receipt number, customer, barcode/item, date).
- **B. Discounts / price overrides / promotions** — line percent/fixed discounts, whole-sale
  percent/fixed discounts, price overrides, discount reasons, role-based limits with manager
  approval, a never-destroyed original price snapshot, refunds based on the amount actually paid,
  and a small date-based promotion framework.
- **C. Tax foundation** — company-configurable enable/disable, rate and inclusive vs exclusive
  pricing, disabled by default, understood by checkout, receipts, payments, accounting figures and
  reports as `Subtotal → Discount → Tax → Final Total`.
- **D. Physical stock count** — dedicated count sessions with
  `Draft → Counting → Review → Recount → Finalized`, expected-quantity snapshots, repeated barcode
  scanning, manual entry, uncounted/unexpected/variance/recount-required handling, atomic and
  idempotent finalization that writes `retail_stock_movements` (never a bare inventory overwrite),
  and variance reporting that survives concurrent POS sales.

## Money model (source of truth)

Per sale line, snapshotted and never recomputed:

| field | meaning |
| --- | --- |
| `original_unit_price` | variant selling price at sale time — never overwritten |
| `unit_price` | final net (pre-tax) unit price actually charged after every discount |
| `gross_unit_price` | unit price actually paid including tax — refund basis |
| `line_discount_amount` | total line discount (promotion + manual line + allocated whole-sale) |
| `line_discount_type` / `line_discount_value` | how the discount was entered (`percent`/`fixed`/`override`/`promotion`/`none`) |
| `price_override` | true when a cashier keyed a manual price |
| `promotion_id` | promotion applied automatically, when any |
| `tax_amount` | tax for the line |
| `line_total` | `quantity × gross_unit_price` |

Sale header: `list_subtotal → discount_total → subtotal (net after discount) → tax_amount →
total_amount`, plus order-discount fields and the customer snapshot. All discount money is
calculated in integer cents with largest-remainder allocation for the whole-sale discount, so
`Σ line discounts = discount_total` and `subtotal + tax = total` hold exactly. A line with no
promotion/discount/override/tax keeps the exact unrounded Wave 1 numbers.

Returns refund `gross_unit_price × quantity` (the historical amount paid), split into
`refund_amount` and `refund_tax_amount`, and never touch the sale row.

## Approval policy

`retail_pos_settings` (one row per retail company) holds `discountLimitPercent` (default 10),
`requireManagerApproval` (default true), `priceOverrideRequiresApproval` (default true) and the tax
foundation fields. Manager roles are Admin / Owner / Manager / Developer.

A cashier's checkout needs approval when a manual discount's effective percent exceeds the limit or
a manual price override is present (as configured). Approvals are issued by
`POST /api/pos/retail/discount-approvals`: the manager's username/password is verified against
`user_company_roles` for the same company, the exact cart is fingerprinted, and an HMAC-signed
10-minute token plus a `retail_discount_approvals` audit row is returned. Checkout verifies the
signature, company, cashier, expiry, fingerprint and approved limits, snapshots the approver on the
sale and lines, and consumes the approval once; a consumed approval cannot be reused for a different
sale (409), while an idempotent retry of the same sale keeps working.

## Stock count

Tables `retail_stock_count_sessions` / `_lines` / `_events`. `code` is `SC-######` per company;
statuses are `draft | counting | review | finalized | canceled`. `start` snapshots a line per tracked
variant at the session location (including zero rows) and moves to `counting`. Scans increment,
manual entry sets, unknown barcodes create `unexpected` lines with expected 0, and every change
appends an event. Finalization locks the session, re-reads live quantities under the inventory row
lock, writes `stock_count` movements referencing the session and stores `finalized_result` for
idempotent replays. Because the movement delta is `counted − live`, a POS sale during a count
reconciles: the snapshot explains the variance while the movement corrects real stock.

## Endpoints

POS (retail company session; POS role allowed):

- `GET /api/pos/retail/customers`, `POST /api/pos/retail/customers`,
  `GET /api/pos/retail/customers/:id/history`, `GET /api/pos/retail/sales/search`
- checkout extension on `POST /api/pos/retail/sales` (customer, line/order discounts, override,
  approval token); returns unchanged
- `GET /api/pos/retail/settings`, `PUT /api/pos/retail/settings` (non-POS)
- `POST /api/pos/retail/discount-approvals`
- stock count: `GET/POST /api/pos/retail/stock-counts`, `GET /:id`, `POST /:id/start|scan|review|recount|finalize|cancel`,
  `PATCH /:id/lines/:lineId`, `GET /:id/variance`

Management (non-POS): `GET/POST /api/retail/promotions`, `PATCH /api/retail/promotions/:id`,
`DELETE /api/retail/promotions/:id`, `GET /api/retail/stock-counts/report`.

## Out of scope

Coupons, loyalty, gift cards, customer credit accounts/statements, multiple tax rates or tax
categories, blind counts, count approvals/scheduling, serial-level counting.
