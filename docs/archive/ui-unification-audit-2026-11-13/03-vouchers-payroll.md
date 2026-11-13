# 03 — Vouchers & Payroll UI unification audit

Scope: voucher entry / edit / detail screens for all company types, ERP payroll, and a pattern comparison against factory payroll.
All paths are relative to `client/src/`. Read-only audit; nothing in the repo was changed.
"Unverified" marks anything inferred but not confirmed by reading the code path end to end.

Key structural facts (verified):

- `factory/FactoryVouchers.tsx`, `properties/PropertiesVouchers.tsx`, `properties/PropertiesVoucherEdit.tsx`, `properties/PropertiesVoucherDetail.tsx` are 5-line pass-throughs to `pages/Vouchers.tsx`, `VoucherEdit.tsx`, `VoucherDetail.tsx`. Factory routes mount `VoucherEdit`/`VoucherDetail` directly (`components/FactoryRoutes.tsx:251-252`). So there is ONE voucher implementation; the per-company differences are `if` branches inside `Vouchers.tsx`.
- POS shell mounts the same `Vouchers` with `posUser` (`routes/PosRoutes.tsx:77`), which renders only the Stock Transfer form.
- Payroll is the opposite: ERP (`pages/payroll/**`, `components/erprunpayroll/**`) and Factory (`pages/factory/FactoryPayrollHub.tsx` and children) are two fully separate implementations of the same job. Properties has no payroll screen.

## Page inventory

