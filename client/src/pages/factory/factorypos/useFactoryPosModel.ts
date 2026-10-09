import type { ClientErrorLike } from "@/lib/clientError";
/**
 * Controller hook for the Factory POS page.
 *
 * Owns the cart, expense deductions, product search (including the barcode
 * Enter-to-add behaviour), the location/customer/currency toolbar state, the
 * edit-mode hydration from ?edit=<id>, the print snapshot and the
 * save/update/void mutations. Views render this model and nothing else.
 */
import { useState, useRef, useEffect, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { useReactToPrint } from "react-to-print";
import { useCompany } from "@/contexts/CompanyContext";
import { apiRequest, queryClient, getAppDate } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import type {
  CartRow,
  EditSaleItem,
  ExpenseRow,
  InventoryItem,
  ParsedExpense,
  PosCustomer,
  PosLedgerAccount,
  PosLocation,
  PosSale,
  SavedSale,
} from "./types";
import { emptyRow, formatNum } from "./utils";

const normSearch = (s: string) => (s || "").toLowerCase().replace(/[\s.\-_]/g, "");

function matchesSearch(item: InventoryItem, query: string): boolean {
  if (!query) return true;
  const s = normSearch(query);
  return (
    normSearch(item.productName).includes(s) ||
    normSearch(item.articleCode).includes(s) ||
    (item.referenceNumbers || []).some((r) => normSearch(r).includes(s))
  );
}

/** Barcode scanners send the full code then Enter — prefer an exact code hit. */
function findExactCodeMatch(items: InventoryItem[], query: string): InventoryItem | undefined {
  const searchNorm = normSearch(query);
  return items.find(
    (item) =>
      normSearch(item.articleCode) === searchNorm ||
      (item.referenceNumbers || []).some((r) => normSearch(r) === searchNorm)
  );
}

export function useFactoryPosModel() {
  const { selectedCompany } = useCompany();
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const printRef = useRef<HTMLDivElement>(null);
  const inputRefs = useRef<{ [key: string]: HTMLInputElement | null }>({});

  // Edit mode — populated from ?edit=<id> query param
  const editSaleId = (() => {
    const p = new URLSearchParams(window.location.search).get("edit");
    return p ? parseInt(p) : null;
  })();

  const [locationId, setLocationId] = useState<string>("");
  const [customerName, setCustomerName] = useState("");
  const [paymentType, setPaymentType] = useState<"CASH" | "CREDIT">("CASH");
  const [selectedCustomerId, setSelectedCustomerId] = useState<string>("");
  const [notes, setNotes] = useState("");
  const [txDate, setTxDate] = useState(getAppDate());
  const [currencyCode, setCurrencyCode] = useState("USD");
  const [cashAccountId, setCashAccountId] = useState<string>("");
  const [rows, setRows] = useState<CartRow[]>([emptyRow("1")]);
  const [expenseRows, setExpenseRows] = useState<ExpenseRow[]>([]);
  const [search, setSearch] = useState("");
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const searchRef = useRef<HTMLInputElement>(null);
  const itemListRef = useRef<HTMLDivElement>(null);
  const [savedSale, setSavedSale] = useState<SavedSale | null>(null);
  const [showPrintDialog, setShowPrintDialog] = useState(false);
  const [voidId, setVoidId] = useState<number | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [editLoaded, setEditLoaded] = useState(false);

  // Mobile state
  const [mobileRowEditOpen, setMobileRowEditOpen] = useState(false);
  const [mobileRowEditIdx, setMobileRowEditIdx] = useState<number | null>(null);
  const [mobileBrowseOpen, setMobileBrowseOpen] = useState(false);
  const [mobileBrowseSearch, setMobileBrowseSearch] = useState("");
  const [mobileRowTarget, setMobileRowTarget] = useState<number | null>(null);

  // Queries
  const { data: locations } = useQuery<PosLocation[]>({ queryKey: ["/api/locations"] });
  const { data: allCustomers } = useQuery<PosCustomer[]>({ queryKey: ["/api/factory/customers"] });
  const { data: inventory, isLoading: invLoading } = useQuery<InventoryItem[]>({
    queryKey: ["/api/factory/location-inventory", locationId],
    queryFn: async () => {
      if (!locationId) return [];
      const res = await fetch(`/api/factory/location-inventory/${locationId}`, { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
    enabled: !!locationId,
  });
  const { data: ledgerAccounts } = useQuery<PosLedgerAccount[]>({
    queryKey: ["/api/ledger-accounts?includeHidden=true"],
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
  const cashAccounts = (ledgerAccounts || []).filter((a) => a.accountType === "Cash");
  const { data: sales, isLoading: salesLoading } = useQuery<PosSale[]>({
    queryKey: ["/api/factory/pos/sales"],
    enabled: showHistory,
  });
  const { data: authUser } = useQuery<{ fullName?: string; name?: string; username?: string; email?: string }>({
    queryKey: ["/api/auth/me"],
  });
  const printUserName = authUser?.fullName || authUser?.name || authUser?.username || authUser?.email || "User";

  // Fetch existing sale when in edit mode
  const { data: editSaleData } = useQuery({
    queryKey: ["/api/factory/pos/sales", editSaleId],
    queryFn: async () => {
      if (!editSaleId) return null;
      const res = await fetch(`/api/factory/pos/sales/${editSaleId}`, { credentials: "include" });
      if (!res.ok) throw new Error("Sale not found");
      return res.json();
    },
    enabled: !!editSaleId,
  });

  // Populate form when edit data loads
  useEffect(() => {
    if (!editSaleData || editLoaded) return;
    setLocationId(editSaleData.locationId ? String(editSaleData.locationId) : "");
    setCustomerName(editSaleData.customerName || "");
    setPaymentType((editSaleData.paymentType as "CASH" | "CREDIT") || "CASH");
    setSelectedCustomerId(editSaleData.customerId ? String(editSaleData.customerId) : "");
    setNotes(editSaleData.notes || "");
    setTxDate(editSaleData.txDate || getAppDate());
    setCurrencyCode(editSaleData.currencyCode || "USD");
    setCashAccountId(editSaleData.cashAccountId ? String(editSaleData.cashAccountId) : "");
    if (editSaleData.items && editSaleData.items.length > 0) {
      setRows(
        editSaleData.items.map((it: EditSaleItem) => ({
          id: String(it.id),
          productId: it.productId || null,
          productName: it.productName,
          articleCode: it.articleCode || "",
          availableQty: 9999,
          quantity: parseInt(String(it.quantity), 10) || 1,
          unitPrice: parseFloat(String(it.unitPrice)) || 0,
          weightPerBale: 0,
        }))
      );
    }
    if (editSaleData.expensesJson) {
      try {
        const expArr = JSON.parse(editSaleData.expensesJson);
        setExpenseRows(
          expArr.map((e: ParsedExpense) => ({
            id: String(Date.now() + Math.random()),
            accountId: String(e.accountId),
            description: e.description || "",
            amount: String(e.amount),
          }))
        );
      } catch {
        /* ignore */
      }
    }
    setEditLoaded(true);
  }, [editSaleData, editLoaded]);

  const filteredInventory = (inventory || []).filter((item) => matchesSearch(item, search));
  const mobileFilteredInventory = (inventory || []).filter((item) => matchesSearch(item, mobileBrowseSearch));

  // Scroll the highlighted item into view when navigating with arrow keys
  useEffect(() => {
    const list = itemListRef.current;
    if (!list) return;
    const child = list.children[highlightedIndex] as HTMLElement | undefined;
    if (child) child.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [highlightedIndex]);

  // ---- Row helpers ----
  const addOrIncrementProduct = (item: InventoryItem) => {
    setRows((prev) => {
      const existingIdx = prev.findIndex((r) => r.productId === item.productId);
      if (existingIdx !== -1) {
        const existing = prev[existingIdx];
        if (existing.quantity >= item.quantity) {
          toast({ title: "Not enough stock", description: `Only ${item.quantity} available`, variant: "destructive" });
          return prev;
        }
        return prev.map((r, i) => (i === existingIdx ? { ...r, quantity: r.quantity + 1 } : r));
      }
      // Add new row before trailing empty row if one exists
      const newRow: CartRow = {
        id: String(Date.now()),
        productId: item.productId,
        productName: item.productName,
        articleCode: item.articleCode,
        availableQty: item.quantity,
        quantity: 1,
        unitPrice: parseFloat(item.sellingPrice || "0"),
        weightPerBale: item.quantity > 0 ? (item.totalWeight || 0) / item.quantity : 0,
      };
      const lastRow = prev[prev.length - 1];
      if (lastRow && !lastRow.productId) {
        return [...prev.slice(0, -1), newRow, lastRow];
      }
      return [...prev, newRow];
    });
  };

  /** Adds the item and returns focus to the search box for rapid scanning. */
  const addProductFromSearch = (item: InventoryItem) => {
    addOrIncrementProduct(item);
    setSearch("");
    setHighlightedIndex(0);
    searchRef.current?.focus();
  };

  // Keyboard handler for the search input
  const handleSearchKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlightedIndex((prev) => Math.min(prev + 1, filteredInventory.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlightedIndex((prev) => Math.max(prev - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      // Prefer an exact articleCode or reference-number match (barcode scanner sends full code + Enter)
      const exactMatch = findExactCodeMatch(filteredInventory, search);
      const item = exactMatch ?? filteredInventory[highlightedIndex] ?? filteredInventory[0];
      if (item) addProductFromSearch(item);
    } else if (e.key === "Escape") {
      setSearch("");
      setHighlightedIndex(0);
    }
  };

  const handleMobileSearchKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && mobileFilteredInventory.length > 0) {
      e.preventDefault();
      const exactMatch = findExactCodeMatch(mobileFilteredInventory, mobileBrowseSearch);
      addProductFromMobile(exactMatch ?? mobileFilteredInventory[0]);
    }
  };

  const addProductFromMobile = (item: InventoryItem) => {
    const targetIdx = mobileRowTarget ?? (rows.length > 0 ? rows.length - 1 : 0);
    setRows((prev) => {
      const existingIdx = prev.findIndex((r) => r.productId === item.productId);
      if (existingIdx !== -1) {
        return prev.map((r, i) => (i === existingIdx ? { ...r, quantity: r.quantity + 1 } : r));
      }
      const newRow: CartRow = {
        id: String(Date.now()),
        productId: item.productId,
        productName: item.productName,
        articleCode: item.articleCode,
        availableQty: item.quantity,
        quantity: 1,
        unitPrice: parseFloat(item.sellingPrice || "0"),
        weightPerBale: item.quantity > 0 ? (item.totalWeight || 0) / item.quantity : 0,
      };
      const arr = [...prev];
      arr.splice(targetIdx, 0, newRow);
      return arr;
    });
    setMobileBrowseOpen(false);
    setMobileBrowseSearch("");
    setMobileRowEditIdx(
      rows.findIndex((r) => r.productId === item.productId) !== -1
        ? rows.findIndex((r) => r.productId === item.productId)
        : targetIdx
    );
    setMobileRowEditOpen(true);
  };

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
    // toolbar state
    locations,
    locationId,
    setLocationId,
    txDate,
    setTxDate,
    currencyCode,
    setCurrencyCode,
    cashAccounts,
    cashAccountId,
    setCashAccountId,
    paymentType,
    setPaymentType,
    customerName,
    setCustomerName,
    allCustomers,
    selectedCustomerId,
    setSelectedCustomerId,
    notes,
    setNotes,
    // cart
    rows,
    inputRefs,
    updateRow,
    deleteRow,
    validRows,
    total,
    totalQty,
    totalWeight,
    netTotal,
    ccPrefix,
    // expenses
    expenseRows,
    ledgerAccounts,
    addExpenseRow,
    removeExpenseRow,
    updateExpenseRow,
    totalExpenseAmount,
    // product browser
    search,
    setSearch,
    highlightedIndex,
    setHighlightedIndex,
    searchRef,
    itemListRef,
    invLoading,
    filteredInventory,
    handleSearchKeyDown,
    addProductFromSearch,
    // history
    showHistory,
    setShowHistory,
    sales,
    salesLoading,
    voidId,
    setVoidId,
    voidMutation,
    // mobile
    mobileBrowseOpen,
    setMobileBrowseOpen,
    mobileBrowseSearch,
    setMobileBrowseSearch,
    mobileFilteredInventory,
    handleMobileSearchKeyDown,
    addProductFromMobile,
    mobileRowEditOpen,
    setMobileRowEditOpen,
    mobileRowEditIdx,
    mobileRow,
    openMobileBrowse,
    openMobileRowEdit,
    // save / edit
    editSaleId,
    editSaleData,
    handleSubmit,
    saleMutation,
    editMutation,
    navigate,
    // print
    printRef,
    printUserName,
    savedSale,
    showPrintDialog,
    setShowPrintDialog,
    handlePrint,
    fmtPrint,
    fmtPrintAmt,
  };
}

export type FactoryPosModel = ReturnType<typeof useFactoryPosModel>;
