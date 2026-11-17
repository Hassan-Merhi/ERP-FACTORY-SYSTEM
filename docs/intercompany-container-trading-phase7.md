# Intercompany Container Trading — Phase 7 navigation consolidation

**Scope:** `feature/intercompany-container-trading` only. This is a feature-branch implementation, **not a production release or accounting sign-off**. Do not merge to `main`, deploy, or post actual company money/stock on the strength of UI tests alone.

## Canonical pages

| Operation | Where users now work |
| --- | --- |
| Create original Properties supplier purchase order and select destination per container | **Properties → Import PO** (`/properties/po-import`) |
| Track original physical container and associated PO | **Properties → Tracking** (`/properties/tracking`) |
| Inspect the real physical container and its intercompany status | **Properties → Containers → Container Details** (`/properties/containers/:id`) |
| Adjust linked intercompany PO prices, freight and shared charges | **Linked PO & Freight** tab within the same Properties container detail |
| Receive arrival into the destination ERP or cancel an unreceived internal sale | **Receive / Cancel** tab within the same Properties container detail |
| Post confirmed paired cash transfer with exact PO allocations and unused credits | **Properties → Vouchers → Receipt** (`/properties/vouchers?tab=receipt`) or destination ERP **Vouchers → Payment** (`/vouchers?tab=payment`). Selecting the exact linked intercompany receivable, payable or Properties supplier triggers mirrored cash posting inside the normal voucher form |
| Make ordinary supplier payments | **Vouchers → Payment**, still independent and company-local |
| Review real paired payment history, original voucher references and append-only reversals | **Payment/Receipt → Linked payment history and reversals** expandable section when an exact intercompany account is selected |

## Removed from the Properties sidebar

The separate **Trading** section (Linked POs & Freight, Intercompany Payments & Credits, Receiving & Cancellation) was removed. All three old routes remain registered as permission-gated redirects, not duplicate posting screens:

- `/properties/linked-trades` → `/properties/containers`
- `/properties/intercompany-lifecycle` → `/properties/containers`
- `/properties/intercompany-payments` → `/properties/vouchers?tab=payment`

For the first two, `?physicalContainerId=123` or `?containerId=123` directs to `/properties/containers/123` if the ID is a valid positive safe integer. Invalid or conflicting IDs return to the list, without trusting an unverified `tradeId`. The container page and API independently enforce company authorization. The existing `/properties/container-trading` bookmark still redirects to Import PO.

Destination ERP `/intercompany/payments` redirects to the ordinary ERP Vouchers Payment tab under the existing page grant. Destination ERP `/intercompany/lifecycle` and `/intercompany/linked-trades` remain guarded **compatibility screens**, because a destination-only ERP receiving user may still need those actions before they are offered directly in ERP container details. Hiding their functionality now would create a receiving-access regression.

## Protected accounting and audit invariants

Removing a menu or redirecting a page does **not** delete intercompany trades, supplier POs, original physical containers, historical vouchers, bank/cash movements, credits, shared invoices, receipt stock or audit records.

The normal Payment/Receipt UI intercepts exact verified mapped account IDs and invokes the single paired-cash endpoint, with explicit permissions in both companies, server-side company-scope validation, distinct historical exchange rates, unique transfer references, idempotency keys and one atomic source receipt + destination payment. Unapplied credit remains inside its verified company pair; reversals append two offsetting vouchers without deleting original entries.

The container detail still invokes the original protected PO revision, shared-charge, destination receiving and pre-receipt cancellation endpoints. Receiving posts an actual destination stock movement and GIT-to-inventory journal; it does not duplicate the original Properties container. Cancellation cannot invent a cash refund or erase supplier evidence.

## Validation and next release gate

Run the `Intercompany Phase 5 Isolated Validation` workflow (now executing Phase 1–7 tests) against disposable PostgreSQL with schema and migrations; include Phase 7 navigation tests in the same checked set. Also verify TypeScript, formatting, frontend/build, security, and manual owner + View Only navigation behavior. Test old bookmarks, deep links and company switching in staging. Full PR-wide failures unrelated to intercompany work must be reported rather than silently bypassed. Production promotion requires independent accounting review, confirmed isolated test database connection, rollback plan, backups and explicit owner authorization.