| Page (file) | Route | Shell/Header | Tabs | Export/Print | Table | Filters | States | Notable issues |
|---|---|---|---|---|---|---|---|---|
| `pages/Vouchers.tsx` (ERP) | `/vouchers` | bare `div` + `PageHeader` "Vouchers" with a raw `<Link>` styled as a button | custom sidebar `VoucherDesktopNav` (raw `<button>`, inline hex colours) + phone sheet `VoucherMobileTabs`; URL-backed via `useHubQueryState("tab")` | per form (below) | per form | none | `ErrorState` for account load failure; no loading state | 817-line orchestrator; not `ErpPage`; nav is not the shared Tabs/PillTab |
| `factory/FactoryVouchers.tsx` | `/factory/vouchers` | same file; header is a hand-rolled `<h1>` block, no subtitle, no `PageHeader` (`Vouchers.tsx:552-558`) | same nav; transfer/order/adjustment/credit-note always hidden (`vouchers/factoryVoucherPolicy.ts`) | same | same | none | ad-hoc bordered `div` "No Voucher tabs are available" (`Vouchers.tsx:609-613`) | header differs from ERP for the same page |
| `properties/PropertiesVouchers.tsx` | `/properties/vouchers` | same as ERP (`PageHeader`) | all 7 tabs offered (no properties filter) | same | same | none | same | stock transfer / adjustment / credit note offered to a properties company (unverified whether intended) |
| POS `Vouchers posUser` | `/vouchers` in POS shell | `PageHeader` "Stock Transfer" + icon | none (single form) | Export dropdown (xlsx) | div grid | none | same | page titled "Stock Transfer" lives at `/vouchers` |
| Payment / Receipt tab — `components/vouchers/PaymentReceiptTab.tsx` (+`PaymentReceiptHeaderActions`, `VoucherEntriesTable`, `VoucherSourceCard`) | `/vouchers?tab=payment|receipt` | Card with coloured "hero" strip (inline gradient) | — | Print (react-to-print, `PrintTemplate`) + Export dropdown Summary/Detailed, ghost buttons in the HEADER strip | raw `<table>` (`VoucherEntriesTable.tsx:299`) | native `type="date"` ×2 | disabled-reason tooltip, save hint text, draft restore prompt | only form with Print, Ctrl/Cmd+Enter, sticky action bar, Switch for Optional |
| Journal tab — `vouchers/journalform/*` | `?tab=journal` | Card + custom CSS title block | — | Export dropdown "Summary Export/Detailed Export" in FOOTER, outline; no Print | raw `<table>` (`JournalEntriesEditor.tsx:285`) | native date ×2 (Eff. always visible) | draft restore; `window.confirm` for template mismatch (`useJournalFormModel.tsx:514`) | no shortcut, no print, Checkbox "Mark as Optional" |
| Stock Transfer tab — `vouchers/stock-transfer-form/*` | `?tab=transfer` (also POS) | no card title; inline header row | — | Export dropdown in footer; Import button in header; no Print | div grid rows | native date | none | "Save Transfer" + "Save as Revision"; Checkbox "Optional"; no draft |
| Retail Stock Transfer — `vouchers/stock-transfer-form/RetailVoucherTransferForm.tsx` | `?tab=transfer` (retail, new only) | inline `<span>` title "Retail Stock Transfer" | — | none | div rows | raw `<textarea>` | `Loader2` in Save | no Export, no Optional, no phone action bar, different toasts ("Transfer saved") |
| Transfer Order tab — `pages/StockTransferOrder.tsx` → `stock-transfer-order/*` | `?tab=transferorder` | own header component | — | own xlsx workbook export (`exportStockTransferOrderWorkbook.ts`) | matrix | — | own draft autosave | separate editor embedded as a voucher tab; own draft/revision/WhatsApp flows (owned by inventory auditor; listed for completeness) |
| Adjustment tab — `vouchers/stock-adjustment-form/*` | `?tab=adjustment` | Card, plain `<span>` title "Production / Consumption Voucher" | — | Export dropdown in footer; no Print | custom spreadsheet | native date | none | nav label "Adjustment" ≠ form title ≠ save label; no draft |
| Credit Note tab — `components/vouchers/CreditNoteTab.tsx` | `?tab=creditnote` | `Card`/`CardHeader`/`CardTitle` | — | none | shadcn `Table mobileLayout="cards"` | native date, shadcn Select | — | Save button in card HEADER, labelled "Create Note"/"Update Note" with a Plus icon; no Export, no Optional |
| `pages/VoucherEdit.tsx` + `voucher-edit/*EditForm.tsx` (6 forms) | `/vouchers/:id/edit`, `/factory/vouchers/:id/edit`, `/properties/vouchers/:id/edit` | `PageHeader` "Edit {type} Voucher" + back, then a Card that repeats the same title | — | none | raw `<table>` in all 6 | calendar popover date | `Skeleton`; error = ghost back icon + plain "Voucher not found" text | second, parallel edit UI — see finding 1 |
| `pages/VoucherDetail.tsx` | `/voucher-detail/:voucherId` (+ `/factory`, `/properties` prefixes) | `min-h-screen` div + `PageHeader`, title "No. {number}", subtitle "Accounting Voucher Alteration (Secondary)" | — | none (no Print, no Export) | shadcn `Table mobileLayout="cards"` | — | `Skeleton`; error = plain text + "Go Back" | read-only: no Edit / Print / Delete action; hard-coded type colours |
| `components/VoucherEditDialog.tsx` | (dialog in `Vouchers.tsx:767`) | Dialog "Edit Voucher" | — | — | raw `<table>` | — | — | never opened — dead (see Duplicates) |
| `pages/OptionalVouchers.tsx` + `optional-vouchers/OptionalVoucherDetailsDialog.tsx` | `/optional-vouchers` | `PageHeader` | — | none | shadcn `Table` (imports `ErpListTable` helpers) | native date ×2, Clear button | `Skeleton`; `ErpConfirmDialog` | `toLocaleString` for totals instead of `formatAmount`; edit routes to both edit UIs (`OptionalVouchers.tsx:164,166`) |
| `pages/Payroll.tsx` → `payroll/PayrollView.tsx` | `/payroll` (also `/factory/payroll`) | `flex h-full` div + `PageHeader` "Payroll Management" (no subtitle/icon) | shadcn `Tabs`, state in `useState` — NOT URL-backed (`payroll/usePayrollState.ts:7`) | — | — | — | — | tab state lost on refresh; factory hub is URL-backed |
| ERP Payroll › Employees — `payroll/EmployeesTab.tsx` | tab | 3 hand-rolled stat tiles | status segmented buttons | none | CSS-grid "table" + phone cards | ad-hoc `Input` + Search icon | ad-hoc empty blocks | search not `SearchField`; no export |
| ERP Payroll › Workers — `payroll/WorkersTab.tsx`, `WorkersTable.tsx` | tab | 3 hand-rolled stat tiles (emerald/amber tints) | status segmented buttons (different variant logic) | none | grid rows | `SearchField` | ad-hoc empty blocks with `<h3>` | filter order/all-caps differs from Employees |
| ERP Payroll › Advances + Deductions — `payroll/AdvancesTab.tsx` | tab | own `<h2>` title inside the tab | nested shadcn `Tabs defaultValue` (not URL-backed): Advances / Repayments / Worker Deductions | none | shadcn `Table mobileLayout="cards"` | shadcn Select ×2 | `Loader2` spinner | "Bulk Advance" and "Add Advance" open the same dialog (`AdvancesTab.tsx:450,454`) |
| ERP Payroll › Run Payroll — `components/ERPRunPayroll.tsx`, `erprunpayroll/*` | tab | — | nested Run / History: `PillTabButton` on step 1 (`CompactRunPayrollSelection.tsx:211`), `TabsTrigger` on other steps (`ERPRunPayrollView.tsx:219`) | per run row: Print (HTML popup + `window.print`) and Excel (direct `xlsx-js-style`, `useERPRunPayrollModel.ts:472-557`) as icon buttons | shadcn `Table` | ad-hoc search `Input`, native date | `Skeleton`; `AlertDialog` for delete/undo | two tab styles for the same tab bar; dead step-1 code |
| `factory/FactoryPayrollHub.tsx` | `/factory/payroll-hub?section=` | `PageHeader` "Payroll & Benefits" inside a gradient banner with CSS overrides | `PillTabButton` with gradient overrides; URL-backed | — | — | — | plain text when no sections | compare: ERP "Payroll Management" |
| `factory/FactoryWorkersHub.tsx` | `…?section=workers&tab=` | — | shadcn `Tabs` with gradient class overrides; URL-backed; 6 tabs | — | — | — | plain text | sub-tab style differs from `FactoryEmployeesHub` |
| `factory/FactoryEmployeesHub.tsx` | `…?section=employees&tab=` | — | shadcn `Tabs`, different gradient classes; URL-backed; 6 tabs | — | — | — | plain text | — |
| `factory/FactoryPayrollTab.tsx` + `factorypayrolltab/*` | workers › payroll | 5 hand-rolled stat tiles | — | PDF summary via server endpoint + `window.open` (`useFactoryPayroll.tsx:472-480`); xlsx blob download in preview dialog (`PayrollRunDialogs.tsx:507`) | shadcn `Table mobileLayout="cards"` | shadcn Select | `Skeleton`; confirms are plain `Dialog` | hard-coded `$` + `toFixed(2)` (`PayrollOverview.tsx:96,110,149`) |
| `factory/FactoryEmployeePayrollTab.tsx` | employees › payroll | — | — | none seen | shadcn `Table` | native date ×4 | `Skeleton`, `Loader2` | own `toLocaleString("en-US")` formatter (`:67`) |
| `factory/FactoryAdvancesTab.tsx`, `FactoryEmployeeAdvancesTab.tsx`, `FactoryEmployeeWithdrawalsTab.tsx`, `FactoryEmployeeBonusesTab.tsx`, `FactoryWorkerBonusesTab.tsx`, `FactoryWorkers.tsx`/`factoryworkers/*`, `FactoryEmployees.tsx` | hub tabs | — | `FactoryAdvancesTab`: shadcn Tabs Advances/Repayments/Deductions | workers roster: Template / Import / "Export Salaries" via `excelHelper` (`useFactoryWorkersModel.tsx:729`) | mixed | ad-hoc search inputs | mixed | pattern comparison only (factory auditor covers depth) |

