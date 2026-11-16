// Extracted from ./useFactoryPosModel.ts to keep that module under the source-size cap.
import type { ClientErrorLike } from "@/lib/clientError";
import { useMutation } from "@tanstack/react-query";
import { useReactToPrint } from "react-to-print";
import { apiRequest, queryClient } from "@/lib/queryClient";
import type { ExpenseRow } from "./types";
import { emptyRow, formatNum } from "./utils";
import { useFactoryPosModelPart1 } from "./useFactoryPosModelPart1";

export function useFactoryPosModelPart2({
  cashAccountId,
  currencyCode,
  customerName,
  editSaleData,
  editSaleId,
  expenseRows,
  ledgerAccounts,
  locationId,
  mobileRowEditIdx,
  navigate,
  notes,
  paymentType,
  printRef,
  rows,
  selectedCompany,
  selectedCustomerId,
  setCustomerName,
  setExpenseRows,
  setMobileBrowseOpen,
  setMobileRowEditIdx,
  setMobileRowEditOpen,
  setMobileRowTarget,
  setNotes,
  setPaymentType,
  setRows,
  setSavedSale,
  setSelectedCustomerId,
  setShowPrintDialog,
  setVoidId,
  toast,
  txDate,
}: Pick<
  Awaited<ReturnType<typeof useFactoryPosModelPart1>>,
  | "cashAccountId"
  | "currencyCode"
  | "customerName"
  | "editSaleData"
  | "editSaleId"
  | "expenseRows"
  | "ledgerAccounts"
  | "locationId"
  | "mobileRowEditIdx"
  | "navigate"
  | "notes"
  | "paymentType"
  | "printRef"
  | "rows"
  | "selectedCompany"
  | "selectedCustomerId"
  | "setCustomerName"
  | "setExpenseRows"
  | "setMobileBrowseOpen"
  | "setMobileRowEditIdx"
  | "setMobileRowEditOpen"
  | "setMobileRowTarget"
  | "setNotes"
  | "setPaymentType"
  | "setRows"
  | "setSavedSale"
  | "setSelectedCustomerId"
  | "setShowPrintDialog"
  | "setVoidId"
  | "toast"
  | "txDate"
>) {
  const updateRow = (idx: number, field: "quantity" | "unitPrice", value: string) => {
    setRows((prev) =>
      prev.map((r, i) => {
        if (i !== idx) return r;
        if (field === "quantity") {
          const qty = parseInt(value) || 1;
          if (r.availableQty > 0 && qty > r.availableQty) {
            toast({
              title: "Not enough stock",
              description: `Only ${r.availableQty} available`,
              variant: "destructive",
            });
            return r;
          }
          return { ...r, quantity: Math.max(1, qty) };
        }
        return { ...r, unitPrice: parseFloat(value) || 0 };
      })
    );
  };

  const deleteRow = (idx: number) => {
    setRows((prev) => {
      const next = prev.filter((_, i) => i !== idx);
      if (next.length === 0) return [emptyRow()];
      return next;
    });
  };

  const openMobileBrowse = () => {
    setMobileRowTarget(rows.length);
    setMobileBrowseOpen(true);
  };

  const openMobileRowEdit = (idx: number) => {
    setMobileRowEditIdx(idx);
    setMobileRowEditOpen(true);
  };

  const validRows = rows.filter((r) => r.productId && r.quantity > 0);
  const total = validRows.reduce((s, r) => s + r.quantity * r.unitPrice, 0);
  const totalQty = validRows.reduce((s, r) => s + r.quantity, 0);
  const totalWeight = validRows.reduce((s, r) => s + r.quantity * r.weightPerBale, 0);
  const totalExpenseAmount = expenseRows.reduce((s, e) => s + (parseFloat(e.amount) || 0), 0);
  const netTotal = total - totalExpenseAmount;
  const ccPrefix = currencyCode !== "USD" ? `${currencyCode} ` : "$";

  // Expense row helpers
  const addExpenseRow = () =>
    setExpenseRows((prev) => [...prev, { id: String(Date.now()), accountId: "", description: "", amount: "" }]);
  const removeExpenseRow = (idx: number) => setExpenseRows((prev) => prev.filter((_, i) => i !== idx));
  const updateExpenseRow = (idx: number, field: keyof ExpenseRow, value: string) =>
    setExpenseRows((prev) => prev.map((e, i) => (i === idx ? { ...e, [field]: value } : e)));

  // ---- Print ----
  const fmtPrint = (n: number, prefix = "") => {
    const fixed = Math.abs(n).toFixed(2);
    const clean = fixed.replace(/\.00$/, "");
    const parts = clean.split(".");
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    const num = parts.join(".");
    return prefix ? prefix + "\u00A0" + num : num;
  };
  const fmtPrintAmt = (n: number) => fmtPrint(n, ccPrefix);

  const handlePrint = useReactToPrint({
    contentRef: printRef,
    documentTitle: `FactoryPOS_${txDate}`,
    onAfterPrint: () => setShowPrintDialog(false),
  });

  // ---- Mutations ----
  const saleMutation = useMutation({
    mutationFn: (data: unknown) => apiRequest("POST", "/api/factory/pos/sale", data),
    onSuccess: async (res) => {
      const data = await res.json();
      queryClient.invalidateQueries({ queryKey: ["/api/factory/pos/sales"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/location-inventory", locationId] });
      const snapshotExpenses = expenseRows
        .map((e) => ({
          ...e,
          accountName: (ledgerAccounts || []).find((a) => String(a.id) === e.accountId)?.name || e.accountId,
        }))
        .filter((e) => parseFloat(e.amount) > 0 && e.accountId);
      setSavedSale({
        ...data,
        cartRows: validRows,
        customerName,
        notes,
        currencyCode,
        total,
        totalWeight,
        expenses: snapshotExpenses,
        netTotal: total - snapshotExpenses.reduce((s, e) => s + (parseFloat(e.amount) || 0), 0),
        txDate,
        companyName: selectedCompany?.name || "",
        paymentType: data.paymentType || "CASH",
        depositAmount: data.depositAmount || "0",
      });
      setRows([emptyRow()]);
      setExpenseRows([]);
      setCustomerName("");
      setPaymentType("CASH");
      setSelectedCustomerId("");
      setNotes("");
      queryClient.invalidateQueries({ queryKey: ["/api/factory/customers"] });
      toast({ title: "Sale recorded", description: `${data.saleNumber} – ${ccPrefix}${formatNum(total)}` });
      setShowPrintDialog(true);
    },
    onError: (err: ClientErrorLike) => {
      toast({ title: "Error", description: err.message || "Failed to create sale", variant: "destructive" });
    },
  });

  const editMutation = useMutation({
    mutationFn: (data: unknown) => apiRequest("PUT", `/api/factory/pos/sales/${editSaleId}`, data),
    onSuccess: async (res) => {
      const data = await res.json();
      queryClient.invalidateQueries({ queryKey: ["/api/factory/pos/sales"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/pos/sales", editSaleId] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/location-inventory", locationId] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/daybook"] });
      toast({ title: "Sale updated", description: `${data.saleNumber || editSaleData?.saleNumber} saved` });
      navigate("/factory/daybook");
    },
    onError: (err: ClientErrorLike) => {
      toast({ title: "Error", description: err.message || "Failed to update sale", variant: "destructive" });
    },
  });

  const voidMutation = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `/api/factory/pos/sales/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/pos/sales"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/location-inventory", locationId] });
      setVoidId(null);
      toast({ title: "Sale voided" });
    },
    onError: (err: ClientErrorLike) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const handleSubmit = () => {
    if (!locationId) return toast({ title: "Select a location", variant: "destructive" });
    if (validRows.length === 0) return toast({ title: "No items in sale", variant: "destructive" });
    const validExpenses = expenseRows.filter((e) => parseFloat(e.amount) > 0 && e.accountId);
    if (totalExpenseAmount > total) return toast({ title: "Deductions exceed sales total", variant: "destructive" });
    if (paymentType === "CREDIT" && !selectedCustomerId) {
      return toast({ title: "Select a customer for credit sale", variant: "destructive" });
    }
    const payload = {
      locationId: parseInt(locationId),
      customerName: customerName || null,
      customerId: paymentType === "CREDIT" && selectedCustomerId ? parseInt(selectedCustomerId) : null,
      paymentType,
      depositAmount: "0",
      notes: notes || null,
      txDate,
      currencyCode,
      cashAccountId: cashAccountId ? parseInt(cashAccountId) : null,
      items: validRows.map((r) => ({
        productId: r.productId,
        productName: r.productName,
        articleCode: r.articleCode,
        quantity: r.quantity,
        unitPrice: String(r.unitPrice),
      })),
      expenses: validExpenses.map((e) => ({
        accountId: e.accountId,
        description: e.description,
        amount: e.amount,
      })),
    };
    if (editSaleId) {
      editMutation.mutate(payload);
    } else {
      saleMutation.mutate(payload);
    }
  };

  // Mobile row being edited
  const mobileRow = mobileRowEditIdx !== null ? rows[mobileRowEditIdx] : null;
  return {
    addExpenseRow,
    ccPrefix,
    deleteRow,
    editMutation,
    fmtPrint,
    fmtPrintAmt,
    handlePrint,
    handleSubmit,
    mobileRow,
    netTotal,
    openMobileBrowse,
    openMobileRowEdit,
    removeExpenseRow,
    saleMutation,
    total,
    totalExpenseAmount,
    totalQty,
    totalWeight,
    updateExpenseRow,
    updateRow,
    validRows,
    voidMutation,
  };
}
