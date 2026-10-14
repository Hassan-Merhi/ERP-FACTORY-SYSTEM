import type { useFactorySuppliersModel } from "./useFactorySuppliersModel";

type FactorySuppliersModel = ReturnType<typeof useFactorySuppliersModel>;
import { SupplierFormDialog } from "./SupplierFormDialog";
import { SupplierOtherDialogs } from "./SupplierOtherDialogs";
import { SupplierPaymentFxDialogs } from "./SupplierPaymentFxDialogs";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SupplierWithBalance, BulkFxPreview } from "./factorySupplierTypes";
import { FactorySupplier } from "@shared/schema";
import { UseMutationResult } from "@tanstack/react-query";
import { Layers } from "lucide-react";

interface SupplierDialogsProps {
  createOpen: boolean;
  setCreateOpen: (val: boolean) => void;
  editingSupplier: FactorySupplier | null;
  setEditingSupplier: (val: FactorySupplier | null) => void;
  formData: {
    name: string;
    contactPerson: string;
    phone: string;
    email: string;
    address: string;
    notes: string;
    parentId: number | null;
  };
  setFormData: React.Dispatch<
    React.SetStateAction<{
      name: string;
      contactPerson: string;
      phone: string;
      email: string;
      address: string;
      notes: string;
      parentId: number | null;
    }>
  >;
  formRole: "broker" | "standalone" | "linked";
  setFormRole: (val: "broker" | "standalone" | "linked") => void;
  allSuppliers: SupplierWithBalance[];
  createSubAccountParentId: number | null;
  setCreateSubAccountParentId: (val: number | null) => void;
  createMutation: FactorySuppliersModel["createMutation"];
  updateMutation: FactorySuppliersModel["updateMutation"];
  resetForm: () => void;

  paymentDialogSupplier: SupplierWithBalance | null;
  setPaymentDialogSupplier: (val: SupplierWithBalance | null) => void;
  paymentForm: {
    supplierId: number;
    date: string;
    amount: string;
    currencyCode: string;
    fxRateToUsd: string;
    paidFromAccountId: string;
    notes: string;
    effectiveDate: string;
  };
  setPaymentForm: React.Dispatch<
    React.SetStateAction<{
      supplierId: number;
      date: string;
      amount: string;
      currencyCode: string;
      fxRateToUsd: string;
      paidFromAccountId: string;
      notes: string;
      effectiveDate: string;
    }>
  >;
  ledgerAccounts: NoInfer<{ id: number; name: string; code: string }[]> | undefined;
  paymentMutation: FactorySuppliersModel["paymentMutation"];
  paymentAmtUsd: number;
  paymentBalanceUsd: number;
  isOverpayment: boolean;
  overpaymentUsd: number;

  fxConversionOpen: boolean;
  setFxConversionOpen: (val: boolean) => void;
  fxConversionForm: {
    fromSupplierId: number;
    toSupplierId: number;
    selectedCurrency: string;
    amount: string;
    availableBalance: string;
    supplierBalance: string;
    commissionBalance: string;
    fxRateToUsd: string;
    date: string;
    notes: string;
    effectiveDate: string;
  };
  setFxConversionForm: React.Dispatch<
    React.SetStateAction<{
      fromSupplierId: number;
      toSupplierId: number;
      selectedCurrency: string;
      amount: string;
      availableBalance: string;
      supplierBalance: string;
      commissionBalance: string;
      fxRateToUsd: string;
      date: string;
      notes: string;
      effectiveDate: string;
    }>
  >;
  fxSourceType: "supplier" | "commission" | "both";
  setFxSourceType: (val: "supplier" | "commission" | "both") => void;
  fxConversionMutation: FactorySuppliersModel["fxConversionMutation"];
  wrapAdminAction: (fn: () => void, title: string) => void;