## Inconsistency findings

### A. Voucher forms

1. **Two complete edit UIs for the same vouchers (plus a dead third).**
   - Route A: `/vouchers?edit=ID&tab=…` reuses the create forms (`pages/daybook/voucherEditRoute.ts:22-30`, `pages/Suppliers.tsx:84`, `pages/accountslegacy/FindVoucherTab.tsx:53`, `pages/factory/daybook/useFactoryDaybookModel.ts:624`, `pages/OptionalVouchers.tsx:164`).
   - Route B: `/vouchers/:id/edit` renders `VoucherEdit.tsx` with six separate `voucher-edit/*EditForm.tsx` (`pages/StockItemVouchers.tsx:112`, `pages/LocationVouchers.tsx:221`, `pages/location-inventory/StockMovementDialog.tsx:274`, `pages/OptionalVouchers.tsx:166`).
   - They differ in everything visible: date control (native `type="date"` vs calendar popover), save label ("Save Voucher · $x" / "Save Journal Voucher" / "Save Transfer" vs "Save Changes"), Cancel (phone-only vs always), Optional label ("Optional" / "Mark as Optional" vs "Optional (Does not affect books)"), account sidebar (present vs absent), Export/Print (present vs absent), journal totals wording ("Total Debit" vs "Total DR", `voucher-edit/JournalEditForm.tsx:242`).
   - Standard: one edit path — the `/vouchers?edit=` forms — and make `/vouchers/:id/edit` a redirect that maps voucher type to tab. Size L, risk medium-high (the Purchase and Sales edit forms exist only in route B; `tab=purchase`, `contra`, `purchase-order` in `voucherEditRoute.ts` are not tabs in `Vouchers.tsx:76-84`, behaviour unverified).

