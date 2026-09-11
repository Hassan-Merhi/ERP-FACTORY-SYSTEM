import type { AuthMe } from "@shared/apiTypes";
import type { InvoiceSale } from "../pos-components/InvoiceTemplate";
import type {
  SaleRow,
  InventoryItem,
  APIInventoryItem,
  Location,
  PosEditVoucher,
  PosMutationPending,
  PosShift,
} from "../pos-components/posTypes";
import { makeFocusCell } from "../utils/posKeyboardHelpers";
import { usePosRowCalculations } from "./usePosRowCalculations";
import { usePosCheckout } from "./usePosCheckout";
import { usePosInvoiceActions } from "./usePosInvoiceActions";
import { usePosKeyboardNavigation } from "./usePosKeyboardNavigation";

interface PosHandlersParams {
  // State values
  rows: SaleRow[];
  isCreditSale: boolean;
  paymentAccountType: string;
  paymentAccountId: string | null;
  selectedCustomerId: string;
  currentDraftId: number | null;
  notes: string;
  saleDate: string;
  activeRow: number | null;
  highlightedIndex: number;
  // Setters
  setRows: React.Dispatch<React.SetStateAction<SaleRow[]>>;
  setSelectedCell: React.Dispatch<React.SetStateAction<{ row: number; col: number }>>;
  setNotes: React.Dispatch<React.SetStateAction<string>>;
  setPaymentAccountType: React.Dispatch<React.SetStateAction<"bank" | "cash" | "credit">>;
  setPaymentAccountId: React.Dispatch<React.SetStateAction<string | null>>;
  setIsCreditSale: React.Dispatch<React.SetStateAction<boolean>>;
  setSelectedCustomerId: React.Dispatch<React.SetStateAction<string>>;
  setCurrentDraftId: React.Dispatch<React.SetStateAction<number | null>>;
  setShowDraftDialog: React.Dispatch<React.SetStateAction<boolean>>;
  setShowPrintDialog: React.Dispatch<React.SetStateAction<boolean>>;
  setSavedSale: (sale: InvoiceSale | null) => void;
  setSaleJustCompleted: React.Dispatch<React.SetStateAction<boolean>>;
  setLastAutosaved: React.Dispatch<React.SetStateAction<Date | null>>;
  setMobileTab: React.Dispatch<React.SetStateAction<"items" | "cart">>;
  setPendingStockSend: React.Dispatch<React.SetStateAction<boolean>>;
  setStockWaStatus: React.Dispatch<React.SetStateAction<"idle" | "sending" | "sent" | "failed" | "not_configured">>;
  setInvoiceWaStatus: React.Dispatch<React.SetStateAction<"idle" | "sending" | "sent" | "failed">>;
  setZeroStockItem: React.Dispatch<React.SetStateAction<string>>;
  setZeroStockAlert: React.Dispatch<React.SetStateAction<boolean>>;
  setSearchTerm: React.Dispatch<React.SetStateAction<string>>;
  setHighlightedIndex: React.Dispatch<React.SetStateAction<number>>;
  lastSavedFingerprintRef: React.MutableRefObject<string>;
  // Refs
  inputRefs: React.MutableRefObject<{ [key: string]: HTMLInputElement }>;
  printRef: React.MutableRefObject<HTMLDivElement | null>;
  stockPrintRef: React.RefObject<HTMLDivElement | null>;
  clientSaleIdRef: React.MutableRefObject<string>;
  // Query results
  activeCurrency: string;
  exchangeRate: number | null;
  dailyExchangeRate: number | null;
  activeLocation: Location | null;
  editVoucherId?: string;
  editVoucher?: PosEditVoucher | null;
  isSpCompany?: boolean;
  isGoldenCoastPhase6?: boolean;
  goldenCoastReadinessLoading?: boolean;
  goldenCoastReadinessBlocked?: boolean;
  goldenCoastReadinessBlockers?: readonly string[];
  inventory: InventoryItem[];
  apiInventory: APIInventoryItem[];
  lastSoldPrices: Record<number, string>;
  currentShift?: PosShift | null;
  authUser?: AuthMe | null;
  posUser?: AuthMe | null;
  // Mutations
  saveMutation: PosMutationPending;
  // Misc
  toast: (opts: { title: string; description?: string; variant?: "destructive" | "default" }) => void;
}

