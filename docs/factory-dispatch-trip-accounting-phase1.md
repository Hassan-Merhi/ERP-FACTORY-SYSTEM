# Factory Dispatch Trip Accounting and Consolidated Invoice — Phase 1

**Date:** 2026-11-10  
**Branch:** `feature/factory-dispatch-trip-accounting-20261110`  
**State:** Phase 1 source audit and architecture complete; implementation phases 2–10 pending.  
**User instructions:** Do not run CI checks. Do not merge or deploy unless subsequently instructed. Do not execute production SQL; gather any necessary manual TablePlus SQL for delivery at the end of the implementation program.

## 1. Approved business flow and boundaries

One Factory `customer_orders` record / Pending Loading remains the **only parent order**. It can contain multiple physical truck dispatches. There is no mandatory per-truck expected allocation: trucks scan real bales; order-wide reconciliation compares all dispatched bale IDs against Pending Loading after the trips finish.

1. Existing **End Dispatch** closes physical verification only.
2. Every CLOSED trip can receive charges assigned to named existing ledger accounts, with a required distinction between customer-billable, discounts and internal cost; unassigned or invalid accounts block financial posting.
3. **Financially Finalize Trip** freezes exactly the physically scanned bales, selected order prices, quantities, weights, trip charges, currency, source closure revision, and financial total; it posts the receivable and applicable charge journals *once*.
4. Each financially finalized trip exposes **Export PO Excel**. It is **not** a direct ERP import, nor an ERP-import button. The operator uploads the exported file using the **existing** ERP PO Import (Excel) wizard. The export uses **article code in `Item_Barcode`**, not individual bale references. The factory retains bale-level traceability internally.
5. Every exported trip is a distinct ERP PO import/receiving document, but all trips remain under the same Factory order. An exported file is **not proof that ERP import/receipt occurred**.
6. After all trips have been physically closed, financially posted and compared with the original Pending Loading (or approved differences reconciled), **one existing `customer_orders` invoice** consolidates them. It must neither recreate receivables already posted per trip nor repeat charge vouchers or COGS.
7. ERP supplier payable and Factory customer receivable are **independent**; the operator's ERP supplier/rate/charges may differ. Neither amount can be silently overwritten by the other.
8. Do not change the existing dispatch scanner, active scan uniqueness, physical closure audit, order identity, or unrelated Factory / Properties / POS / ERP workflows.

## 2. Source audit and current behavior (main, 2026-11-10)

