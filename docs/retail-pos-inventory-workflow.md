# Retail POS + Inventory workflow — implementation phases

Branch: `feature/retail-pos-inventory-workflow`

## Scope and invariants

The user wants the **Retail** company type to keep normal ERP navigation, accounting and
customer concepts, but sell exact retail product color/size/barcode variants with photos.
Existing ERP, Factory, Supplier Partner and other company types must be unaffected.

- Preserve existing Retail inventory, variant barcode, stock ledger and accounting history.
- Reuse normal ERP POS presentation where possible, not its stock-item sale API.
  Retail sales must continue to use retail variant-aware sale/return endpoints until
  a separately designed and verified server-side integration safely replaces them.
- Do not route a retail variant sale through a normal ERP stock-item sale endpoint.
- UI changes to vouchers must not turn off automatic accounting journals or credit-note
  postings required by sales, returns and refunds.
- Sales Report integration must include retail sale/return data and avoid duplication;
  do not assume normal ERP's existing sales-report source already includes retail.
- All future phases on this same branch. No CI, tests, lint, typechecks or builds by
  ChatGPT. No merge/deploy/production accounting or inventory data changes. Claude
  performs verification after implementation phases are complete.

## Phase 1 — retail-only navigation + shared UI groundwork (implemented)

- Retail workspace pills now show **Inventory**, **Quick add**, **Stock operations**,
  and **Selling settings** only.
- Removed Retail POS, Reports, Stock count and Sales history pills from retail
  workspaces, and the redundant `Open POS` button from Retail Inventory.
- Regular ERP POS entry (`/pos`) continues to route retail-company users to
  `/retail/pos`, and POS-role cashiers keep their existing retail POS entry.
  This is intentional until the replacement POS presentation is complete.
- Previously implemented routes and server endpoints remain in place; this is a
  **visibility change**, not a destructive data or accounting deletion.
- Added `PosWorkspaceColumns`, now shared by both normal ERP and Retail POS,
  preserving the **existing** layouts independently. The common shell provides the
  migration seam for later matching the normal POS grid and item sidebar.
- Updated existing source contract assertions to reflect the new retail navigation
  while retaining deep-link/POS reachability checks.

No tests, CI, lint, typechecks or builds were executed for this phase.

## Remaining phases

### Phase 2 — product gallery (implemented)
- Retail product cards and product detail use the first saved style image as their
  primary cover thumbnail. Clicking a photo (not the product name) opens a roomy,
  responsive gallery modal with all the style photos and additional variant photos.
- Exact color/size inventory rows use their own photos first, then generic style
  photos, and deliberately do not mix photos from other variants.
- Gallery includes image counter, next/previous buttons, clickable thumbnail filmstrip,
  left/right keyboard navigation, close via existing Radix dialog and scrollable zoom.
  Empty-image placeholders remain non-interactive; duplicate URLs are deduplicated.
- Product and variant editors support **Set main**, placing the selected photo first
  in their persisted image URL list. No new photo data schema or backend routes.
- Existing media-route URL normalization remains in use for portability across hosts.
- No changes to standard ERP/Factory POS, Retail checkout, stock or accounting.
- Implementation committed without running tests, CI, typechecks, lint or builds.
  Claude should later manually verify touch layout, many-photo galleries, keyboard
  focus/escape behavior, chosen cover-photo persistence and graceful broken images.

### Phase 3 — standard ERP POS presentation for Retail (implemented in source)

- Retail POS now renders a standard ERP-style **Point of Sale** header and a
  working top Save action, plus a location/date/payment/customer control strip.
- Retail exact-variant sale lines appear in a left-hand table with item, photo,
  color/size, barcode, quantity +/- controls, effective rate, amount, line
  discount/price override and remove actions. Its total is fed by the **retail
  server-side cart preview**, not duplicated client accounting math.
- A right-hand scrollable item selector supports barcode scanning, text search,
  image thumbnails, click-to-open full product gallery and item selection.
  Clicking the photo does NOT add an item; clicking the item entry does.
- Shared `PosWorkspaceColumns` places these two screens in the same pattern as
  normal ERP POS, with narrow/mobile layouts stacking them vertically.