/**
 * Thin orchestrator that composes the focused POS handler hooks below and
 * exposes the same combined handler surface previously implemented inline
 * here. Phase 18 structural split — logic unchanged, only relocated:
 *   - usePosRowCalculations   → item selection + cell-edit calculations
 *   - usePosCheckout          → save/new-sale/load-draft lifecycle
 *   - usePosInvoiceActions    → print + spreadsheet export actions
 *   - usePosKeyboardNavigation→ grid keyboard navigation
 */
export function usePosHandlers(params: PosHandlersParams) {
  const focusCell = makeFocusCell(params.inputRefs);

  const { selectItem, updateRow } = usePosRowCalculations({
    rows: params.rows,
    activeRow: params.activeRow,
    setRows: params.setRows,
    setSearchTerm: params.setSearchTerm,
    setZeroStockItem: params.setZeroStockItem,
    setZeroStockAlert: params.setZeroStockAlert,
    lastSoldPrices: params.lastSoldPrices,
    activeCurrency: params.activeCurrency,
    exchangeRate: params.exchangeRate,
    authUser: params.authUser,
    posUser: params.posUser,
    focusCell,
  });

  const { handleSaveSale, handleNewSale, handleLoadDraft } = usePosCheckout({
    rows: params.rows,
    isCreditSale: params.isCreditSale,
    paymentAccountType: params.paymentAccountType,
    paymentAccountId: params.paymentAccountId,
    selectedCustomerId: params.selectedCustomerId,
    notes: params.notes,
    saleDate: params.saleDate,
    setRows: params.setRows,
    setSelectedCell: params.setSelectedCell,
    setNotes: params.setNotes,
    setPaymentAccountType: params.setPaymentAccountType,
    setPaymentAccountId: params.setPaymentAccountId,
    setIsCreditSale: params.setIsCreditSale,
    setSelectedCustomerId: params.setSelectedCustomerId,
    setCurrentDraftId: params.setCurrentDraftId,
    setShowDraftDialog: params.setShowDraftDialog,
    setShowPrintDialog: params.setShowPrintDialog,
    setSavedSale: params.setSavedSale,
    setSaleJustCompleted: params.setSaleJustCompleted,
    setLastAutosaved: params.setLastAutosaved,
    setMobileTab: params.setMobileTab,
    setPendingStockSend: params.setPendingStockSend,
    setStockWaStatus: params.setStockWaStatus,
    setInvoiceWaStatus: params.setInvoiceWaStatus,
    lastSavedFingerprintRef: params.lastSavedFingerprintRef,
    clientSaleIdRef: params.clientSaleIdRef,
    activeCurrency: params.activeCurrency,
    exchangeRate: params.exchangeRate,
    dailyExchangeRate: params.dailyExchangeRate,
    activeLocation: params.activeLocation,
    editVoucherId: params.editVoucherId,
    editVoucher: params.editVoucher,
    isSpCompany: params.isSpCompany,
    isGoldenCoastPhase6: params.isGoldenCoastPhase6,
    goldenCoastReadinessLoading: params.goldenCoastReadinessLoading,
    goldenCoastReadinessBlocked: params.goldenCoastReadinessBlocked,
    goldenCoastReadinessBlockers: params.goldenCoastReadinessBlockers,
    inventory: params.inventory,
    currentShift: params.currentShift,
    posUser: params.posUser,
    saveMutation: params.saveMutation,
    toast: params.toast,
    focusCell,
  });

  const { handlePrint, handleStockPrint, handleExportInventory, handleSummaryExport, handleDetailedExport } =
    usePosInvoiceActions({
      rows: params.rows,
      printRef: params.printRef,
      stockPrintRef: params.stockPrintRef,
      activeLocation: params.activeLocation,
      apiInventory: params.apiInventory,
      toast: params.toast,
    });

  const { makeHandleKeyDown } = usePosKeyboardNavigation({
    rows: params.rows,
    activeRow: params.activeRow,
    highlightedIndex: params.highlightedIndex,
    inventory: params.inventory,
    setSelectedCell: params.setSelectedCell,
    setHighlightedIndex: params.setHighlightedIndex,
    setRows: params.setRows,
    toast: params.toast,
    focusCell,
    selectItem,
  });

  return {
    focusCell,
    handlePrint,
    handleStockPrint,
    handleSaveSale,
    handleNewSale,
    selectItem,
    updateRow,
    handleLoadDraft,
    handleExportInventory,
    handleSummaryExport,
    handleDetailedExport,
    makeHandleKeyDown,
  };
}