| Domain | Grounded source | Current behavior / impact |
| --- | --- | --- |
| Dispatch persistence | `server/startup/ensureFactoryLoadingDispatchSchema.ts` | Six verification-only runtime SQL tables with composite company/order/dispatch relationships, closure snapshots, append-only events, and unique live scans by company/order/bale. New financial schema must not rewrite these six tables or their constraints. |
| Physical close/reopen | `server/routes/factory/customer-orders/loadingDispatchLifecycleRoutes.ts`; `loadingDispatchClosePolicy.ts` | CLOSED records immutable scan evidence; supervisor may reopen under active order. New finance posting requires a **separate** state and prohibits normal reopen/edit of an already financially posted trip without approved financial reversal. |
| Comparison | `server/routes/factory/customer-orders/loadingDispatchComparisonRoutes.ts`; `loadingDispatchComparison.ts` | Actual `customer_order_bales` represent Pending Loading. Active physical scans carry exact bale, article, and KG. No per-trip expected count is required. Compare **sets of bale IDs** across trips, plus per-article totals and weights. |
| Reporting | `server/routes/factory/customer-orders/loadingDispatchReportData.ts` | Saved manifest and closure snapshots exist. Use saved closure **manifest**, not later mutable scans, as financial-post source. Old closures with null saved manifest must fail closed for posting until a verified authoritative snapshot is available. |
| Factory customer order | `shared/schema/factory/customer-orders.ts` | One parent `customer_orders`; `customer_order_bales.price_used`, article, KG and related order charges. Keep the single parent invoice, with linked trip children. |
| Final invoicing | `server/routes/factory/customer-orders/finalize-loading/finalize.ts` | Existing FINALIZED path generates `INV-...`, inserts one `customer_balances` SALE/INVOICE row, marks all order bales SOLD, generates charge vouchers and synchronizes invoice GL. **Cannot call unchanged after individual trips post**: would duplicate AR/revenue/charge accounting. |
| Accounting GL bridge | `server/services/accounting/perpetualInventory/factoryInvoice.ts` | `syncFactoryInvoiceTx` posts `INV-GL-{company}-{order}`; its receivable subtracts already-vouchered *order* charges, and may post COGS and finished goods once. It knows nothing about new trip postings. Extend in later phases to recognize trip vouchers and the reconciliation clearing, never count balances twice. |
| Order charges | `server/routes/factory/customer-orders/orderChargesRoutes.ts`; `orderChargeLedger.ts` | Unfinalized order charges are operational only. `postOrderChargeVoucherTx` requires `status === FINALIZED`; do **not** bypass this writer for interim trip charges. Introduce a separate trip-charge posting identity/path instead. Order-level charges and trip-level charges must have explicit ownership to avoid duplication. |
| Statements | `server/routes/factory/customers-core/statementRows.ts`; `heldUnfinalizedCustomerCharges.ts`; `server/services/accounting/balances/unpostedMemo.ts` | Customer balances use posted ledgers + memo fallback. Legacy `CHARGE-PRE` rows are intentionally held from statements while unfinalized. New trip receivables must use a distinct auditable source and be visible to Accounts/Customer statement/Net Position without creating phantom memo balances. |
| Revert invoice | `server/routes/factory/customer-orders/finalize-loading/unfinalize.ts` | Reverts final invoice, SALE cache, charges, SOLD bale statuses; blocks if invoice payments exist. Must be updated to **preserve/reconcile** already posted trip amounts or refuse until formal reversal, instead of blindly resetting bales/finance. |
| Missing-bale reconciliation | `server/routes/factory/customer-orders/bale-scanning/remove.ts` | A protected `source=dispatch-reconciliation` removal route already requires all trips closed and refuses removal of a bale scanned on a trip. Preserve it; add guard against removing financially posted bale references and require audit of approved short shipment. |
| ERP PO Excel | `server/routes/import/templates.ts`; `poImportExcelParser.ts`; `po-import-preview.ts`; `po-import.ts` | PO template uses `PO_Number`, `Container_Number`, `Supplier_Code`, `Item_Barcode`, `Item_Name`, `Quantity`, `Rate`, `Currency`, standard charge columns. `Item_Barcode` resolves item **code/alias**. Duplicate same codes in one file may be refused. ERP import groups by **container** and creates POs from PO numbers. Reuse its actual parser contract rather than inventing an XLSX schema. |
| ERP PO charges and uniqueness | `server/routes/import/poImportExcelParser.ts`; `server/routes/import/po-import.ts`; `poChargeAllocation.ts` | Parser recognizes Freight, Surcharge, Fumigation, Discount, Document_Charges, also typed `Charge_Type` / `Charge_Amount` for recognized types; unrecognized typed charges are currently ignored. Import blocks reused financially populated `Container_Number` and checks file hash. **Never silently export unrecognized custom charges**. |
| Permissions | `shared/factoryActionCapabilities.ts`; `server/lib/factoryAccessControl.ts` | Existing close roles differ from supervisor approval roles. Add distinct server-enforced permissions for charge manage, financial post, reverse, invoice consolidation, and export without widening View Only or Create Only. |
| Runtime schema convention | `config/runtime-only-tables.json` | Existing dispatch tables are runtime DDL and excluded from drizzle push. New financial tables need a coordinated migration/declaration strategy; do not allow drizzle push to drop composite constraints or trigger safeguards. |

## 3. Data model contract — for Phases 2 onward (NOT created in Phase 1)

These are **design-level** table names, subject to Phase 2 implementation review; no DDL is executed in Phase 1.

| Entity | Proposed identifier / fields | Invariant |
| --- | --- | --- |
| `factory_dispatch_trip_financials` | `company_id`, `order_id`, `dispatch_id` (unique); `closure_history_id`; `posting_status`; `version`; `currency`; `valuation_date`, `fx_rate`; `goods_subtotal`, `billable_charges_total`, `discount_total`, `customer_total`; `manifest_fingerprint`; `posted_at/by` | Financial state is independent of physical trip CLOSED/OPEN. One active posting per trip; verified source closure cannot change under it. |
| `factory_dispatch_trip_financial_bales` | Source scan/bale IDs, article code, name, KG, pricing mode, priced unit and amount, price source, snapshot revision | Unique source bale per parent order's active financial posting. Valuation is immutable after post. |
| `factory_dispatch_trip_charges` | Trip, named charge, type, billable/internal/discount classification, currency, amount, customer impact, selected ledger account, contra account when needed, ERP export mapping, voucher link | No generic expense posted as customer debt; explicit correct accounts; separately traceable and no duplicate ownership with order charges. |
| `factory_dispatch_trip_postings` | Unique `(company_id,dispatch_id,posting_type,revision)`; source fingerprint, actual linked voucher IDs, reversal IDs, timestamps and actor | Repeated POST is idempotent; reversal records are append-only; closed periods cannot be edited. |
| `factory_dispatch_trip_exports` | `dispatch_id`, financial version, export fingerprint, unique ERP PO/container identifiers, preview metadata, export timestamp | Download generates no ERP vouchers. Repeated export of same version is semantically identical; export is **not** imported status. |
| `factory_dispatch_order_consolidations` | Unique `(company_id,order_id)`, reconciliation fingerprint, included trip posting refs, aggregate goods/charges/discounts, invoice link, finalized-at/by | One consolidated invoice across every accepted trip; never include reversed trips. |
| `factory_dispatch_financial_events` | Trip/order, event, before/after summaries, user, timestamp, reason, voucher/export references | Append-only audit for charge revisions, financial post, reversal, export, discrepancy approval and consolidation. |

