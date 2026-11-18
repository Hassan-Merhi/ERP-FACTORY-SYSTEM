// Extracted from ./useFactoryPosModel.ts to keep that module under the source-size cap.
import { type KeyboardEvent as ReactKeyboardEvent, useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { useCompany } from "@/contexts/CompanyContext";
import { companyQueryKey } from "@/lib/companyQueryScope";
import { getAppDate } from "@/lib/queryClient";
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
import { emptyRow } from "./utils";

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

export function useFactoryPosModelPart1() {
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
  const { data: locations } = useQuery<PosLocation[]>({
    queryKey: companyQueryKey("/api/locations", selectedCompany?.id),
    enabled: Boolean(selectedCompany?.id),
  });
  const { data: allCustomers } = useQuery<PosCustomer[]>({
    queryKey: companyQueryKey("/api/factory/customers", selectedCompany?.id),
    enabled: Boolean(selectedCompany?.id),
  });
  const { data: inventory, isLoading: invLoading } = useQuery<InventoryItem[]>({
    queryKey: companyQueryKey("/api/factory/location-inventory", selectedCompany?.id, locationId),
    queryFn: async () => {
      if (!locationId) return [];
      const res = await fetch(`/api/factory/location-inventory/${locationId}`, { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
    enabled: !!locationId && Boolean(selectedCompany?.id),
  });
  // Factory POS needs cash and deduction options even when the user has no
  // general Accounting module access. This endpoint is read-only, limited to
  // the active Factory company, and protected by the Factory POS page grant.
  const {
    data: ledgerAccounts,
    isLoading: accountOptionsLoading,
    isError: accountOptionsError,
  } = useQuery<PosLedgerAccount[]>({
    queryKey: ["/api/factory/pos/account-options", selectedCompany?.id],
    queryFn: async () => {
      const response = await fetch("/api/factory/pos/account-options", { credentials: "include" });
      if (!response.ok) throw new Error("Failed to load Factory POS payment accounts");
      return (await response.json()) as PosLedgerAccount[];
    },
    enabled: !!selectedCompany?.id,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
  const cashAccounts = (ledgerAccounts || []).filter((a) => a.accountType === "Cash");

  // Company changes invalidate every local draft selection, not just the cash account.
  // Never allow a previous company's unsaved POS rows or edit hydration to survive.
  useEffect(() => {
    setCashAccountId("");
    setLocationId("");
    setSelectedCustomerId("");
    setCustomerName("");
    setRows([emptyRow("1")]);
    setExpenseRows([]);
    setSavedSale(null);
    setVoidId(null);
    setEditLoaded(false);
    setShowPrintDialog(false);
  }, [selectedCompany?.id]);
  const { data: sales, isLoading: salesLoading } = useQuery<PosSale[]>({
    queryKey: companyQueryKey("/api/factory/pos/sales", selectedCompany?.id),
    enabled: showHistory && Boolean(selectedCompany?.id),
  });
  const { data: authUser } = useQuery<{ fullName?: string; name?: string; username?: string; email?: string }>({
    queryKey: ["/api/auth/me"],
  });
  const printUserName = authUser?.fullName || authUser?.name || authUser?.username || authUser?.email || "User";

  // Fetch existing sale when in edit mode
  const { data: editSaleData } = useQuery({
    queryKey: companyQueryKey("/api/factory/pos/sales", selectedCompany?.id, editSaleId),
    queryFn: async () => {
      if (!editSaleId) return null;
      const res = await fetch(`/api/factory/pos/sales/${editSaleId}`, { credentials: "include" });
      if (!res.ok) throw new Error("Sale not found");
      return res.json();
    },
    enabled: !!editSaleId && Boolean(selectedCompany?.id),
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

  const scanProductFromCamera = (barcode: string, mobile = false) => {
    const item = findExactCodeMatch(inventory || [], barcode.trim());
    if (!item) {
      toast({ title: "Barcode not found", description: barcode, variant: "destructive" });
      return;
    }
    if (mobile) addProductFromMobile(item);
    else addProductFromSearch(item);
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
  return {
    accountOptionsError,
    accountOptionsLoading,
    addProductFromMobile,
    addProductFromSearch,
    allCustomers,
    cashAccountId,
    cashAccounts,
    currencyCode,
    customerName,
    editSaleData,
    editSaleId,
    expenseRows,
    filteredInventory,
    handleMobileSearchKeyDown,
    handleSearchKeyDown,
    highlightedIndex,
    inputRefs,
    invLoading,
    itemListRef,
    ledgerAccounts,
    locationId,
    locations,
    mobileBrowseOpen,
    mobileBrowseSearch,
    mobileFilteredInventory,
    mobileRowEditIdx,
    mobileRowEditOpen,
    navigate,
    notes,
    paymentType,
    printRef,
    printUserName,
    rows,
    sales,
    salesLoading,
    savedSale,
    scanProductFromCamera,
    search,
    searchRef,
    selectedCompany,
    selectedCustomerId,
    setCashAccountId,
    setCurrencyCode,
    setCustomerName,
    setExpenseRows,
    setHighlightedIndex,
    setLocationId,
    setMobileBrowseOpen,
    setMobileBrowseSearch,
    setMobileRowEditIdx,
    setMobileRowEditOpen,
    setMobileRowTarget,
    setNotes,
    setPaymentType,
    setRows,
    setSavedSale,
    setSearch,
    setSelectedCustomerId,
    setShowHistory,
    setShowPrintDialog,
    setTxDate,
    setVoidId,
    showHistory,
    showPrintDialog,
    toast,
    txDate,
    voidId,
  };
}