- Customer picker is in the top strip; whole-sale discounts, manager approval,
  split payments, existing receipts, returns/exchanges, shift requirement,
  location controls and back-office transfer widgets remain in place.
- Sale notes now appear below the grid and are saved through the pre-existing
  retail sale `notes` field. They participate in the checkout idempotency
  fingerprint and clear only when a sale succeeds or the context changes.
- The top payment method picker is bound to the existing first tender; when
  cart totals change, the selected payment method is no longer reset to cash.
- The date reflects the local current day, for display only: Retail checkout
  still uses the server's actual sale timestamp. Do not imply manual
  backdating exists. Credit was intentionally disabled at the end of Phase 3,
  then enabled by the Phase 4 customer-receivable implementation below.
- The grid deliberately does not show simulated P/L; retail POS item responses
  do not expose authoritative profitability data. This remains a separately
  verified reporting requirement, not an invented value.
- **Retail-only presentation.** Existing ERP / Factory / Supplier Partner POS
  components, server-side retail variant accounting, stock movements and journal
  posting were not changed.

No tests, CI, lint, typechecks or builds were run. Claude should verify the
responsive grid, scanner input, image viewer focus, stock guard, promotions and
server preview, tender persistence, discounts/approval, receipt flow, route
guards and existing ERP POS behavior before merging or deployment.

### Phase 4 — customers and checkout controls (implemented in source)

- Select an existing ERP customer or create one from the POS. The customer picker
  reads the **actual ERP customer ledger balance** through a company-scoped Retail
  read endpoint. Debit-positive is customer receivable, debit-negative is credit.
- The checkout Credit toggle or "Customer Credit" tender sets an **unpaid, on
  account** portion. A real selected customer is required and validated by the
  server; anonymous walk-ins may still pay cash, card, bank, mobile or other.
- Retail credit is `method: "credit"` in the existing Retail payment/tender rows
  (the database column already supports text methods). This is a debt allocation,
  **not** cash received or a store-credit liability. The tender amounts must add to
  the full server-priced sale total; split tenders allow part paid, part on account.
- The central ERP accounting voucher posts **Dr selected customer** for the unpaid
  portion, Dr actual payment accounts for collected tenders, and the existing
  revenue/tax/COGS/inventory legs. All legs are in the existing one-transaction,
  idempotent Retail posting path; no duplicate customer-balance table or phantom
  cash receipts are introduced.
- A credit return/cancellation reverses uncollected receivables first, then returns
  any remaining real payment amount, using the same original sale's customer ID.
- **Owner decision (2026-10-24): returns on credit sales settled through ERP.** The
  "uncollected" amount is the sale's own credit tender, not the customer's live ERP
  balance. If the customer has since paid their account with an ERP Receipt voucher,
  a later return still reverses that sale's credit tender (Cr customer), so the
  customer's account moves into credit by the returned value. No cash leaves the
  Retail drawer. This is intended: the books stay correct and the customer can use
  the credit on later purchases. If the customer wants cash instead, staff record it
  with a normal ERP **Payment** voucher to that customer (Dr customer, Cr cash/bank),
  which clears the account credit.
  Changing a posted credit sale's customer ID through the existing receipt-edit
  API is blocked; it would otherwise leave accounting on the old customer.
- Retail payment validation accepts `null` cash-tendered amount on credit, card
  and bank payments. The client preserves selected payment methods and separates
  Collected from On account in the totals. Receipts and last-sale summaries label
  unpaid/reversed credit accurately, without presenting it as money collected.
- Both fixed/percentage line-level and invoice-wide discounts, reason collection,
  manager approval and historical prices/tax/cost are preserved from prior waves;
  the authoritative server preview and sale snapshots remain the source of truth.
- Retail cash-shift actual cash counts already include only cash method entries.
  Customer receivable statement and ERP account balances come from the canonical
  posting engine rather than from Retail payment totals.
- Receivable repayments may be handled using the existing authorized ERP customer
  receipt/voucher workflow; a specialized Retail balance-collection UI is not part
  of this phase.
- No production transactions, historical voucher edits, schema migrations or
  balance recomputations are performed. The server changes only run when this
  branch is ultimately merged and deployed by the owner.