  bulkFxOpen: boolean;
  setBulkFxOpen: (val: boolean) => void;
  bulkFxBrokerId: number | null;
  bulkFxBrokerName: string;
  bulkFxForm: {
    fromCurrencyCode: string;
    totalAmount: string;
    fxRateToUsd: string;
    date: string;
    notes: string;
    order: "oldest" | "newest";
  };
  setBulkFxForm: React.Dispatch<
    React.SetStateAction<{
      fromCurrencyCode: string;
      totalAmount: string;
      fxRateToUsd: string;
      date: string;
      notes: string;
      order: "oldest" | "newest";
    }>
  >;
  bulkFxPreview: BulkFxPreview | null;
  setBulkFxPreview: (val: BulkFxPreview | null) => void;
  bulkFxPreviewMutation: UseMutationResult<BulkFxPreview, Error, void, unknown>;
  bulkFxMutation: FactorySuppliersModel["bulkFxMutation"];
  obEditSupplier: { id: number; name: string; currentBalance: string } | null;
  setObEditSupplier: React.Dispatch<React.SetStateAction<{ id: number; name: string; currentBalance: string } | null>>;
  obEditValue: string;
  setObEditValue: (val: string) => void;
  obEditMutation: FactorySuppliersModel["obEditMutation"];
  dueDialogSupplier: FactorySuppliersModel["dueDialogSupplier"];
  setDueDialogSupplier: FactorySuppliersModel["setDueDialogSupplier"];
  formatDate: (val: string) => string;
  formatNum: (val: string) => string;

  editObComm: null | { rawStockId: number; amount: string; currencyCode: string; personName: string; notes: string };
  setEditObComm: React.Dispatch<
    React.SetStateAction<{
      rawStockId: number;
      amount: string;
      currencyCode: string;
      personName: string;
      notes: string;
    } | null>
  >;
  updateObCommissionMutation: FactorySuppliersModel["updateObCommissionMutation"];
}

