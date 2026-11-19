// Extracted from ./VoucherEditDialog.tsx
import { Plus, X } from "lucide-react";
import { UseFormReturn, FieldArrayWithId } from "react-hook-form";
import { Button } from "@/components/ui/button";
import { FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { AccountCombobox } from "./AccountCombobox";
import { Voucher, EditVoucherForm, LedgerAccount, BankAccount, Supplier, Employee, FixedAsset } from "./types";

export interface VoucherEditDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  voucherToEdit: Voucher | null;
  entriesLoading: boolean;
  editForm: UseFormReturn<EditVoucherForm>;
  editFields: FieldArrayWithId<EditVoucherForm, "entries", "id">[];
  editAppend: (v: EditVoucherForm["entries"][number]) => void;
  editRemove: (index: number) => void;
  handleSaveEdit: (data: EditVoucherForm) => void;
  editMutationPending: boolean;
  ledgerAccounts: LedgerAccount[];
  bankAccounts: BankAccount[];
  suppliers: Supplier[];
  employees: Employee[];
  fixedAssets: FixedAsset[];
  formatAmount: (amt: number | string | null | undefined) => string;
}

export function VoucherEditDialogContent({
  bankAccounts,
  editAppend,
  editFields,
  editForm,
  editRemove,
  employees,
  fixedAssets,
  formatAmount,
  ledgerAccounts,
  suppliers,
}: Pick<
  VoucherEditDialogProps,
  | "bankAccounts"
  | "editAppend"
  | "editFields"
  | "editForm"
  | "editRemove"
  | "employees"
  | "fixedAssets"
  | "formatAmount"
  | "ledgerAccounts"
  | "suppliers"
>) {
  return (
    <div className="border rounded-md p-4 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold">Voucher Entries</h3>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() =>
            editAppend({
              accountType: "ledger",
              accountId: 0,
              accountName: "",
              debitAmount: "0",
              creditAmount: "0",
              narration: "",
            })
          }
          data-testid="button-edit-add-entry"
          className="gap-1"
        >
          <Plus className="w-4 h-4" />
          Add Entry
        </Button>
      </div>

      {editFields.map((field, index) => (
        <div key={field.id} className="border rounded-md p-4 space-y-3">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-medium text-muted-foreground">Entry {index + 1}</span>
            {editFields.length > 2 && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => editRemove(index)}
                data-testid={`button-edit-remove-entry-${index}`}
              >
                <X className="w-4 h-4" />
              </Button>
            )}
          </div>

          <FormField
            control={editForm.control}
            name={`entries.${index}.accountType`}
            render={({ field: typeField }) => (
              <FormItem>
                <FormLabel>Account</FormLabel>
                <FormControl>
                  <AccountCombobox
                    value={
                      editForm.watch(`entries.${index}.accountId`)
                        ? {
                            type: typeField.value,
                            id: editForm.watch(`entries.${index}.accountId`),
                            name: editForm.watch(`entries.${index}.accountName`),
                          }
                        : null
                    }
                    onChange={(type, id, name) => {
                      editForm.setValue(`entries.${index}.accountType`, type);
                      editForm.setValue(`entries.${index}.accountId`, id);
                      editForm.setValue(`entries.${index}.accountName`, name);
                    }}
                    ledgerAccounts={ledgerAccounts}
                    bankAccounts={bankAccounts}
                    suppliers={suppliers}
                    employees={employees}
                    fixedAssets={fixedAssets}
                    rowIndex={index}
                    testIdPrefix="button-edit-account"
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          {editForm.watch("voucherType") === "Payment" || editForm.watch("voucherType") === "Receipt" ? (
            <FormItem>
              <FormLabel>Amount</FormLabel>
              <FormControl>
                <Input
                  type="number"
                  step="0.01"
                  min="0"
                  className="font-mono"
                  data-testid={`input-edit-amount-${index}`}
                  value={
                    parseFloat(editForm.watch(`entries.${index}.debitAmount`) || "0") > 0
                      ? editForm.watch(`entries.${index}.debitAmount`)
                      : editForm.watch(`entries.${index}.creditAmount`) || ""
                  }
                  onChange={(e) => {
                    const voucherType = editForm.watch("voucherType");
                    if (voucherType === "Payment") {
                      editForm.setValue(`entries.${index}.debitAmount`, e.target.value);
                      editForm.setValue(`entries.${index}.creditAmount`, "0");
                    } else {
                      editForm.setValue(`entries.${index}.creditAmount`, e.target.value);
                      editForm.setValue(`entries.${index}.debitAmount`, "0");
                    }
                  }}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          ) : (
            <>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <FormField
                  control={editForm.control}
                  name={`entries.${index}.debitAmount`}
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Debit Amount</FormLabel>
                      <FormControl>
                        <Input
                          {...field}
                          type="number"
                          step="0.01"
                          min="0"
                          className="font-mono"
                          data-testid={`input-edit-debit-${index}`}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={editForm.control}
                  name={`entries.${index}.creditAmount`}
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Credit Amount</FormLabel>
                      <FormControl>
                        <Input
                          {...field}
                          type="number"
                          step="0.01"
                          min="0"
                          className="font-mono"
                          data-testid={`input-edit-credit-${index}`}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              <FormField
                control={editForm.control}
                name={`entries.${index}.narration`}
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Narration (Optional)</FormLabel>
                    <FormControl>
                      <Input {...field} placeholder="Enter narration" data-testid={`input-edit-narration-${index}`} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </>
          )}
        </div>
      ))}

      {editForm.watch("entries") && editForm.watch("entries").length > 0 && (
        <div className="mt-4 pt-4 border-t">
          {editForm.watch("voucherType") === "Payment" || editForm.watch("voucherType") === "Receipt" ? (
            <div className="text-right text-sm font-mono">
              <span className="text-muted-foreground mr-2">Total:</span>
              <span className="font-bold">
                $
                {formatAmount(
                  Math.max(
                    editForm.watch("entries").reduce((sum, e) => sum + parseFloat(e?.debitAmount || "0"), 0),
                    editForm.watch("entries").reduce((sum, e) => sum + parseFloat(e?.creditAmount || "0"), 0)
                  )
                )}
              </span>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm font-mono">
              <div className="text-right">
                <span className="text-muted-foreground mr-2">Total Debits:</span>
                <span className="font-bold">
                  $
                  {formatAmount(
                    editForm.watch("entries").reduce((sum, e) => sum + parseFloat(e?.debitAmount || "0"), 0)
                  )}
                </span>
              </div>
              <div className="text-right">
                <span className="text-muted-foreground mr-2">Total Credits:</span>
                <span className="font-bold">
                  $
                  {formatAmount(
                    editForm.watch("entries").reduce((sum, e) => sum + parseFloat(e?.creditAmount || "0"), 0)
                  )}
                </span>
              </div>
            </div>
          )}
          {editForm.formState.errors.entries && (
            <p className="text-sm text-destructive mt-2 text-center">{editForm.formState.errors.entries.message}</p>
          )}
        </div>
      )}
    </div>
  );
}
