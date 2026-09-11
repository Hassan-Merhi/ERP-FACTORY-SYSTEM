import { useState, useRef } from "react";
import type { InvoiceSale } from "../pos-components/InvoiceTemplate";
import type { SaleRow, Location, PosAutoSaveState } from "../pos-components/posTypes";
import { getAppDate } from "@/lib/queryClient";

export function usePosState() {
  const [posSelectedLocation, setPosSelectedLocation] = useState<Location | null>(null);
  const [rows, setRows] = useState<SaleRow[]>([{ id: "1", itemName: "", quantity: 0, rate: 0, rateUSD: 0, amount: 0 }]);
  const [selectedCell, setSelectedCell] = useState<{ row: number; col: number }>({ row: 0, col: 0 });
  const [paymentAccountType, setPaymentAccountType] = useState<"bank" | "cash" | "credit">("cash");
  const [paymentAccountId, setPaymentAccountId] = useState<string | null>(null);
  const [isCreditSale, setIsCreditSale] = useState(false);
  const [selectedCustomerId, setSelectedCustomerId] = useState("");
  const [notes, setNotes] = useState("");
  const [saleDate, setSaleDate] = useState(getAppDate());
  const [searchTerm, setSearchTerm] = useState("");
  const [activeRow, setActiveRow] = useState<number | null>(null);
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const [zeroStockAlert, setZeroStockAlert] = useState(false);
  const [zeroStockItem, setZeroStockItem] = useState("");
  const [savedSale, setSavedSale] = useState<InvoiceSale | null>(null);
  const [showPrintDialog, setShowPrintDialog] = useState(false);
  const [showDraftDialog, setShowDraftDialog] = useState(false);
  const [currentDraftId, setCurrentDraftId] = useState<number | null>(null);
  const [customerComboOpen, setCustomerComboOpen] = useState(false);
  const [mobileCustomerComboOpen, setMobileCustomerComboOpen] = useState(false);
  const [saleJustCompleted, setSaleJustCompleted] = useState(false);
  const [showStockPrompt, setShowStockPrompt] = useState(false);
  const [invoiceWaStatus, setInvoiceWaStatus] = useState<"idle" | "sending" | "sent" | "failed">("idle");
  const [stockWaStatus, setStockWaStatus] = useState<"idle" | "sending" | "sent" | "failed" | "not_configured">("idle");
  const [sendingInvoiceWhatsApp, setSendingInvoiceWhatsApp] = useState(false);
  const [sendingWhatsApp, setSendingWhatsApp] = useState(false);
  const [lastAutosaved, setLastAutosaved] = useState<Date | null>(null);
  const [pendingAutoSend, setPendingAutoSend] = useState<{
    voucherId: number;
    locationId: number;
  } | null>(null);
  const [pendingStockSend, setPendingStockSend] = useState(false);
  const [mobileTab, setMobileTab] = useState<"items" | "cart">("items");

  const inputRefs = useRef<{ [key: string]: HTMLInputElement }>({});
  const itemListRef = useRef<HTMLDivElement>(null);
  const printRef = useRef<HTMLDivElement | null>(null);
  const stockPrintRef = useRef<HTMLDivElement>(null);
  const clearActiveRowTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clientSaleIdRef = useRef<string>(crypto.randomUUID());
  const lastSavedFingerprintRef = useRef<string>("");
  const autoSaveInProgressRef = useRef(false);
  const mobileSearchInputRef = useRef<HTMLInputElement>(null);
  const autoSaveStateRef = useRef<PosAutoSaveState>({
    activeLocation: null,
    rows: [],
    notes: "",
    isCreditSale: false,
    paymentAccountType: "",
    paymentAccountId: null,
    selectedCustomerId: null,
    currentDraftId: null,
    saveDraftIsPending: false,
  });

  return {
    posSelectedLocation,
    setPosSelectedLocation,
    rows,
    setRows,
    selectedCell,
    setSelectedCell,
    paymentAccountType,
    setPaymentAccountType,
    paymentAccountId,
    setPaymentAccountId,
    isCreditSale,
    setIsCreditSale,
    selectedCustomerId,
    setSelectedCustomerId,
    notes,
    setNotes,
    saleDate,
    setSaleDate,
    searchTerm,
    setSearchTerm,
    activeRow,
    setActiveRow,
    highlightedIndex,
    setHighlightedIndex,
    zeroStockAlert,
    setZeroStockAlert,
    zeroStockItem,
    setZeroStockItem,
    savedSale,
    setSavedSale,
    showPrintDialog,
    setShowPrintDialog,
    showDraftDialog,
    setShowDraftDialog,
    currentDraftId,
    setCurrentDraftId,
    customerComboOpen,
    setCustomerComboOpen,
    mobileCustomerComboOpen,
    setMobileCustomerComboOpen,
    saleJustCompleted,
    setSaleJustCompleted,
    showStockPrompt,
    setShowStockPrompt,
    invoiceWaStatus,
    setInvoiceWaStatus,
    stockWaStatus,
    setStockWaStatus,
    sendingInvoiceWhatsApp,
    setSendingInvoiceWhatsApp,
    sendingWhatsApp,
    setSendingWhatsApp,
    lastAutosaved,
    setLastAutosaved,
    pendingAutoSend,
    setPendingAutoSend,
    pendingStockSend,
    setPendingStockSend,
    mobileTab,
    setMobileTab,
    // refs
    inputRefs,
    itemListRef,
    printRef,
    stockPrintRef,
    clearActiveRowTimerRef,
    clientSaleIdRef,
    lastSavedFingerprintRef,
    autoSaveInProgressRef,
    mobileSearchInputRef,
    autoSaveStateRef,
  };
}