export function SupplierDialogs({
  createOpen,
  setCreateOpen,
  editingSupplier,
  setEditingSupplier,
  formData,
  setFormData,
  formRole,
  setFormRole,
  allSuppliers,
  createSubAccountParentId,
  setCreateSubAccountParentId,
  createMutation,
  updateMutation,
  resetForm,
  paymentDialogSupplier,
  setPaymentDialogSupplier,
  paymentForm,
  setPaymentForm,
  ledgerAccounts,
  paymentMutation,
  paymentAmtUsd,
  paymentBalanceUsd,
  isOverpayment,
  overpaymentUsd,
  fxConversionOpen,
  setFxConversionOpen,
  fxConversionForm,
  setFxConversionForm,
  fxSourceType,
  setFxSourceType,
  fxConversionMutation,
  wrapAdminAction,
  bulkFxOpen,
  setBulkFxOpen,
  bulkFxBrokerName,
  bulkFxForm,
  setBulkFxForm,
  bulkFxPreview,
  setBulkFxPreview,
  bulkFxPreviewMutation,
  bulkFxMutation,
  obEditSupplier,
  setObEditSupplier,
  obEditValue,
  setObEditValue,
  obEditMutation,
  dueDialogSupplier,
  setDueDialogSupplier,
  formatDate,
  formatNum,
  editObComm,
  setEditObComm,
  updateObCommissionMutation,
}: SupplierDialogsProps) {
  return (
    <>
      <SupplierFormDialog
        createOpen={createOpen}
        setCreateOpen={setCreateOpen}
        editingSupplier={editingSupplier}
        setEditingSupplier={setEditingSupplier}
        formData={formData}
        setFormData={setFormData}
        formRole={formRole}
        setFormRole={setFormRole}
        allSuppliers={allSuppliers}
        createSubAccountParentId={createSubAccountParentId}
        setCreateSubAccountParentId={setCreateSubAccountParentId}
        createMutation={createMutation}
        updateMutation={updateMutation}
        resetForm={resetForm}
        wrapAdminAction={wrapAdminAction}
      />

      <SupplierPaymentFxDialogs
        paymentDialogSupplier={paymentDialogSupplier}
        setPaymentDialogSupplier={setPaymentDialogSupplier}
        paymentForm={paymentForm}
        setPaymentForm={setPaymentForm}
        allSuppliers={allSuppliers}
        ledgerAccounts={ledgerAccounts}
        paymentMutation={paymentMutation}
        paymentAmtUsd={paymentAmtUsd}
        paymentBalanceUsd={paymentBalanceUsd}
        isOverpayment={isOverpayment}
        overpaymentUsd={overpaymentUsd}
        formatNum={formatNum}
        fxConversionOpen={fxConversionOpen}
        setFxConversionOpen={setFxConversionOpen}
        fxConversionForm={fxConversionForm}
        setFxConversionForm={setFxConversionForm}
        fxSourceType={fxSourceType}
        setFxSourceType={setFxSourceType}
        fxConversionMutation={fxConversionMutation}
        wrapAdminAction={wrapAdminAction}
      />

      <Dialog
        open={bulkFxOpen}
        onOpenChange={(open) => {
          if (!open) {
            setBulkFxOpen(false);
            setBulkFxPreview(null);
          }
        }}
      >
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Layers className="h-5 w-5 text-blue-500" />
              Bulk FX Settlement — {bulkFxBrokerName}
            </DialogTitle>
            <DialogDescription>
              {bulkFxPreview
                ? "Review the breakdown below. Each supplier's account will be debited by the amount shown."
                : "Enter a total amount in a foreign currency. It will be split across all linked suppliers, capped at each supplier's outstanding balance."}
            </DialogDescription>
          </DialogHeader>

          {bulkFxPreview ? (
            <div className="space-y-4">
              <div className="rounded-md border p-3 space-y-2 bg-muted/40">
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Total to settle</span>
                  <span className="font-semibold tabular-nums">
                    {bulkFxForm.fromCurrencyCode}{" "}
                    {parseFloat(bulkFxPreview.totalAllocated).toLocaleString(undefined, {
                      minimumFractionDigits: 2,
                      maximumFractionDigits: 2,
                    })}
                  </span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">≈ USD equivalent</span>
                  <span className="font-semibold tabular-nums text-green-600 dark:text-green-400">
                    $
                    {parseFloat(bulkFxPreview.totalUsd || "0").toLocaleString(undefined, {
                      minimumFractionDigits: 2,
                      maximumFractionDigits: 2,
                    })}
                  </span>
                </div>
              </div>
              <div className="space-y-1">
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Account deductions</p>
                <div className="rounded-md border divide-y text-sm max-h-64 overflow-y-auto">
                  {bulkFxPreview.transfers.map(
                    (t: {
                      supplierId: number;
                      supplierName: string;
                      overpayment?: string;
                      allocated: string;
                      toAmountUsd: string;
                    }) => {
                      const overpaid = parseFloat(t.overpayment || "0") > 0.01;
                      return (
                        <div key={t.supplierId} className="flex justify-between items-center px-3 py-2">
                          <div>
                            <div className="font-medium">{t.supplierName}</div>
                            {overpaid && (
                              <div className="text-xs text-amber-600 dark:text-amber-400">
                                incl. {bulkFxForm.fromCurrencyCode}{" "}
                                {parseFloat(t.overpayment || "0").toLocaleString(undefined, {
                                  minimumFractionDigits: 2,
                                  maximumFractionDigits: 2,
                                })}{" "}
                                overpayment (will show as CR)
                              </div>
                            )}
                          </div>
                          <div className="text-right space-y-0.5">
                            <div className="tabular-nums font-medium">
                              {bulkFxForm.fromCurrencyCode}{" "}
                              {parseFloat(t.allocated).toLocaleString(undefined, {
                                minimumFractionDigits: 2,
                                maximumFractionDigits: 2,
                              })}
                            </div>
                            <div className="text-xs text-muted-foreground">
                              ≈ $
                              {parseFloat(t.toAmountUsd).toLocaleString(undefined, {
                                minimumFractionDigits: 2,
                                maximumFractionDigits: 2,
                              })}{" "}
                              USD
                            </div>
                          </div>
                        </div>
                      );
                    }
                  )}
                </div>
              </div>
              <DialogFooter className="gap-2 flex-wrap">
                <Button variant="outline" onClick={() => setBulkFxPreview(null)} disabled={bulkFxMutation.isPending}>
                  Back to Edit
                </Button>
                <Button
                  onClick={() => wrapAdminAction(() => bulkFxMutation.mutate(undefined), "Record Bulk FX Settlement")}
                  disabled={bulkFxMutation.isPending}
                  data-testid="button-bulk-fx-confirm"
                >
                  {bulkFxMutation.isPending ? "Recording..." : "Confirm & Record Settlement"}
                </Button>
              </DialogFooter>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label>Currency</Label>
                  <Input
                    value={bulkFxForm.fromCurrencyCode}
                    onChange={(e) =>
                      setBulkFxForm(
                        (f: {
                          fromCurrencyCode: string;
                          totalAmount: string;
                          fxRateToUsd: string;
                          date: string;
                          notes: string;
                          order: "oldest" | "newest";
                        }) => ({ ...f, fromCurrencyCode: e.target.value.toUpperCase() })
                      )
                    }
                    maxLength={10}
                    placeholder="EUR"
                  />
                </div>
                <div className="space-y-1">
                  <Label>Total Amount</Label>
                  <Input
                    type="number"
                    step="0.01"
                    value={bulkFxForm.totalAmount}
                    onChange={(e) =>
                      setBulkFxForm(
                        (f: {
                          fromCurrencyCode: string;
                          totalAmount: string;
                          fxRateToUsd: string;
                          date: string;
                          notes: string;
                          order: "oldest" | "newest";
                        }) => ({ ...f, totalAmount: e.target.value })
                      )
                    }
                    placeholder="e.g. 50000"
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label>1 {bulkFxForm.fromCurrencyCode || "CCY"} = X USD (rate)</Label>
                  <Input
                    type="number"
                    step="0.0001"
                    value={bulkFxForm.fxRateToUsd}
                    onChange={(e) =>
                      setBulkFxForm(
                        (f: {
                          fromCurrencyCode: string;
                          totalAmount: string;
                          fxRateToUsd: string;
                          date: string;
                          notes: string;
                          order: "oldest" | "newest";
                        }) => ({ ...f, fxRateToUsd: e.target.value })
                      )
                    }
                    placeholder="e.g. 1.08"
                  />
                </div>
                <div className="space-y-1">
                  <Label>Entry Date</Label>
                  <Input
                    type="date"
                    value={bulkFxForm.date}
                    onChange={(e) =>
                      setBulkFxForm(
                        (f: {
                          fromCurrencyCode: string;
                          totalAmount: string;
                          fxRateToUsd: string;
                          date: string;
                          notes: string;
                          order: "oldest" | "newest";
                        }) => ({ ...f, date: e.target.value })
                      )
                    }
                  />
                </div>
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setBulkFxOpen(false)}>
                  Cancel
                </Button>
                <Button
                  onClick={() => bulkFxPreviewMutation.mutate(undefined)}
                  disabled={
                    bulkFxPreviewMutation.isPending ||
                    !bulkFxForm.fromCurrencyCode ||
                    !bulkFxForm.totalAmount ||
                    !bulkFxForm.fxRateToUsd
                  }
                >
                  {bulkFxPreviewMutation.isPending ? "Loading preview..." : "Preview Settlement"}
                </Button>
              </DialogFooter>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <SupplierOtherDialogs
        obEditSupplier={obEditSupplier}
        setObEditSupplier={setObEditSupplier}
        obEditValue={obEditValue}
        setObEditValue={setObEditValue}
        obEditMutation={obEditMutation}
        dueDialogSupplier={dueDialogSupplier}
        setDueDialogSupplier={setDueDialogSupplier}
        formatDate={formatDate}
        editObComm={editObComm}
        setEditObComm={setEditObComm}
        updateObCommissionMutation={updateObCommissionMutation}
        wrapAdminAction={wrapAdminAction}
      />
    </>
  );
}
