# Permissions Control Center — Phase 3 Create Only Route Review

**Status:** complete for the current route manifest (2026-11-07). The Create Only role is enforced on the server; assigning it to people stays behind the operator switch described in [permissions-control-center-activation.md](permissions-control-center-activation.md).

## How Create Only is enforced

Four independent server layers refuse a Create Only write. Any one of them is enough.

1. **Global write guard** (`server/auth.ts` → `blockUnverifiedCreateOnlyWrites`, mounted in `server/index.ts` right after the session). It refuses every non-GET `/api` request (any casing) unless it exactly matches a signature in `CREATE_ONLY_VERIFIED_CREATE_SIGNATURES` (`shared/createOnlyRolePolicy.ts`). Sign-in, presence and remote-support transport writes are the only other exceptions, the same as for View Only.
2. **Canonical membership check** (`server/middleware/tenantIsolationBoundary.ts`). The same rule is applied with the role read from `user_company_roles` for the active company, so a session whose stored role is older than the database cannot keep writing.
3. **Per-route guard** (`createOnlyVerifiedCreate`, `server/services/security/createOnlyVerifiedCreates.ts`). Every allowlisted route carries it; the route manifest shows it in each chain. It refuses any request shape that could touch an existing record, post an unintended balance or reach another company, and it follows the company's page settings for the role.
4. **Offline sync** (`server/edge/phase9*Apply.ts`). Every offline apply handler refuses an event whose actor holds Create Only, before reading business data.

Supporting rules:

- `canModifyDate` lets Create Only date records **today only**, and `getTrustedClientDate` ignores an `X-Client-Date` header more than one day from the server date.
- Legacy feature keys (`server/lib/permissionHelpers.ts` → `isCreateOnlyFeatureAllowed`): settings, approve, void, adjust, transfer, import, bulk, user/company management, backup download and POS overrides are always denied; money fields (`fld_*`) need an explicit grant; pages and modules read like View Only.
- Every place that grants View Only a read (company resource scope, ERP pages, GIT reports, pressing reports, Factory daybook, SP access) also grants Create Only; every place that refuses View Only a write (POS mutations, imports, bulk maintenance, pressing scans, tickets, loading-container empties, AI draft/write actions) also refuses Create Only.

## Verified creates (allowed)

| Signature | Guard refuses |
|---|---|
| `POST /api/suppliers` | non-zero `openingBalance`; page_suppliers disabled for the role |
| `POST /api/customers` | non-zero `openingBalance`, any `ledgerAccountId` (re-links ledger history), `deletedAt`; page_customers disabled |
| `POST /api/stock-items` | non-zero `openingQty` / `openingRate` / `openingValue` (opening stock without a source document), `deletedAt`; page_stock_items disabled |
| `POST /api/factory/bales/create-batch` | quantity outside 1–200, weight per bale not a positive number up to 2,000 kg |
| `POST /api/factory/customer-orders` | any status but DRAFT; verification, loading, finalization, invoice, dispatch, booking, hidden or deleted fields; non-zero totals; a customer or location outside the company |
| `POST /api/{properties,erp,factory}/rental/units` | `active: false` |
| `POST /api/{properties,erp,factory}/rental/contracts` | any status but ACTIVE, `linkedCompanyId`, `isInternal`, guarantee posting state, a start date before the first day of the current month |
| `POST /api/retail/products` | variant opening stock (`stocks`), variant `id` or `expectedQuantity` (edit markers) |
| `POST /api/sp/sales` | a sale date other than today |

Each handler was read end to end, including the services it calls. Every row it writes is new, and every automatic posting it makes belongs to the new record: the supplier/customer audit and ledger account, the bale numbering sequence, the order's audit row, the SP sale voucher and FIFO stock relief.

## Reviewed and kept denied

| Signature | Why it is not a Create Only create |
|---|---|
| `POST /api/vouchers` | A repeated voucher number re-enters the "self-heal" branch and UPDATEs the existing voucher row. |
| `POST /api/vouchers/journal` | Customer entries edit existing customer-order charges, order totals and invoice balances. |
| `POST /api/vouchers/with-entries`, `POST /api/vouchers/payment-receipt` | The `optional` path skips account-ownership checks, and any Loans-type account rewrites existing transporter allocations. Candidate for a later verified create with an `optional`/Loans guard. |
| `POST /api/pos/sales`, `POST /api/pos/retail/sales` | Cashier operations need an assigned location and cash custody the role does not have; some configurations post into another company. |
| `POST /api/pos/retail/transfers` | Moves existing stock between locations. |
| `POST /api/factory/mix-batches` | Always consumes existing raw stock or batches and can close an opening batch. |
| `POST /api/factory/payrolls/generate-bulk` | Bulk; settles existing advances and deductions and retires earlier payroll vouchers. |
| `POST /api/{properties,erp}/rental/payments` | Allocates to and settles existing monthly ledger rows. |
| `POST /api/factory/containers` | Posts import, freight and commission vouchers using supplier and ledger ids the handler does not company-check. |
| `POST /api/factory/production-positions` | Admin-gated in the handler, and a backdated `effectiveFrom` changes past bonus periods. |
| Every other non-GET route | Not reviewed as a create; denied by default. |

Adding a route to the allowlist requires a handler review like the ones above, an entry in `CREATE_ONLY_VERIFIED_CREATE_SIGNATURES`, `requireCreateOnlyVerifiedCreate(name)` on the route, and green `tests/access-control-v2-create-only-*.test.ts`.

## Evidence

- `tests/access-control-v2-create-only-activation.test.ts`: every manifest write is refused except the verified signatures; legacy roles are unaffected; exact matching; request rules; guard middleware; dates; offline sync; assignment switch.
- `tests/access-control-v2-create-only-http.test.ts`: through the real app and PostgreSQL, a Create Only session gets 403 on every POST/PUT/PATCH/DELETE route that is not a verified create (1,100+ routes), with unchanged business-table fingerprints; clean creates succeed; its own new records stay immutable; cross-company bodies and a stale session are refused.