No CI, tests, lint, typechecks or builds were run. Claude should later verify
full/partial credit sales, cash+credit split, revenue/COGS, tax and discount math,
credit-first returns, cancellations, customer-ledger balances, receipts, idempotent
retry, blank customer blocking, deleted customer rejection, company isolation,
closed shift behavior and existing ERP / Factory / non-retail accounting.

### Phase 5 — returns/refunds/exchanges (implemented in source)

- A **Return / Exchange** action on Retail POS replaces the embedded recent-sales
  history. Cashiers can search an original sale by receipt ID, product, SKU or
  barcode (numeric barcode falls back after trying receipt ID). The result is
  location- and company-scoped and shows customer, date, original items and status.
- Return dialog supports **multiple original sale lines**, whole-unit quantities
  capped at sold minus previously returned quantity, exact color/size/photos,
  a written reason and original historical tax-inclusive refund amount. The server
  recalculates all money and locks original sale/return-item rows.
- Refund destination is original payment allocation or customer account credit.
  Outstanding credit ("credit" tender) is reversed **first**, then collected
  tenders are refunded to their original method or credited to the customer.
  Account credit is recorded as a refund-only `store_credit` method with its
  original payment reference and is posted as **Cr customer** on the ERP ledger;
  it is not a cash refund or a second sales credit. Customer-account credit
  requires a real original-sale customer and elevated permission.
- Each return line has an explicit **restock** flag, with a default of true for
  all existing returns. For damaged/non-sellable goods the flag is false: the
  sale-line returned quantity and refund are recorded, but sellable inventory is
  not incremented, the original COGS remains a loss and the zero-delta stock
  movement records the financial return reason/disposition.
- Additive migration: `migrations/20261023_001_retail_return_disposition.sql`
  adds `retail_pos_return_items.restocked BOOLEAN NOT NULL DEFAULT true`;
  the always-on Retail financial schema guard provides the same idempotent
  column catch-up, so preexisting return rows preserve their earlier meaning.
  Neither migration nor guard was executed by this implementation.
- Retail financial/variant reports treat zero-delta damaged returns as financial
  returns using audited `returnedQuantity` metadata and do **not** subtract
  restored cost for goods that never returned to stock. Retail return movement
  integrity expects zero delta for non-restocked rows rather than falsely
  reporting a stock mismatch.
- Exchange is an atomic **return of original sale + replacement sale** with
  existing idempotent operation key; the new sale retains the original customer
  and may use that customer's credit tender. The replacement total is taken
  from the existing Retail server cart preview (promotions/tax). Its credit
  difference is a net presentation of the two real posting legs; their refund
  and new-sale payment entries remain auditable separately. The counter
  balance (`balanceDue`) is replacement money collected now minus tender
  actually paid back: a return that only reverses an unpaid receivable is
  not cash for the customer (`receivableReversed` vs `tenderRefund`).
- Manager+ authorization required for damaged/non-restock and customer-account
  credit refunds. A cashier shift is optional for returns and exchanges, as for
  sales: a refund without a shift stays off every drawer (established contract,
  covered by `tests/retail-wave2-pos-integration.test.ts`).
- Existing retail sale records and historic vouchers are not rewritten.
  All new return/refund/COGS/inventory postings are performed transactionally
  only when the code is later deployed and a real return is requested.

**Claude verification:** Apply additive schema to an isolated test database.
Verify partial single/multiple-line returns, duplicate retry keys and concurrent
returns, tax-inclusive and discounted historic prices, sale/account balance
before/after mixed paid-credit refunds, customer-account credit on cash sale,
manager/POS role gates and shift closure, damaged return no sellable stock,
COGS/profit and audit consistency, exchange promotion/tax calculation,
replacement customer and credit, and unrelated ERP/Factory POS regressions.
Confirm Finance reconciliation distinguishes amount allocated vs amount collected.
No CI, tests, builds, lint, typechecks, rebase or deploy performed here.

### Phase 6 — retail-specific voucher visibility (implemented in source)

- Retail-only policy (`client/src/lib/retailVoucherPolicy.ts`) removes manual
  **Journal**, **Transfer Order**, **Adjustment**, and **Credit Note** tabs from
  the Vouchers hub. Both mobile sheet selector and desktop sidebar derive from
  the same filtered navigation groups.