2. **Save button label, verb and icon differ per voucher type.**
   - `PaymentReceiptTab.tsx:770-773` "Save Voucher · {total}" / "Update Voucher · {total}" / "Post Payment · EUR x"; `JournalEntriesEditor.tsx:647` "Save Journal Voucher"; `StockTransferFooterAndDialogs.tsx:161` "Save Transfer"; `StockAdjustmentFormView.tsx:248` "Save Production/Consumption Voucher" (phone bar says "Save Voucher", `:255`); `CreditNoteTab.tsx:535` "Create Note"/"Update Note" with a Plus icon; edit forms "Save Changes".
   - Only Payment/Receipt and Credit Note switch to "Update…" in edit mode; Journal, Transfer and Adjustment say "Save…" when editing.
   - Pending text: "Saving…" (ellipsis char) vs "Saving..." (three dots) vs `Loader2` spinner (`RetailVoucherTransferForm.tsx:355`).
   - Standard: "Save {Type}" on create, "Update {Type}" on edit, one pending style via `FormSubmitButton`. Size S, risk low (test ids unchanged).

3. **Action bar placement differs per form.**
   - Payment/Receipt: sticky bottom bar with Lines/Total + Optional + Save, Print/Export in the header strip (`PaymentReceiptTab.tsx:675-787`, `:409-416`).
   - Journal / Transfer / Adjustment: non-sticky footer row with Export + Save (`JournalEntriesEditor.tsx:596-650`, `StockTransferFooterAndDialogs.tsx:127-176`, `StockAdjustmentFormView.tsx:210-251`).
   - Credit Note: Cancel + Save in the card header (`CreditNoteTab.tsx:522-537`).
   - Retail transfer: single right-aligned Save under the notes (`RetailVoucherTransferForm.tsx:348-358`).
   - Phones are already unified through `VoucherPhoneActionBar` (five forms) — except Payment/Receipt, which keeps its own bar, and the Retail transfer, which has none.
   - Standard: one `VoucherActionBar` (desktop sticky footer: totals left; Optional, Export, Print, Cancel, Save right) wrapping the existing phone bar. Size M, risk medium.

4. **Print exists on only one voucher type; Export missing on two.**
   - Print: Payment/Receipt only (`Vouchers.tsx:488-491`, `PrintTemplate`). Journal, Transfer, Adjustment, Credit Note: none. `VoucherDetail.tsx` (the posted-voucher view) has no Print or Export at all.
   - Export: Payment/Receipt, Journal, Transfer, Adjustment have Summary/Detailed xlsx; Credit Note and Retail transfer have none; none of the six `voucher-edit` forms has any.
   - Export control differs: ghost button in header with items "Summary"/"Detailed" (`PaymentReceiptHeaderActions.tsx:64-85`) vs outline button in footer with "Summary Export"/"Detailed Export" (`JournalEntriesEditor.tsx:616-637`, `StockTransferFooterAndDialogs.tsx:128-149`).
   - Four hand-written copies of the same summary/detailed export: `vouchers/voucherActions.ts:26-80`, `journalform/useJournalFormModel.tsx:597-652`, `stock-transfer-form/useStockTransferFormModel.ts:~636-690`, `stock-adjustment-form/useStockAdjustmentFormModel.ts:~303-357`. File names are consistent (`{Type}_{Summary|Detailed}_{date}.xlsx`) and all use `@/lib/excelHelper`.
   - Standard: one shared export/print menu for every voucher form and for `VoucherDetail`; one `exportVoucherWorkbook()` helper. Size M, risk low.

5. **Keyboard shortcuts are inconsistent.**
   - Ctrl/Cmd+Enter save and the on-screen hint exist only in Payment/Receipt (`PaymentReceiptTab.tsx:233-238`, `:781-784`). No other voucher form has a save shortcut.
   - Esc-to-go-back exists on `VoucherEdit.tsx:68` and `VoucherDetail.tsx:141` but not on `/vouchers?edit=`.
   - Row navigation differs: arrow keys + Tab/Enter in payment (`vouchers/keyboardHandlers.ts`), Enter/Tab only in adjustment (`AdjustmentSpreadsheet.tsx:174,223,258`).
   - Standard: one `useVoucherShortcuts` hook (Ctrl/Cmd+Enter save, Esc cancel when editing) used by all forms, with the same hint. Size S-M, risk low.

