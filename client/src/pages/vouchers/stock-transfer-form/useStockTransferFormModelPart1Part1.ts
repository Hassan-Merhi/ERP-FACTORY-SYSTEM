// Extracted from ./useStockTransferFormModel.ts to keep that module under the source-size cap.
import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useFieldArray, useForm } from "react-hook-form";
import { zodResolver } from "@/lib/form-resolver";
import { useLocation } from "wouter";
import { useCompany } from "@/contexts/CompanyContext";
import { useCurrencyContext } from "@/contexts/CurrencyContext";
import { useAppMode, useModePrefix } from "@/contexts/AppModeContext";
import { getApiRequest } from "@/lib/factoryApi";
import { parseDateLocal } from "@/components/vouchers/PrintTemplate";
import { useToast } from "@/hooks/use-toast";
import type { Location, StockItem, StockTransferFormData, StockTransferFormProps } from "../stocktransferform/types";
import { stockTransferFormSchema } from "../stocktransferform/utils";
import {
  type TransferInventoryItem,
  useFilteredTransferInventory,
  usePendingTransferRevisions,
  useTransferRateAutofill,
} from "./useTransferFormDerived";
import type { StockTransferLineItem, TransferImportValidationResult, TransferRevision } from "./transferFormTypes";

export function useStockTransferFormModelPart1Part1(props: StockTransferFormProps) {
  const { voucherIdToEdit, isPOS, posUser } = props;
  const { toast } = useToast();
  const { selectedCompany } = useCompany();
  const appMode = useAppMode();
  const modeApiRequest = getApiRequest(appMode);
  const modePrefix = useModePrefix();
  const { formatAmount } = useCurrencyContext();
  const [, setLocation] = useLocation();
  const posLocationId = posUser?.assignedLocationId;
  const hydratedVoucherIdRef = useRef<number | null>(null);
  const lastKnownTransferIdRef = useRef<number | null>(null);
  const savingTransferRevisionRef = useRef(false);

  const { data: stockItems = [] } = useQuery<StockItem[]>({
    queryKey: ["/api/stock-items/light", selectedCompany?.id],
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const { data: locations = [] } = useQuery<Location[]>({
    queryKey: ["/api/locations", selectedCompany?.id],
  });
  const { data: myLocations = [] } = useQuery<{ id: number; name: string }[]>({
    queryKey: ["/api/my-locations"],
    enabled: isPOS,
  });

  const posLocation = isPOS && posLocationId ? locations.find((l) => l.id === posLocationId) : null;
  const posLocationName = posLocation?.name || "";

  const { data: voucherToEdit } = useQuery({
    queryKey: ["/api/vouchers", voucherIdToEdit],
    enabled: !!voucherIdToEdit,
    queryFn: async () => {
      const res = await fetch(`/api/vouchers/${voucherIdToEdit}`);
      if (!res.ok) throw new Error("Failed to fetch voucher");
      return res.json();
    },
  });

  const { data: stockTransferToEdit } = useQuery({
    queryKey: ["/api/stock-transfers", voucherIdToEdit],
    enabled: !!voucherIdToEdit,
    queryFn: async () => {
      const res = await fetch(`/api/stock-transfers?voucherId=${voucherIdToEdit}`);
      if (!res.ok) throw new Error("Failed to fetch stock transfer");
      const data = await res.json();
      return Array.isArray(data) ? data[0] : data;
    },
    staleTime: 15000,
  });

  if (stockTransferToEdit?.id) lastKnownTransferIdRef.current = stockTransferToEdit.id;
  const stableTransferId = stockTransferToEdit?.id ?? lastKnownTransferIdRef.current;

  const { data: transferRevisions = [] } = useQuery<TransferRevision[]>({
    queryKey: ["/api/stock-transfers", stableTransferId, "revisions"],
    queryFn: async () => {
      const res = await fetch(`/api/stock-transfers/${stableTransferId}/revisions`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch revisions");
      return res.json();
    },
    enabled: !!stableTransferId,
  });

  const pendingTransferRevisions = usePendingTransferRevisions(transferRevisions);

  const stockTransferForm = useForm<StockTransferFormData>({
    resolver: zodResolver(stockTransferFormSchema),
    defaultValues: {
      voucherDate: new Date(),
      destinationLocationId: 0,
      entries: [
        {
          sourceLocationId: 0,
          sourceLocationName: "",
          stockItemId: 0,
          stockItemCode: "",
          stockItemName: "",
          quantity: "",
          rate: "",
        },
      ],
      notes: "",
      optional: false,
    },
  });

  const {
    fields: transferFields,
    append: appendTransfer,
    replace: replaceTransfer,
    remove: removeTransfer,
  } = useFieldArray({
    control: stockTransferForm.control,
    name: "entries",
  });
  const transferEntries = stockTransferForm.watch("entries");
  const transferTotal = transferEntries.reduce(
    (sum, entry) => sum + parseFloat(entry.quantity || "0") * parseFloat(entry.rate || "0"),
    0
  );

  const [activeTransferRow, setActiveTransferRow] = useState<number | null>(null);
  const [transferInventorySource, setTransferInventorySource] = useState<number | null>(
    isPOS && posLocationId ? posLocationId : null
  );
  const [transferSearchTerm, setTransferSearchTerm] = useState("");
  const [transferHighlightedIndex, setTransferHighlightedIndex] = useState(0);
  const [transferSourceSearchTerm, setTransferSourceSearchTerm] = useState("");
  const [transferSourceHighlightedIndex, setTransferSourceHighlightedIndex] = useState(0);
  const [showSourceSidebar, setShowSourceSidebar] = useState(false);
  const [showItemSidebar, setShowItemSidebar] = useState(false);
  const [activeFieldType, setActiveFieldType] = useState<"source" | "item" | null>(null);
  const transferSidebarRef = useRef<HTMLDivElement>(null);
  const transferFocusIdRef = useRef(0);

  const [posSelectedSourceId, setPosSelectedSourceId] = useState<number | null>(posLocationId ?? null);
  const posSelectedSourceName = isPOS
    ? locations.find((l) => l.id === posSelectedSourceId)?.name || posLocationName
    : "";

  const [transferRevisionDialogOpen, setTransferRevisionDialogOpen] = useState(false);
  const [transferRevisionNote, setTransferRevisionNote] = useState("");
  const [isTransferSavingRevision, setIsTransferSavingRevision] = useState(false);
  const [transferRevisionsExpanded, setTransferRevisionsExpanded] = useState(false);
  const [approveRevisionTarget, setApproveRevisionTarget] = useState<TransferRevision | null>(null);
  const [transferQtyDraft, setTransferQtyDraft] = useState<Record<number | string, string>>({});

  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const [posImportDialogOpen, setPosImportDialogOpen] = useState(false);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importPreview, setImportPreview] = useState<{
    items: { rowNum: number; barcode: string; quantity: number; sourceLocation?: string }[];
    totalItems?: number;
    fileName?: string;
  } | null>(null);
  const [importValidationResult, setImportValidationResult] = useState<TransferImportValidationResult | null>(null);
  const [importDestLocation, setImportDestLocation] = useState<string>("");
  const [importDate, setImportDate] = useState<string>(new Date().toLocaleDateString("en-CA"));
  const [importNotes, setImportNotes] = useState<string>("");
  const [importConfirmDialogOpen, setImportConfirmDialogOpen] = useState(false);

  const importIsValidated = importValidationResult !== null;
  const importHasErrors = importValidationResult?.errors && importValidationResult.errors.length > 0;
  const importValidItems = importValidationResult?.validatedItems?.filter((item) => !item.error) || [];
  const importValidItemsCount = importValidItems.length;
  const importTotalItemsCount = importValidationResult?.validatedItems?.length || 0;

  const { data: transferInventory = [] } = useQuery<TransferInventoryItem[]>({
    queryKey: transferInventorySource ? [`/api/locations/${transferInventorySource}/inventory`] : [],
    enabled: !!transferInventorySource && transferInventorySource > 0,
  });
  useEffect(() => {
    if (isPOS && posSelectedSourceId && posSelectedSourceName) {
      const entries = stockTransferForm.getValues("entries");
      entries.forEach((_, index) => {
        stockTransferForm.setValue(`entries.${index}.sourceLocationId`, posSelectedSourceId);
        stockTransferForm.setValue(`entries.${index}.sourceLocationName`, posSelectedSourceName);
      });
      setTransferInventorySource(posSelectedSourceId);
    }
  }, [isPOS, posSelectedSourceId, posSelectedSourceName]); // eslint-disable-line
  const filteredTransferInventory = useFilteredTransferInventory(transferInventory, transferSearchTerm);

  useTransferRateAutofill(transferEntries, stockTransferForm);
  useEffect(() => {
    if (
      stockTransferToEdit &&
      stockTransferToEdit.items &&
      voucherToEdit &&
      typeof voucherToEdit.voucherDate === "string" &&
      voucherToEdit.voucherDate.trim().length > 0 &&
      locations.length > 0 &&
      stockItems.length > 0
    ) {
      if (hydratedVoucherIdRef.current === voucherIdToEdit) return;
      const formEntries = (stockTransferToEdit.items as StockTransferLineItem[]).map((item) => {
        const sourceLocation = locations.find((l) => l.id === item.sourceLocationId);
        const stockItem = stockItems.find((s) => s.id === item.stockItemId);
        return {
          sourceLocationId: item.sourceLocationId || 0,
          sourceLocationName: sourceLocation?.name || "",
          stockItemId: item.stockItemId || 0,
          stockItemCode: stockItem?.code || "",
          stockItemName: stockItem?.name || "",
          quantity: item.quantity || "0",
          rate: item.rate || "0",
        };
      });
      stockTransferForm.reset({
        voucherDate: voucherToEdit ? parseDateLocal(voucherToEdit.voucherDate) : new Date(),
        destinationLocationId: stockTransferToEdit.destinationLocationId || 0,
        entries:
          formEntries.length > 0
            ? formEntries
            : [
                {
                  sourceLocationId: 0,
                  sourceLocationName: "",
                  stockItemId: 0,
                  stockItemCode: "",
                  stockItemName: "",
                  quantity: "",
                  rate: "",
                },
              ],
        notes: stockTransferToEdit.notes || "",
        optional: voucherToEdit?.optional || false,
      });
      hydratedVoucherIdRef.current = voucherIdToEdit;
    }
  }, [stockTransferToEdit, voucherToEdit, locations, stockItems, stockTransferForm]); // eslint-disable-line
  return {
    activeFieldType,
    activeTransferRow,
    appendTransfer,
    approveRevisionTarget,
    filteredTransferInventory,
    formatAmount,
    hydratedVoucherIdRef,
    importConfirmDialogOpen,
    importDate,
    importDestLocation,
    importDialogOpen,
    importFile,
    importHasErrors,
    importIsValidated,
    importNotes,
    importPreview,
    importTotalItemsCount,
    importValidItemsCount,
    importValidationResult,
    isPOS,
    isTransferSavingRevision,
    lastKnownTransferIdRef,
    locations,
    modeApiRequest,
    modePrefix,
    myLocations,
    pendingTransferRevisions,
    posImportDialogOpen,
    posLocationName,
    posSelectedSourceId,
    posSelectedSourceName,
    removeTransfer,
    replaceTransfer,
    savingTransferRevisionRef,
    selectedCompany,
    setActiveFieldType,
    setActiveTransferRow,
    setApproveRevisionTarget,
    setImportConfirmDialogOpen,
    setImportDate,
    setImportDestLocation,
    setImportDialogOpen,
    setImportFile,
    setImportNotes,
    setImportPreview,
    setImportValidationResult,
    setIsTransferSavingRevision,
    setLocation,
    setPosImportDialogOpen,
    setPosSelectedSourceId,
    setShowItemSidebar,
    setShowSourceSidebar,
    setTransferHighlightedIndex,
    setTransferInventorySource,
    setTransferQtyDraft,
    setTransferRevisionDialogOpen,
    setTransferRevisionNote,
    setTransferRevisionsExpanded,
    setTransferSearchTerm,
    setTransferSourceHighlightedIndex,
    setTransferSourceSearchTerm,
    showItemSidebar,
    showSourceSidebar,
    stableTransferId,
    stockItems,
    stockTransferForm,
    stockTransferToEdit,
    toast,
    transferEntries,
    transferFields,
    transferFocusIdRef,
    transferHighlightedIndex,
    transferInventory,
    transferInventorySource,
    transferQtyDraft,
    transferRevisionDialogOpen,
    transferRevisionNote,
    transferRevisions,
    transferRevisionsExpanded,
    transferSearchTerm,
    transferSidebarRef,
    transferSourceHighlightedIndex,
    transferSourceSearchTerm,
    transferTotal,
    voucherIdToEdit,
    voucherToEdit,
  };
}

export function useStockTransferFormModelPart1Part2({
  showItemSidebar,
  transferHighlightedIndex,
  transferSidebarRef,
}: Pick<
  Awaited<ReturnType<typeof useStockTransferFormModelPart1Part1>>,
  "showItemSidebar" | "transferHighlightedIndex" | "transferSidebarRef"
>) {
  useEffect(() => {
    if (showItemSidebar && transferSidebarRef.current) {
      const container = transferSidebarRef.current;
      const highlighted = container.querySelector(`[data-transfer-idx="${transferHighlightedIndex}"]`);
      if (highlighted) highlighted.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }, [transferHighlightedIndex, showItemSidebar, transferSidebarRef]);
  return {};
}