- The existing URL/query-state hook gets Retail's filtered `allowedValues`
  and `knownValues`, so a deep link or stale browser hash to
  `/vouchers?tab=journal`, `transferorder`, `adjustment`, or `creditnote`
  falls back to the first allowed voucher type instead of rendering a manual
  form. Switching companies restores ERP/Factory options appropriately.
- Retains Payment, Receipt, and the existing Stock Transfer tab; **Transfer
  Order** is a separate legacy workflow and is hidden. Retail's dedicated
  barcode/variant Stock Operations workflow remains at `/retail/stock`.
- Retail direct links to `/stock-transfer-order` redirect to
  `/retail/stock` via the authenticated route guard. The standalone editor
  also redirects *before mounting* its ERP transfer-order model.
- Existing system-generated Journal, Credit/Debit Note and stock adjustment
  vouchers are **read-only** through the generic `/vouchers/:id/edit`
  route; users can open their `/voucher-detail/:id` audit details.
  The generic voucher edit modal also refuses those edits, and on Retail its
  type picker does not offer the Journal type. A legacy `/vouchers?edit=:id`
  link to one of these types is redirected to its read-only detail.
- **Not an accounting data migration.** No voucher rows are deleted, no
  system-entry posting code is touched. Automatic Retail sale, return,
  refund, credit, COGS and tax journals continue to be created by their
  transaction-owned server services. Financial statements/Daybook still
  display the entries.
- This phase restricts **UI entry/edit affordances**; the Phase 8 HTTP guard
  below enforces the same rule on the server.

**Claude verification:** On a Retail company check mobile and desktop voucher
navigation, all four blocked query/hash deep links, normal Payment and Receipt
entry, Stock Transfer tab visibility, direct Transfer Order redirect, generic
modal/type selector, posted system Journal detail vs edit, and company switching
to normal ERP/Factory. Confirm ordinary Retail POS sales/refund accounting
journals still post and remain readable, with no cross-company UI regressions.
No tests, CI, lint, typechecks, builds, merge, rebase or deployment performed.

### Phase 7 — multi-location transfers (implemented in source)

- Retail Stock Operations → **Transfer** now offers a searchable sidebar of exact
  color/size/barcode variants at the selected source location. Product thumbnails
  open the full photo gallery independently of selecting the item; both variant
  and generic product pictures are included, without sibling variant pictures.
- Select source/destination location, validate a positive whole-unit quantity
  and available source stock, then choose **Immediate** or **Dispatch / Receive**.
  Immediate retains the existing atomic Retail transfer service; its stock-out
  and stock-in movements and weighted-average cost remain unchanged.
- Dispatch uses `POST /api/pos/retail/transfers/dispatch` and creates an
  idempotent `retail_stock_operations` row with `operationType =
  "transfer_dispatch"` and status `otw`, plus source/destination IDs, exact
  variant, quantity, original source unit cost and historical image snapshot.
  It deducts the exact variant from source only; the destination cannot sell it
  until confirmed. A source stock row lock prevents overshipment.
- Pending queue: `GET /api/pos/retail/transfers/workflow?status=otw` returns
  company-scoped pending dispatches with item details and source/destination
  locations. Each has a **Confirm receipt** button.
- Receipt uses `POST /api/pos/retail/transfers/:id/receive`. A database lock
  on the dispatch row prevents two receivers from accepting the same shipment.
  It records the unique receipt key/status/timestamps and user, receives into
  the destination at the original source unit cost blended into the destination
  average, and adds one `transfer_in` movement referencing the dispatch.
  Replay of the *same* receipt key is harmless; a second distinct receipt
  fails. The entire receipt is transactional.
- Inventory accounting: new registry account `RETAIL-IN-TRANSIT` (**Asset**).
  After Retail inventory opening, dispatch moves asset value from source stock
  inventory to in-transit; receipt clears in-transit to destination inventory.
  These are automatic **balanced** accounting vouchers, not sales, revenue,
  COGS or manual Transfer Order vouchers. Rounding/re-costing residuals continue
  to use the existing Retail stock adjustment accounting logic. Before the
  company's stock opening, the existing stock-value tracker intentionally
  suppresses journals on both stages. Applying a new opening while *any*
  dispatch remains pending is blocked, preventing unmatched stage postings.