6. **"Optional" control differs.** Switch "Optional" (`PaymentReceiptTab.tsx:711-723`), Checkbox "Mark as Optional" (`JournalEntriesEditor.tsx:601-612`, `StockAdjustmentFormView.tsx:194-205`), Checkbox "Optional" (`StockTransferFooterAndDialogs.tsx:112-125`), Switch "Optional (Does not affect books)" saved immediately via its own mutation (`voucher-edit/PurchaseEditForm.tsx:94-99`). Credit Note has none. Standard: one control and label. Size S, risk low.

7. **Form header / title treatment differs per type.** Gradient hero strip with icon tile, "Editing" badge and `#number` (`PaymentReceiptTab.tsx:308-350`); CSS-class title block with `<strong>` (`JournalFormView.tsx:61-71`); plain `<span>` (`StockAdjustmentFormView.tsx:46-48`, `RetailVoucherTransferForm.tsx:227-229`); `CardTitle` with icon (`CreditNoteTab.tsx:508-520`); no title at all for the standard Stock Transfer form. Edit-mode indication exists only in Payment/Receipt and Credit Note. Standard: one `VoucherFormHeader` (icon, title, voucher number, Editing badge, date fields). Size M, risk low.

8. **Naming of the same voucher type.** Nav "Adjustment" (`vouchers/voucherSidebarGroups.ts:35`) → form title "Production / Consumption Voucher" → button "Save Production/Consumption Voucher" → edit page "Edit {Consumption|Production|Mixed} Voucher" with description "Update stock adjustment details" (`voucher-edit/AdjustmentEditForm.tsx:55-56`) → toast "Adjustment voucher updated". Nav group "Adjustments" also holds Stock Transfer, Transfer Order and Credit Note. Nav "Stock Transfer" vs retail title "Retail Stock Transfer" vs POS page title "Stock Transfer". Standard: pick one name per type and use it in nav, title, button, toast and export file name. Size S, risk low.

9. **Date inputs.** Native `Input type="date"` in all create forms (`PaymentReceiptTab.tsx:361`, `JournalFormView.tsx:102`, `StockTransferHeader.tsx:117`, `StockAdjustmentFormView.tsx:91`, `CreditNoteTab.tsx:572`) vs calendar popover in all `voucher-edit` forms; `date-picker-input` is used by none. Effective date: hidden behind "+ Effective date" in payment (`PaymentReceiptTab.tsx:383-406`), always visible in journal (`JournalFormView.tsx:124-134`), absent elsewhere. Standard: `date-picker-input` everywhere, one Effective-date pattern. Size M, risk low-medium.

10. **Draft autosave coverage.** Payment/Receipt (`Vouchers.tsx:293`) and Journal (`useJournalFormModel.tsx:280`) have `useFormDraft` + `DraftRestorePrompt`; Stock Transfer, Adjustment, Credit Note do not (Transfer Order has its own). Size S per form, risk low.

11. **Confirm dialogs.** Native `window.confirm` in `vouchers/useVoucherFxWalletPayment.ts:284` and `journalform/useJournalFormModel.tsx:514`; raw `AlertDialog` elsewhere. The WhatsApp-statement prompt is duplicated verbatim in `Vouchers.tsx:787-814` and `journalform/JournalFormDialogs.tsx:42-69`. Standard: `confirmAction` (ConfirmHost) or one shared dialog. Size S, risk low.

12. **Vouchers page header differs by company type in the same file.** ERP/Properties `PageHeader` with subtitle (`Vouchers.tsx:541`), Factory hand-rolled `<h1>` with no subtitle (`:552-558`), POS `PageHeader` with icon (`:535-539`). "Optional voucher drafts" is a raw `<Link>` with button classes (`:543-549`) instead of `Button asChild`. None uses `ErpPage`/`PageShell`. Size S, risk low.

13. **Voucher type navigation is a bespoke component.** `vouchers/VoucherTabNav.tsx` uses raw `<button>` elements with inline `style` hex colours (`#3b82f6`, `#f59e0b` from `voucherSidebarGroups.ts`), not `Tabs`/`PillTabButton`. It is URL-backed. Standard: keep the sidebar layout but build it on the shared tab primitive and theme tokens. Size M, risk low.