Mandatory composite company/order/trip FKs, unique constraints, indexes, money check constraints, timestamps and source identities will be specified in the final manual SQL package. Avoid independent mirror customer/supplier balances.

## 4. Financial and ledger behavior

**Customer-side amount:** `trip_goods + customer_billable_charges − customer_discounts`. Internal expenses do not increase this number.

Proposed customer GL mechanism to be finalized against the active company's chart of accounts and recognition policy before implementing Phase 4:

- Upon financially posting a trip: **Dr existing Customer Receivable**, **Cr a dedicated Dispatch Clearing** for its goods amount. This makes the customer balance real and traceable before the final invoice without prematurely duplicating the existing invoice sales journal.
- Billable trip charge: **Dr existing Customer Receivable**, **Cr its selected valid Charge Income/Revenue account** as appropriate. A discount uses a validated contra-income account **Dr discount / Cr customer receivable**.
- Internal company expense: **Dr the selected Expense/Landed-Cost account**, **Cr an explicitly selected payable/accrual/cash counterpart** according to payment status. Do not mistake an internal charge for customer revenue, and do not invent cash payment.
- Final consolidated invoice: transfer previously posted goods amounts **Dr Dispatch Clearing / Cr Factory Bale Sales Income**, book only approved incremental differences, then recognize inventory cost exactly once in the existing perpetual inventory logic if required by the company's accounting policy.
- Existing invoice `customer_balances` summary can retain the invoice's **full** display amount, but its GL and memo projection must credit earlier trip receivables and produce **zero extra AR for amounts already booked**. Statement/Net Position/Trial Balance reconciliations must hold to the cent.
- A new `syncFactoryInvoiceTx` integration must **not** subtract trip charges twice or clobber the trip postings. The current order-level `CHARGE-` logic remains valid for charges owned by the order and not already allocated to a trip.
- Payments linked to posted trips can be retained when consolidation replaces the provisional document with the final invoice; credits/payments are never duplicated. Reversal/repricing must respect partially settled amounts and closed periods.

**Accounting-policy gate:** Whether revenue, taxes and COGS should be recognized at dispatch versus invoicing depends on the entity's transfer-of-control, tax and inventory policy. The above clearing method is the safe planned default for receivable visibility, not an assertion that a physical scan alone constitutes revenue. Confirm required statutory accounting treatment before production posting.

## 5. State-machine and source-of-truth invariants

```text
Factory customer order: LOADING / PENDING_VERIFICATION -> VERIFIED -> FINALIZED
                                  |
Physical trip: OPEN -> CLOSED (existing; signed snapshot)
                            |
Financial trip: UNPOSTED -> POSTED -> (only through audited REVERSAL -> REPOST)
                            |
                         Export PO Excel (read-only; no ERP import side effect)
                                  |
                    Manual ERP PO Import / ERP supplier payable
                                  |
Order: all eligible trips posted + order-wide match / approved reconciliation
                                  |
                ONE existing Factory invoice, no duplicate postings
```

1. The **physical scan ID/bale ID** and signed closure manifest are the source for financial bale membership. Article code is used **only for PO grouping and ERP item lookup**, not for internal physical verification.
2. If a trip has been financially posted, a normal supervisor reopen or trip/bale mutation is refused. The only path is an approved reversible financial correction, followed by new signed close and re-post; a paid/closed-period posting may require a credit note rather than reversal.
3. A trip cannot be posted with missing closure manifests, unknown article code, unresolved pricing, unsupported currency/rate, duplicate/missing active scan, invalid ledger account, or stale fingerprint.
4. Pending Loading can retain **unshipped** bales until all trucks are done. Unshipped-bale removal is separately approved and must never delete a posted/verified physical scan.
5. Every financial write locks **order, then trip, then financial/posting rows** in a fixed order and uses one database transaction for vouchers and customer financial state. Same-key concurrent POST attempts cannot issue two receivables.
6. Final invoice route, invoice revert route, order repricing, bale edit/removal, charge edit, and direct finalize routes must enforce new parent-order guards when financial trip postings exist. Do not rely on one UI button gate.
7. One order may have multiple ERP import container identities, but **one Factory invoice**. An ERP PO import cannot modify Factory voucher balances.
8. Never convert the historical Phase 6 physical-closure `CLOSED` status to `FINALIZED`; maintain a separate posting status so old dispatch reports remain compatible.

