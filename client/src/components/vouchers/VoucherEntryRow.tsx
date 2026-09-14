/**
 * One row of the voucher edit dialog's entries table.
 *
 * Extracted from VoucherEditDialog.tsx during the P1 god-file split. The row
 * owns the per-row display rules (hiding cash-source entries for
 * Payment/Receipt, re-parsing Consumption/Production narration, the
 * historical-rate badge) while all form state stays in the dialog.
 */

import { type UseFormReturn } from "react-hook-form";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { X } from "lucide-react";
import { parseConsumptionNarration } from "./voucherEditMapping";
import type { BankAccount, Employee, FixedAsset, LedgerAccount, Supplier, VoucherFormData } from "./voucherEditSchema";

interface VoucherEntryRowProps {
  form: UseFormReturn<VoucherFormData>;
  field: { id: string };
  index: number;
  fieldsLength: number;
  remove: (index: number) => void;
  ledgerAccounts: LedgerAccount[];
  bankAccounts: BankAccount[];
  suppliers: Supplier[];
  employees: Employee[];
  fixedAssets: FixedAsset[];
  formatAmount: (amount: number | string | null | undefined) => string;
}

export function VoucherEntryRow({
  form,
  field,
  index,
  fieldsLength,
  remove,
  ledgerAccounts,
  bankAccounts,
  suppliers,
  employees,
  fixedAssets,
  formatAmount,
}: VoucherEntryRowProps) {
  const voucherType = form.watch("voucherType");
  const debitAmount = parseFloat(form.watch(`entries.${index}.debitAmount`) || "0");
  const creditAmount = parseFloat(form.watch(`entries.${index}.creditAmount`) || "0");

  if (voucherType === "Payment" || voucherType === "Receipt") {
    // Hide entries where both amounts are 0 (empty/removed entries)
    if (debitAmount === 0 && creditAmount === 0) {
      return null;
    }
    // Hide cash source entries for Payment (credit entries with no debit)
    if (voucherType === "Payment" && creditAmount > 0 && debitAmount === 0) {
      return null;
    }
    // Hide cash source entries for Receipt (debit entries with no credit)
    if (voucherType === "Receipt" && debitAmount > 0 && creditAmount === 0) {
      return null;
    }
  }

  const isConsumptionOrProduction = voucherType === "Consumption" || voucherType === "Production";

  // For Consumption/Production, parse narration to extract item name, qty, and rate
  let itemName = "",
    qty = 0,
    rate = 0;
  if (isConsumptionOrProduction) {
    const narration = form.watch(`entries.${index}.narration`) || "";
    // Parse pattern: "Consumption of -1.000 x ITEM NAME @ $98.62"
    const parsed = parseConsumptionNarration(narration);
    if (parsed) {
      qty = parsed.qty;
      itemName = parsed.itemName;
      rate = parsed.rate;
    }
  }

  return (
    <tr key={field.id} className="border-b">
      {isConsumptionOrProduction ? (
        <>
          <td className="py-2 px-2">{itemName || "-"}</td>
          <td className="py-2 px-2 text-right font-mono">{qty.toFixed(3)}</td>
          <td className="py-2 px-2 text-right font-mono">{formatAmount(rate)}</td>
          <td className="py-2 px-2 text-right font-mono">{formatAmount(qty * rate)}</td>
        </>
      ) : (
        <>
          <td className="py-2 px-2">
            {/* Historical-rate info badge — shown for non-USD entries */}
            {(() => {
              const txCcy = form.watch(`entries.${index}.transactionCurrency`);
              const rate = form.watch(`entries.${index}.historicalExchangeRate`);
              if (!txCcy || txCcy === "USD" || !rate) return null;
              const txDebit = parseFloat(form.watch(`entries.${index}.transactionDebitAmount`) || "0");
              const txCredit = parseFloat(form.watch(`entries.${index}.transactionCreditAmount`) || "0");
              const txAmt = Math.max(txDebit, txCredit);
              const rateNum = parseFloat(rate);
              return (
                <div className="mb-1 flex items-center gap-1.5 text-xs text-muted-foreground bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-800 rounded px-2 py-0.5">
                  <span className="font-medium text-amber-700 dark:text-amber-400">{txCcy}</span>
                  {txAmt > 0 && <span>{txCcy === "CFA" ? Math.round(txAmt).toLocaleString() : txAmt.toFixed(2)}</span>}
                  {rateNum > 0 && (
                    <span className="text-muted-foreground">
                      @{" "}
                      {rateNum.toLocaleString(undefined, {
                        minimumFractionDigits: 2,
                        maximumFractionDigits: 4,
                      })}
                    </span>
                  )}
                  <span className="text-xs opacity-60">(historical)</span>
                </div>
              );
            })()}
            <div className="space-y-1">
              <Select
                value={
                  form.watch(`entries.${index}.ledgerAccountId`)?.toString() ||
                  form.watch(`entries.${index}.bankAccountId`)?.toString() ||
                  form.watch(`entries.${index}.supplierId`)?.toString() ||
                  form.watch(`entries.${index}.employeeId`)?.toString() ||
                  form.watch(`entries.${index}.fixedAssetId`)?.toString() ||
                  ""
                }
                onValueChange={(value) => {
                  const [type, id] = value.split("-");
                  form.setValue(`entries.${index}.ledgerAccountId`, null);
                  form.setValue(`entries.${index}.bankAccountId`, null);
                  form.setValue(`entries.${index}.supplierId`, null);
                  form.setValue(`entries.${index}.employeeId`, null);
                  form.setValue(`entries.${index}.fixedAssetId`, null);

                  if (type === "ledger") form.setValue(`entries.${index}.ledgerAccountId`, parseInt(id));
                  if (type === "bank") form.setValue(`entries.${index}.bankAccountId`, parseInt(id));
                  if (type === "supplier") form.setValue(`entries.${index}.supplierId`, parseInt(id));
                  if (type === "employee") form.setValue(`entries.${index}.employeeId`, parseInt(id));
                  if (type === "asset") form.setValue(`entries.${index}.fixedAssetId`, parseInt(id));
                }}
              >
                <SelectTrigger data-testid={`select-account-${index}`}>
                  <SelectValue placeholder="Select account" />
                </SelectTrigger>
                <SelectContent>
                  <div className="text-xs font-semibold px-2 py-1 text-muted-foreground">Ledger Accounts</div>
                  {ledgerAccounts.map((acc) => (
                    <SelectItem key={`ledger-${acc.id}`} value={`ledger-${acc.id}`}>
                      {acc.code} - {acc.name}
                    </SelectItem>
                  ))}
                  <div className="text-xs font-semibold px-2 py-1 text-muted-foreground mt-2">Bank Accounts</div>
                  {bankAccounts.map((acc) => (
                    <SelectItem key={`bank-${acc.id}`} value={`bank-${acc.id}`}>
                      {acc.accountNumber} - {acc.bankName}
                    </SelectItem>
                  ))}
                  <div className="text-xs font-semibold px-2 py-1 text-muted-foreground mt-2">Suppliers</div>
                  {suppliers.map((sup) => (
                    <SelectItem key={`supplier-${sup.id}`} value={`supplier-${sup.id}`}>
                      {sup.code} - {sup.name}
                    </SelectItem>
                  ))}
                  <div className="text-xs font-semibold px-2 py-1 text-muted-foreground mt-2">Employees</div>
                  {employees.map((emp) => (
                    <SelectItem key={`employee-${emp.id}`} value={`employee-${emp.id}`}>
                      {emp.code} - {emp.firstName} {emp.lastName}
                    </SelectItem>
                  ))}
                  <div className="text-xs font-semibold px-2 py-1 text-muted-foreground mt-2">Fixed Assets</div>
                  {fixedAssets.map((asset) => (
                    <SelectItem key={`asset-${asset.id}`} value={`asset-${asset.id}`}>
                      {asset.assetCode} - {asset.assetName}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </td>
          {voucherType === "Payment" || voucherType === "Receipt" ? (
            <td className="py-2 px-2">
              <Input
                type="number"
                step="0.01"
                value={
                  parseFloat(form.watch(`entries.${index}.debitAmount`) || "0") > 0
                    ? form.watch(`entries.${index}.debitAmount`)
                    : form.watch(`entries.${index}.creditAmount`) || ""
                }
                onChange={(e) => {
                  if (voucherType === "Payment") {
                    form.setValue(`entries.${index}.debitAmount`, e.target.value);
                    form.setValue(`entries.${index}.creditAmount`, "0");
                  } else {
                    form.setValue(`entries.${index}.creditAmount`, e.target.value);
                    form.setValue(`entries.${index}.debitAmount`, "0");
                  }
                }}
                className="text-right"
                data-testid={`input-amount-${index}`}
              />
            </td>
          ) : (
            <>
              <td className="py-2 px-2">
                <Input
                  type="number"
                  step="0.01"
                  {...form.register(`entries.${index}.debitAmount`)}
                  className="text-right"
                  data-testid={`input-debit-${index}`}
                  onKeyDown={(e) => {
                    if (e.key === "Tab") {
                      e.preventDefault();
                      const creditInput = document.querySelector(
                        `[data-testid="input-credit-${index}"]`
                      ) as HTMLInputElement;
                      if (creditInput) creditInput.focus();
                    }
                  }}
                />
              </td>
              <td className="py-2 px-2">
                <Input
                  type="number"
                  step="0.01"
                  {...form.register(`entries.${index}.creditAmount`)}
                  className="text-right"
                  data-testid={`input-credit-${index}`}
                  onKeyDown={(e) => {
                    if (e.key === "Tab") {
                      e.preventDefault();
                      const narrationInput = document.querySelector(
                        `[data-testid="input-narration-${index}"]`
                      ) as HTMLInputElement;
                      if (narrationInput) narrationInput.focus();
                    }
                  }}
                />
              </td>
              <td className="py-2 px-2">
                <Input {...form.register(`entries.${index}.narration`)} data-testid={`input-narration-${index}`} />
              </td>
            </>
          )}
        </>
      )}
      <td className="py-2 px-2 text-center">
        {fieldsLength > 1 && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={() => remove(index)}
            data-testid={`button-remove-entry-${index}`}
          >
            <X className="h-4 w-4" />
          </Button>
        )}
      </td>
    </tr>
  );
}