14. **Status/type colours are hand-rolled.** `VoucherDetail.tsx:117-125` (`bg-red-500`, `bg-green-500`…), `:98-104` approval badges, `:240` `text-blue-600`; a separate `transactionjournal/components/VoucherTypeBadge.tsx` exists; DR/CR pills in `JournalEntriesEditor.tsx:328-329`; `StatusBadge` is used nowhere in scope (0 hits). Size S-M, risk low.

15. **Entry tables.** Raw `<table>` in payment (`VoucherEntriesTable.tsx:299`), journal (`JournalEntriesEditor.tsx:285`) and all six edit forms; div grids in transfer/adjustment; shadcn `Table mobileLayout="cards"` in Credit Note and `VoucherDetail`. Acceptable for spreadsheet-style entry, but the six edit-form tables are near copies. Size M, risk medium.

16. **Number formatting.** Mostly `formatAmount`; exceptions: `total.toFixed(2)` in the save label and hero total (`PaymentReceiptTab.tsx:542,772`), `toLocaleString` in `OptionalVouchers.tsx:249,321,382`, credit-note summary uses `formatNumber` for a money value (`CreditNoteTab.tsx:823`). Size S, risk low.

17. **`VoucherDetail` is a dead end.** Subtitle "Accounting Voucher Alteration (Secondary)" although the page is read-only; no Edit, Print, Export or Delete; error state is plain text. The Daybook's `daybook/VoucherDetailsDialog.tsx` shows the same data in a dialog with its own actions. Standard: one voucher view with a standard action set. Size M, risk low.

### B. Payroll (ERP vs Factory)

18. **Two separate payroll products.** ERP: `/payroll` "Payroll Management", tabs Employees / Workers / Advances + Deductions / Run Payroll. Factory: `/factory/payroll-hub` "Payroll & Benefits", sections Workers / Employees / Insurance, each with sub-tabs (Workers: Workers, Payroll, Attendance, Report, Advances, Bonuses; Employees: Employees, Payroll, Attendance, Advances, Bonuses, Withdrawals). Order (Employees-first vs Workers-first), names ("Advances + Deductions" vs "Advances") and nesting all differ. `/factory/payroll` additionally mounts the ERP `Payroll` inside factory (`components/FactoryRoutes.tsx:254`); no nav link to it was found (unverified whether reachable). Standard: one hub skeleton and one tab vocabulary. Size L, risk high.

19. **Tab mechanics.** ERP top tabs use `useState` (`payroll/usePayrollState.ts:7`), nested Advances tabs use `defaultValue` (`AdvancesTab.tsx:385`), Run/History uses `useState` (`erprunpayroll/useERPRunPayrollModel.ts:27`) — none URL-backed. Factory uses `useHubQueryState` at every level (`FactoryPayrollHub.tsx:42`, `FactoryWorkersHub.tsx:86`, `FactoryEmployeesHub.tsx:39`). Run Payroll's own tab bar switches between `PillTabButton` (`CompactRunPayrollSelection.tsx:211-231`) and `TabsTrigger` (`ERPRunPayrollView.tsx:219-232`) depending on the step. Factory styles each level differently with gradient overrides (`FactoryPayrollHub.tsx:90-96`, `FactoryWorkersHub.tsx:109`, `FactoryEmployeesHub.tsx:67-73`). Standard: `useHubQueryState` + unstyled shared pill tabs. Size S for ERP, risk low.

20. **Run Payroll flow.** ERP: inline 2-step wizard (select → preview → "save draft" → pay from History) with Run/History tabs. Factory: "Run Payroll" button opens dialogs (`PayrollRunDialogs.tsx:48,189`), results are grouped batches with expandable rows. Row actions differ: ERP icon buttons Print / Excel / Pay / Delete / Undo (`ERPRunPayrollView.tsx:498-552`), factory Review bonus / Generate entry / Undo / Delete (`BatchRow.tsx:243-306`). Size L, risk high.

21. **Payroll export/print — four mechanisms.** ERP run: client-built HTML popup + `window.print()` (`useERPRunPayrollModel.ts:367-461`) and direct `xlsx-js-style` import (`:472-557`, bypasses `@/lib/excelHelper`; file `payroll-{id}-{date}.xlsx`). ERP bulk bonus: another HTML popup (`payroll/usePayrollModel.tsx:676`). Factory: server PDF via `window.open` (`useFactoryPayroll.tsx:472-480`) and blob download `Payroll_{start}_{end}.xlsx` (`PayrollRunDialogs.tsx:507`); roster `workers-salaries-{date}.xlsx` via `excelHelper`. ERP Employees / Workers / Advances lists and the Employee Statement dialog have no export. None uses `ErpReportExportMenu`. Size M, risk low-medium.

