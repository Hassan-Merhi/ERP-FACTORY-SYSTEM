// Extracted from ./SupplierDialogs.tsx to keep that module under the source-size cap.
import type { useFactorySuppliersModel } from "./useFactorySuppliersModel";
import { BulkFxPreview, SupplierWithBalance } from "./factorySupplierTypes";
import { FactorySupplier } from "@shared/schema";
import { UseMutationResult } from "@tanstack/react-query";

type FactorySuppliersModel = ReturnType<typeof useFactorySuppliersModel>;

export interface SupplierDialogsProps {
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
