// Extracted from ./usePosCheckout.ts
import type { AuthMe } from "@shared/apiTypes";
import type { InvoiceSale } from "../pos-components/InvoiceTemplate";
import type {
  InventoryItem,
  Location,
  PosEditVoucher,
  PosMutationPending,
  PosShift,
  SaleRow,
} from "../pos-components/posTypes";

export interface PosCheckoutParams {
  rows: SaleRow[];
  isCreditSale: boolean;
  paymentAccountType: string;
  paymentAccountId: string | null;
  selectedCustomerId: string;
  notes: string;
  saleDate: string;
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
  lastSavedFingerprintRef: React.MutableRefObject<string>;
  clientSaleIdRef: React.MutableRefObject<string>;
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
  currentShift?: PosShift | null;
  posUser?: AuthMe | null;
  saveMutation: PosMutationPending;
  toast: (opts: { title: string; description?: string; variant?: "destructive" | "default" }) => void;
  focusCell: (row: number, col: number) => void;
}