22. **Confirmation patterns — four in ERP payroll alone.** `ConfirmationDialog` (`EmployeesTab.tsx:427`, `WorkersTable.tsx:125`, `WorkersTab.tsx:365`), `confirmAction` from ConfirmHost (`AdvancesTab.tsx:347`, `usePayrollModel.tsx:1`, `usePayrollWorkerMutations.tsx:1`), raw `AlertDialog` (`ERPRunPayrollView.tsx:686,713`, `EmployeeCrudDialogs.tsx`, `WorkerDialogs.tsx`). Factory payroll uses plain `Dialog` for Undo/Delete (`PayrollPaymentDialogs.tsx:354,383,421`). Standard: one confirm primitive. Size M, risk low.

23. **Money formatting.** ERP payroll uses `formatAmount` throughout (102 hits). Factory payroll hard-codes `$` + `toFixed(2)` / `toLocaleString("en-US")` (`PayrollOverview.tsx:96,110,149`, `FactoryEmployeePayrollTab.tsx:67`; 0 `formatAmount` hits across the factory payroll files checked). Size M, risk medium (currency behaviour).

24. **KPI tiles.** Hand-rolled tiles in `EmployeesTab.tsx:110-145`, `WorkersTab.tsx:~165-205` (coloured tints) and `factorypayrolltab/components/PayrollOverview.tsx:58-115` (indigo/amber/emerald tints); none uses `StatCard`/`KPICard`/`FactoryKpiCard`. Size S, risk low.

25. **Search and status filter differ between sibling tabs.** Employees: ad-hoc `Input` + icon, filter order Active / Inactive / All, ghost buttons (`EmployeesTab.tsx:148-176`). Workers: `SearchField`, order all / active / inactive, lower-case + `capitalize`, secondary variant (`WorkersTab.tsx:210-232`). Run Payroll: another ad-hoc search (`ERPRunPayrollView.tsx:241-249`). Factory: ad-hoc inputs (`FactoryWorkersRosterPanel.tsx:193`, `FactoryEmployees.tsx:344`). Size S, risk low.

26. **Add/New and Save labels.** "New Employee" (default button) vs "New Worker" (outline) in ERP (`EmployeesTab.tsx:270-278`, `WorkersTab.tsx:279-282`); factory "Add Worker" (`FactoryWorkersRosterPanel.tsx:290`) vs "New Employee" (`FactoryEmployees.tsx:371`). Edit dialogs: "Update Worker" (`WorkerDialogs.tsx:365`) vs "Save Changes" (`EditEmployeeDialog.tsx:652`). "Submit Repayment" (`AdvancesTab.tsx:857`) vs factory "Record Repayment" (`FactoryEmployeeAdvancesTab.tsx:557`). Pending: `FormSubmitButton pendingLabel` in three dialogs, manual "Processing..." / "Saving..." / `Loader2` elsewhere. Size S, risk low.

27. **Row actions.** Employees: Deposit/Bonus/Withdraw dropdown + separate edit and delete icon buttons (`EmployeesTab.tsx:382-430`); Workers: "…" dropdown (`WorkersTable.tsx:93-114`) + delete; Advances: three coloured icon buttons with `title` only (`AdvancesTab.tsx:313-355`, `text-blue-500`, `text-green-600`). Standard: `ErpRecordAction` or one dropdown pattern. Size S-M, risk low.

28. **Loading states.** `Loader2` full-area spinner in `AdvancesTab.tsx:274-277,514-516,572-574`; `Skeleton` in Run Payroll and factory payroll; no loading state for Employees/Workers lists. `page-state` components are used nowhere in payroll. Size S, risk low.

29. **Permission gating.** Payroll (both) gates with `useExistingRecordChangeAccess` / `canCreate`; voucher forms have no client-side gating at all (0 hits) beyond tab visibility. Noted only; may be intentional (unverified).

30. **i18n.** Factory hub subtitle is translated (`FactoryPayrollHub.tsx:73`), tab labels and all ERP payroll and voucher strings are hard-coded English.

## Duplicates / dead candidates