## 6. PO-compatible XLSX contract

The XLSX must be produced from a signed, **financially posted** trip snapshot. Minimum standard sheet columns:

```text
PO_Number,Container_Number,Supplier_Code,Item_Barcode,Item_Name,
Quantity,Rate,Currency,Freight,Surcharge,Fumigation,Discount,Document_Charges
```

- `Item_Barcode` is **the Factory article code** after explicit code/alias validation against the destination ERP company's stock items; never export `bale_reference` in this column.
- Combine all bales with the same normalized article code and compatible rate/currency into one row; **do not** create two identical `Item_Barcode` rows because the PO validator flags duplicates. If same code has different priced rates, require an approved single export valuation or block with a clear explanation.
- `Quantity` is the number of scanned bales for that article, `Rate` the ERP PO rate supplied/approved for export. If ERP purchase cost differs from Factory sale price, record that difference as a separate export valuation; **never mutate Factory posted receivables silently**.
- `Container_Number` must be unique **for each truck** in the destination ERP, e.g. stable source order/trip key within the field's allowed length. Preserve actual truck/container number in separate Factory export metadata / report. `PO_Number` also identifies order and trip.
- `Supplier_Code` must correspond to a real ERP supplier selected by the operator; do not assume the Factory customer code equals the ERP supplier code.
- Standard charge fields are only the currently recognized importer types. For custom types, explicitly require a supported mapping, or extend the ERP parser/account mapping before exporting a payable; **never silently omit the charge from the PO financial total**. Internal non-billable Factory expenses are **not** automatically ERP supplier charges.
- Existing ERP importer checks duplicate file hashes, existing occupied container numbers, and item code/name matching. Later Phase 6 must validate the entire round trip against the parser and verify the accounting side is idempotent; do not claim an XLSX download automatically posts a supplier balance.
- Distinct trip files may create distinct ERP purchase containers/POs; the parent Factory order stays singular and records all export references.

## 7. Delivery phases and acceptance gates (none executed in Phase 1)

| Phase | Deliverable | Required acceptance |
| --- | --- | --- |
| 2 — Schema & source snapshots | Explicit financial tables and model contracts | Company-scoped FKs, uniqueness, immutable signed bale sources, migration file |
| 3 — Trip charges & financial preview | Charge UI and pricing preview | Valid account mapping, correct customer vs internal classification, no unapproved changes after POST |
| 4 — Financial posting & ledgers | Idempotent trip posting and corrections | Correct AR/clearing/charges, statement and net-position reflection, no duplicates |
| 5 — Excel exporter | PO-compatible `.xlsx` from posted trip | Exact parse round trip, article code grouping, stable trip identity |
| 6 — PO import and cross-system checks | ERP parser support and manual import safeguards | No direct button; no unrecognized charges, no duplicate ERP supplier payable or stock import |
| 7 — Order-wide matching | Exact scanned-vs-pending comparison and authorized short shipment | No missing/duplicate/bad bales accepted silently |
| 8 — Consolidated invoice | One existing final Factory invoice, cost and revenue bridge | Invoice total equals posted trips + approved adjustments; no repeated AR/charges/COGS |
| 9 — Reports and history | Trip and consolidated PDF/Excel/history | Identical frozen values across report, ledger and exports |
| 10 — Validation & controlled delivery | Local QA and deployment handoff | Evidence of balances, reversal safety, migrations, currency, permissions; **no CI** unless user later authorizes |

## 8. Phase 1 exit assessment

**Completed:** source-code audit, risk identification, data model, accounting/PO interface contract, cross-module guard map, delivery gates.  
**Not performed:** implementation, DB DDL, migrations, SQL execution, CI, tests, builds, merging, deployment.

**Key blockers for later phases:**
- Existing final invoice route and `syncFactoryInvoiceTx` would otherwise post customer AR and COGS again.
- Existing `CHARGE-PRE` suppression would hide premature charge journals; use explicit new trip posting identity.
- Current ERP PO importer does not carry arbitrary custom ledger-mapped charges.
- Normal physical dispatch reopening and invoice reversal are not aware of trip financial postings.
- Manual PO import has no automatic ERP receipt acknowledgment.

**SQL handoff policy:** Phase 1 needs **zero SQL to run in TablePlus**. Collect implementation-time manual schema SQL in one numbered, idempotent reviewed file to give the user **at the end of all phases**; never execute it on their production database or imply production readiness before the user applies it.