- Both stages create variant-level stock-movement audit events with a shared
  transfer operation reference plus phase, source, destination, and quantity.
  The full movement history remains available in Retail Stock Operations.
- The small manager transfer card on the Retail POS also displays a variant
  thumbnail with gallery access and links directly to the full photo-based
  dispatch/receive workspace. No normal ERP / Factory transfer API changed.
- No schema migration or manual accounting voucher updates are necessary:
  the pre-existing Retail stock operations JSONB metadata records statuses.
  The in-transit system account is created by the existing registry only
  when an applicable dispatch posting is actually performed after deployment.
- Location assignments: Developer/Admin/Owner/Manager may move stock between
  any Retail locations. Every other role is limited to its `user_locations`
  assignments (`server/routes/pos/retailLocationAccess.ts`): dispatch requires
  the source store, receipt requires the destination store, an immediate
  transfer requires both, and the pending list shows only shipments leaving or
  arriving at the user's stores. A user with no assignment can move nothing.

**Claude verification:** Exercise immediate transfer vs dispatch/receipt, exact
barcode/color/size identity, source stock zero and overshipment refusal,
concurrent dispatches, two simultaneous receipt attempts, retry key replay,
accounting ledger/sub-ledger and RETAIL-IN-TRANSIT balance before/after,
asset valuation after destination blending, pre-opening dispatch/receipt,
cutover blocked while pending, closed/inactive locations, multi-company
isolation, manager/non-POS permissions, photo gallery focus, and both POS/
Stock Operations transfer entry points. Run tests/typechecks/CI and reconcile
against latest `main` only when Claude takes ownership; none were run here.

### Phase 8 — source-level integration and Claude handoff (committed)

- Reviewed the component and route contracts across Retail Inventory photo
  galleries, ERP-style POS, customer credit, refund accounting, returns,
  exchanges, Retail voucher handling and two-stage stock transfers.
- Fixed the Retail payment **Split** control when the sole default tender already
  covered the total. Previously it could only split a payment with unallocated
  remainder, making the typical $100 single-tender default unsplittable.
- Added strict **return replay** identity checks: an existing idempotency key
  must match the original sale, each sale line's quantity and its exact
  restock disposition. A mismatched retry cannot silently report another
  sale's refund as successful.
- Added strict **dispatch replay** identity checks: an existing operation key
  must match the exact product variant, source/destination, quantity and note.
- Added a Retail-only **manual voucher HTTP guard**:
  `server/middleware/retailManualVoucherBoundary.ts`, registered with the
  permission boundaries (`server/routes/core/permissionBoundaryRoutes.ts`)
  ahead of every voucher writer. For the selected Retail company it refuses
  `POST /api/vouchers/journal`, every write to `/api/credit-notes` and
  `/api/stock-adjustments`, generic creates of a hidden type, and any
  edit/delete through `/api/vouchers/:id*`, `/api/vouchers/bulk-delete` or
  `/api/voucher-entries` that targets a Journal, Credit/Debit Note,
  Adjustment or Transfer Order voucher. Payment, Receipt and Stock Transfer
  vouchers, internal transaction-owned postings and non-Retail companies are
  unaffected.
- Added detailed owner/Claude handoff at
  `docs/retail-pos-inventory-claude-handoff.md`, including route mappings,
  migration sequencing, permission boundaries, accounting examples, source
  and runtime verification matrix and a ready-to-paste Claude instruction.
- The branch is source-complete for the agreed phase plan, but **not yet
  runtime-verified or ready to deploy**. Claude must perform typechecks,
  tests, CI, regression/financial reconciliation and merge-base conflict
  resolution under its own ownership, with the owner's final approval.

No CI, tests, lint, typechecks, builds, SQL migration, merge, rebase, deployment
or production accounting/stock writes were performed by ChatGPT.

## Claude verification (2026-10-23)

Verified on this branch after merging current `main`. Evidence, fixes and
open items are recorded in `docs/retail-pos-inventory-claude-handoff.md`
("Verification record"). Accounting reconciliation runs in
`tests/retail-pos-inventory-workflow-integration.test.ts`.