- `components/VoucherEditDialog.tsx` (452 lines): only importer is `Vouchers.tsx:12`; `editDialogOpen` starts `false` and `setEditDialogOpen` is only ever called from the dialog's own `onOpenChange` (`Vouchers.tsx:127,225,771`), so it can never open. Dead. A different `pages/daybook/VoucherEditDialog.tsx` is the live one.
- `voucher-edit/*EditForm.tsx` (6 files, ~2,600 lines) duplicate the create forms' edit mode (finding 1). `SalesEditForm` is effectively unreachable: `VoucherEdit.tsx:90-94` redirects Sales to `/pos/edit/:id`.
- `erprunpayroll/ERPRunPayrollView.tsx` step-1 branch and `renderGroup` (~`:120-195`, `:237-300`): `components/ERPRunPayroll.tsx:10-12` always renders `CompactRunPayrollSelection` for run/step 1, so this branch never renders.
- `payroll/AddWorkerDeductionDialog.tsx` vs `WorkerDeductionDialog` in `payroll/PayrollDialogs.tsx`: two "Save Deduction" dialogs for the same action.
- `AdvancesTab.tsx:450-457`: "Bulk Advance" and "Add Advance" buttons call the same `setAdvanceDialogOpen(true)`.
- `components/vouchers/PaymentVoucherTab.tsx` and `ReceiptVoucherTab.tsx`: one-line re-exports of `PaymentReceiptTab`; `Vouchers.tsx:614-731` then repeats ~55 identical props twice.
- Transaction-rate bar duplicated: `vouchers/PaymentDraftAndRateBar.tsx:41-56` and `journalform/JournalFormView.tsx:39-56`.
- Folder-name twins: `vouchers/stockadjustmentform/` vs `stock-adjustment-form/`, `vouchers/stocktransferform/` vs `stock-transfer-form/`, `pages/stocktransferorder/` vs `pages/stock-transfer-order/` (the squashed ones hold only `types.ts`/`utils.ts`).
- Thin wrappers `factory/FactoryVouchers.tsx`, `properties/PropertiesVouchers.tsx`, `PropertiesVoucherEdit.tsx`, `PropertiesVoucherDetail.tsx`: could be routed directly as Factory already does for edit/detail.
- `/factory/payroll` → ERP `Payroll` (`FactoryRoutes.tsx:254`): legacy candidate next to `/factory/payroll-hub` (unverified whether still linked).
- Four copies of the Summary/Detailed xlsx export (finding 4).

## Quick wins (mechanical, low-risk)

1. Delete `components/VoucherEditDialog.tsx` and its state in `Vouchers.tsx`.
2. Delete the dead step-1 branch in `ERPRunPayrollView.tsx`; use one tab component for Run/History.
3. Unify save labels and pending text across voucher forms; add "Update …" in edit mode for Journal/Transfer/Adjustment.
4. One Optional control and label.
5. Rename "Adjustment" consistently (nav, title, button, toast).
6. Use `PageHeader` for the factory branch of `Vouchers.tsx`; replace the raw `<Link>` with `Button asChild`.
7. Add the Ctrl/Cmd+Enter save shortcut and hint to Journal, Transfer, Adjustment, Credit Note.
8. Move ERP payroll tabs (top level, Advances sub-tabs, Run/History) to `useHubQueryState`.
9. `SearchField` in `EmployeesTab` and Run Payroll; same status-filter order and variant in Employees and Workers.
10. Replace both `window.confirm` calls; extract the duplicated WhatsApp prompt and transaction-rate bar.
11. Remove one of the two "Advance" buttons or give "Bulk Advance" its own flow; merge the two worker-deduction dialogs.
12. Route the ERP payroll Excel export through `@/lib/excelHelper`.
13. Replace `toLocaleString` in `OptionalVouchers.tsx` and `toFixed` in voucher totals with `formatAmount`.
14. Merge the squashed type/utils folders into their hyphenated siblings.
15. Fix `VoucherDetail` subtitle; use `ErrorState` for its and `VoucherEdit`'s error views.

## Bigger refactors

1. Collapse the two voucher edit paths into one (finding 1), including a decision on Purchase and Sales edit.
2. Shared `VoucherFormHeader` + `VoucherActionBar` + `useVoucherShortcuts` + one export/print menu used by all seven voucher types and by `VoucherDetail` (findings 3, 4, 5, 7).
3. Add Print to every voucher type and to `VoucherDetail` from a generic `PrintTemplate`.
4. Extend draft autosave to Transfer, Adjustment and Credit Note.
5. One payroll hub skeleton for ERP and Factory: same section names and order, same tab primitive, same KPI tile, same run flow and row actions, one confirm primitive, one export/print mechanism (findings 18-22, 24).
6. Factory payroll money formatting through the currency context instead of hard-coded `$` (finding 23).
7. Break up the `PayrollView` prop-drilling (about 200 model fields passed through one view) when the tabs are rebuilt.
