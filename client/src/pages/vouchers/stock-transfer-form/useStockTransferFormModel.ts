import { getErrorDetails } from "@shared/errorUtils";
import type { ClientErrorLike } from "@/lib/clientError";
import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useFieldArray, useForm } from "react-hook-form";
import { zodResolver } from "@/lib/form-resolver";
import { format } from "date-fns";
import { useLocation } from "wouter";
import { useCompany } from "@/contexts/CompanyContext";
import { useCurrencyContext } from "@/contexts/CurrencyContext";
import { useAppMode, useModePrefix } from "@/contexts/AppModeContext";
import { getApiRequest } from "@/lib/factoryApi";
import { queryClient } from "@/lib/queryClient";
import { utils, writeFile } from "@/lib/excelHelper";
import { parseDateLocal } from "@/components/vouchers/PrintTemplate";
import { useToast } from "@/hooks/use-toast";
import type { Location, StockItem, StockTransferFormData, StockTransferFormProps } from "../stocktransferform/types";
import { stockTransferFormSchema } from "../stocktransferform/utils";
import {
  useFilteredTransferInventory,
  usePendingTransferRevisions,
  useTransferRateAutofill,
  type TransferInventoryItem,
} from "./useTransferFormDerived";
import type { StockTransferLineItem, TransferImportValidationResult, TransferRevision } from "./transferFormTypes";
import { computeTransferRevisionDiff } from "./transferRevisionDiff";

export function useStockTransferFormModel({ voucherIdToEdit, isPOS, posUser }: StockTransferFormProps) {
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

  useEffect(() => {
    if (showItemSidebar && transferSidebarRef.current) {
      const container = transferSidebarRef.current;
      const highlighted = container.querySelector(`[data-transfer-idx="${transferHighlightedIndex}"]`);
      if (highlighted) highlighted.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }, [transferHighlightedIndex, showItemSidebar]);

  const approveRevisionMutation = useMutation({
    mutationFn: async (revisionId: number) => {
      return modeApiRequest("POST", `/api/stock-transfer-revisions/${revisionId}/approve`, {});
    },
    onSuccess: () => {
      const applied = pendingTransferRevisions.length;
      toast({
        title: applied > 1 ? `${applied} revisions approved` : "Revision approved",
        description: "Quantities have been updated.",
      });
      setApproveRevisionTarget(null);
      setTransferRevisionsExpanded(true);
      hydratedVoucherIdRef.current = null;
      queryClient.invalidateQueries({
        queryKey: ["/api/stock-transfers", lastKnownTransferIdRef.current, "revisions"],
      });
      queryClient.invalidateQueries({ queryKey: ["/api/stock-transfers", voucherIdToEdit] });
      queryClient.invalidateQueries({ queryKey: ["/api/stock-transfers/list"] });
    },
    onError: (err: ClientErrorLike) => {
      toast({ title: "Approval failed", description: err.message, variant: "destructive" });
    },
  });

  const importParseMutation = useMutation({
    mutationFn: async (formData: FormData) => {
      const res = await fetch("/api/stock-transfer-import/parse-multi-source", { method: "POST", body: formData });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message || "Failed to parse file");
      }
      return res.json();
    },
    onSuccess: (data) => {
      setImportPreview(data);
      setImportValidationResult(null);
      toast({
        title: "File parsed successfully",
        description: `Found ${data.items.length} item(s). Click Validate to check the data.`,
      });
    },
    onError: (error: ClientErrorLike) => {
      if (error?._handledGlobally) return;
      toast({ title: "Parse error", description: error.message, variant: "destructive" });
    },
  });

  const importValidateMutation = useMutation({
    mutationFn: async (data: unknown) => {
      const res = await modeApiRequest("POST", "/api/stock-transfer-import/validate-multi-source", data);
      return res.json();
    },
    onSuccess: (data) => {
      setImportValidationResult(data);
      const errorCount = data.errors?.length || 0;
      if (errorCount === 0) {
        toast({
          title: "Validation passed",
          description: "All items validated successfully. You can now import the data.",
        });
      } else {
        toast({
          title: "Validation issues found",
          description: `Found ${errorCount} issue(s). Please review before importing.`,
          variant: "destructive",
        });
      }
    },
    onError: (error: ClientErrorLike) => {
      if (error?._handledGlobally) return;
      toast({ title: "Validation error", description: error.message, variant: "destructive" });
    },
  });

  const importMutation = useMutation({
    mutationFn: async (data: unknown) => {
      const res = await modeApiRequest("POST", "/api/stock-transfer-import/import-multi-source", data);
      return res.json();
    },
    onSuccess: (data) => {
      toast({ title: "Import successful", description: `${data.itemsCount} items transferred successfully.` });
      queryClient.invalidateQueries({ queryKey: ["/api/vouchers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/inventory-by-location"] });
      queryClient.invalidateQueries({ queryKey: ["/api/daybook"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/daybook"] });
      queryClient.invalidateQueries({ queryKey: ["/api/location-summary"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stock-transfers/list"] });
      setImportDialogOpen(false);
      setImportFile(null);
      setImportPreview(null);
      setImportValidationResult(null);
      setImportDestLocation("");
      setImportNotes("");
    },
    onError: (error: ClientErrorLike) => {
      if (error?._handledGlobally) return;
      toast({ title: "Import error", description: error.message, variant: "destructive" });
    },
  });

  const stockTransferMutation = useMutation({
    mutationFn: async (data: StockTransferFormData) => {
      const isEditMode = !!voucherIdToEdit;
      const validEntries = data.entries.filter(
        (e) => e.stockItemId > 0 && e.sourceLocationId > 0 && parseFloat(e.quantity || "0") > 0
      );
      const totalAmount = validEntries
        .reduce((sum, e) => sum + parseFloat(e.quantity || "0") * parseFloat(e.rate || "0"), 0)
        .toString();

      if (isEditMode) {
        const destLoc = locations.find((l) => l.id === data.destinationLocationId);
        const wasOptional = voucherToEdit?.optional === true;
        const wantOptional = data.optional;
        const isFinalizingTransfer = wasOptional && !wantOptional;

        await modeApiRequest("PATCH", `/api/vouchers/${voucherIdToEdit}`, {
          voucherDate: format(data.voucherDate, "yyyy-MM-dd"),
          description: `Stock transfer to ${destLoc?.name || ""}`,
          totalAmount,
          ...(wantOptional ? { optional: true } : {}),
        });
        if (stockTransferToEdit?.id) {
          await modeApiRequest("PUT", `/api/stock-transfers/${stockTransferToEdit.id}`, {
            destinationLocationId: data.destinationLocationId,
            notes: data.notes || "",
            items: validEntries.map((e) => ({
              stockItemId: e.stockItemId,
              sourceLocationId: e.sourceLocationId,
              quantity: e.quantity,
              rate: e.rate,
            })),
          });
        } else {
          await modeApiRequest("POST", "/api/stock-transfers", {
            voucherId: voucherIdToEdit,
            destinationLocationId: data.destinationLocationId,
            notes: data.notes || "",
            items: validEntries.map((e) => ({
              stockItemId: e.stockItemId,
              sourceLocationId: e.sourceLocationId,
              quantity: e.quantity,
              rate: e.rate,
            })),
          });
        }
        if (isFinalizingTransfer) {
          await modeApiRequest("POST", `/api/vouchers/${voucherIdToEdit}/finalize`, {});
        }
        return { id: voucherIdToEdit };
      }

      const destLoc = locations.find((l) => l.id === data.destinationLocationId);
      const voucherRes = await modeApiRequest("POST", "/api/vouchers", {
        companyId: selectedCompany?.id,
        voucherType: "Stock Transfer",
        voucherNumber: `TRANSFER-${Date.now()}`,
        voucherDate: format(data.voucherDate, "yyyy-MM-dd"),
        description: `Stock transfer to ${destLoc?.name || ""}`,
        totalAmount,
        optional: data.optional,
      });
      const voucher = await voucherRes.json();
      await modeApiRequest("POST", "/api/stock-transfers", {
        voucherId: voucher.id,
        destinationLocationId: data.destinationLocationId,
        notes: data.notes || "",
        items: validEntries.map((e) => ({
          stockItemId: e.stockItemId,
          sourceLocationId: e.sourceLocationId,
          quantity: e.quantity,
          rate: e.rate,
        })),
      });
      return voucher;
    },
    onSuccess: () => {
      const isEditMode = !!voucherIdToEdit;
      if (!savingTransferRevisionRef.current) {
        toast({ title: "Success", description: `Stock transfer ${isEditMode ? "updated" : "created"} successfully` });
      }
      queryClient.invalidateQueries({ queryKey: ["/api/vouchers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/daybook"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/daybook"] });
      queryClient.invalidateQueries({ queryKey: ["/api/inventory-by-location"] });
      queryClient.invalidateQueries({ queryKey: ["/api/location-summary"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stock-transfers/list"] });
      if (isEditMode) {
        if (!savingTransferRevisionRef.current) setLocation(`${modePrefix}/daybook`);
      } else {
        stockTransferForm.reset({
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
        });
      }
    },
    onError: (error: ClientErrorLike) => {
      if (error?._handledGlobally) return;
      const isEditMode = !!voucherIdToEdit;
      toast({
        title: "Error",
        description: error.message || `Failed to ${isEditMode ? "update" : "create"} stock transfer`,
        variant: "destructive",
      });
    },
  });

  const computeTransferRevisionItems = () =>
    computeTransferRevisionDiff(
      stockTransferToEdit?.items,
      stockItems,
      locations,
      stockTransferForm.getValues("entries")
    );

  const handleTransferSaveAsRevision = () => {
    if (!voucherIdToEdit || !stockTransferToEdit?.id) return;
    setTransferRevisionDialogOpen(true);
  };

  const confirmTransferSaveAsRevision = async () => {
    const transferId = stockTransferToEdit?.id ?? lastKnownTransferIdRef.current;
    if (!voucherIdToEdit || !transferId) {
      toast({
        title: "Revision Not Saved",
        description: "The saved stock transfer could not be identified. Reload the transfer and try again.",
        variant: "destructive",
      });
      return;
    }
    const revisionItems = computeTransferRevisionItems();
    if (revisionItems.length === 0) {
      toast({
        title: "No Changes",
        description: "No differences found compared to the saved order",
        variant: "destructive",
      });
      setTransferRevisionDialogOpen(false);
      return;
    }
    setIsTransferSavingRevision(true);
    savingTransferRevisionRef.current = true;
    try {
      // POS users are only allowed to submit a pending revision for review.
      // Do not submit the transfer itself first: that update endpoint is
      // intentionally restricted to non-POS users and would reject the
      // revision flow before the pending revision can be saved.
      if (!isPOS) {
        let submitted = false;
        await stockTransferForm.handleSubmit(async (data) => {
          submitted = true;
          await onStockTransferSubmit(data);
        })();
        if (!submitted) return;
      }
      const revisionResponse = await modeApiRequest("POST", `/api/stock-transfers/${transferId}/revisions`, {
        note: transferRevisionNote.trim() || null,
        items: revisionItems,
        optional: isPOS,
      });
      if (!revisionResponse.ok) {
        let message = "The transfer was updated, but its revision record could not be saved.";
        try {
          const body = await revisionResponse.json();
          message = body?.message || body?.error || message;
        } catch {
          // Failure here is non-fatal and the surrounding flow continues deliberately.
        }
        throw new Error(message);
      }
      const transferRevisionPath = `/api/stock-transfers/${transferId}/revisions`;
      const voucherRevisionPath = `/api/stock-transfers/by-voucher/${voucherIdToEdit}/revisions`;
      await Promise.all([
        queryClient.refetchQueries({ queryKey: ["/api/stock-transfers", transferId, "revisions"] }),
        queryClient.refetchQueries({ queryKey: [transferRevisionPath] }),
        queryClient.refetchQueries({ queryKey: [voucherRevisionPath] }),
      ]);
      setTransferRevisionNote("");
      setTransferRevisionDialogOpen(false);
      setTransferRevisionsExpanded(true);
      const refreshedRevisions = queryClient.getQueryData<TransferRevision[]>([
        "/api/stock-transfers",
        transferId,
        "revisions",
      ]);
      const nextRevNum = refreshedRevisions?.length ?? transferRevisions.length + 1;
      toast({ title: "Revision Saved", description: `Rev ${nextRevNum} recorded and transfer updated` });
    } catch (error) {
      toast({
        title: "Revision Not Saved",
        description:
          getErrorDetails(error).optionalMessage ||
          "The transfer was updated, but the revision record failed to save. Please try again.",
        variant: "destructive",
      });
    } finally {
      savingTransferRevisionRef.current = false;
      setIsTransferSavingRevision(false);
    }
  };

  const onStockTransferSubmit = async (data: StockTransferFormData) => {
    if (!data.destinationLocationId || data.destinationLocationId <= 0) {
      toast({ title: "Validation Error", description: "Please select a destination location", variant: "destructive" });
      return;
    }
    const validEntries = data.entries.filter(
      (e) => e.stockItemId > 0 && e.sourceLocationId > 0 && parseFloat(e.quantity || "0") > 0
    );
    if (validEntries.length === 0) {
      toast({
        title: "Validation Error",
        description: "Please add at least one valid entry with source location, item, and quantity",
        variant: "destructive",
      });
      return;
    }
    const entriesWithMissingRates = validEntries.filter((e) => !e.rate || e.rate === "" || e.rate === "0");
    if (entriesWithMissingRates.length > 0) {
      const ratePromises = entriesWithMissingRates.map(async (entry) => {
        try {
          const res = await fetch(`/api/locations/${entry.sourceLocationId}/inventory`);
          if (res.ok) {
            const inventory = await res.json();
            const inv = (inventory as TransferInventoryItem[]).find((item) => item.stockItemId === entry.stockItemId);
            return {
              stockItemId: entry.stockItemId,
              sourceLocationId: entry.sourceLocationId,
              rate: inv?.averageRate || "0",
            };
          }
        } catch {
          // Failure here is non-fatal and the surrounding flow continues deliberately.
        }
        return { stockItemId: entry.stockItemId, sourceLocationId: entry.sourceLocationId, rate: "0" };
      });
      const fetchedRates = await Promise.all(ratePromises);
      for (const entry of validEntries) {
        if (!entry.rate || entry.rate === "" || entry.rate === "0") {
          const fetched = fetchedRates.find(
            (r) => r.stockItemId === entry.stockItemId && r.sourceLocationId === entry.sourceLocationId
          );
          if (fetched) entry.rate = fetched.rate;
        }
      }
    }
    data.entries = data.entries.filter(
      (e) => !(e.stockItemId > 0 && e.sourceLocationId > 0 && parseFloat(e.quantity) === 0)
    );
    const isEditMode = !!voucherIdToEdit;
    let originalItems: StockTransferLineItem[] = [];
    if (isEditMode && voucherIdToEdit) {
      let st = stockTransferToEdit as ({ items?: StockTransferLineItem[] } & Record<string, unknown>) | undefined;
      if (!st) {
        try {
          const res = await fetch(`/api/stock-transfers?voucherId=${voucherIdToEdit}`);
          if (res.ok) {
            const d = await res.json();
            st = Array.isArray(d) ? d[0] : d;
          }
        } catch {
          // Best-effort side request; the user-visible flow does not depend on it completing.
        }
      }
      if (st?.items) originalItems = st.items;
    }
    void originalItems;
    await stockTransferMutation.mutateAsync(data);
  };

  const handleExportStockTransfer = async (detailed: boolean) => {
    const formData = stockTransferForm.getValues();
    const voucherDate = formData.voucherDate
      ? format(formData.voucherDate, "yyyy-MM-dd")
      : format(new Date(), "yyyy-MM-dd");
    const validEntries = formData.entries.filter((e) => e.stockItemId > 0 && parseFloat(e.quantity) > 0);
    if (validEntries.length === 0) {
      toast({
        title: "No data to export",
        description: "Add at least one entry before exporting.",
        variant: "destructive",
      });
      return;
    }
    const destLoc = locations?.find((l) => l.id === formData.destinationLocationId);
    const destLocationName = destLoc?.name || "";
    if (detailed) {
      const exportData = validEntries.map((entry) => ({
        Date: voucherDate,
        "Source Location": entry.sourceLocationName || "",
        "Destination Location": destLocationName,
        "Item Code": entry.stockItemCode || "",
        "Item Name": entry.stockItemName || "",
        Quantity: parseFloat(entry.quantity).toFixed(2),
        Rate: parseFloat(entry.rate || "0").toFixed(2),
        Amount: (parseFloat(entry.quantity) * parseFloat(entry.rate || "0")).toFixed(2),
        Notes: formData.notes || "",
        Optional: formData.optional ? "Yes" : "No",
      }));
      const worksheet = utils.json_to_sheet(exportData);
      const workbook = utils.book_new();
      utils.book_append_sheet(workbook, worksheet, "Stock Transfer Detailed");
      const fileName = `Stock_Transfer_Detailed_${voucherDate}.xlsx`;
      await writeFile(workbook, fileName);
      toast({ title: "Export successful", description: `Downloaded ${fileName} with ${validEntries.length} items.` });
    } else {
      const totalQty = validEntries.reduce((sum: number, e) => sum + parseFloat(e.quantity), 0);
      const totalAmount = validEntries.reduce(
        (sum: number, e) => sum + parseFloat(e.quantity) * parseFloat(e.rate || "0"),
        0
      );
      const exportData = [
        {
          "Voucher Type": "Stock Transfer",
          Date: voucherDate,
          "Destination Location": destLocationName,
          "Total Items": validEntries.length,
          "Total Quantity": totalQty.toFixed(2),
          "Total Amount": totalAmount.toFixed(2),
          Notes: formData.notes || "",
          Optional: formData.optional ? "Yes" : "No",
        },
      ];
      const worksheet = utils.json_to_sheet(exportData);
      const workbook = utils.book_new();
      utils.book_append_sheet(workbook, worksheet, "Stock Transfer Summary");
      const fileName = `Stock_Transfer_Summary_${voucherDate}.xlsx`;
      await writeFile(workbook, fileName);
      toast({ title: "Export successful", description: `Downloaded ${fileName}.` });
    }
  };

  const handleImportFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = e.target.files?.[0];
    if (selectedFile) {
      setImportFile(selectedFile);
      setImportPreview(null);
      setImportValidationResult(null);
    }
  };
  const handleImportParse = () => {
    if (!importFile) {
      toast({
        title: "No file selected",
        description: "Please select an Excel file to upload",
        variant: "destructive",
      });
      return;
    }
    const formData = new FormData();
    formData.append("file", importFile);
    importParseMutation.mutate(formData);
  };
  const handleImportValidate = () => {
    if (!importDestLocation) {
      toast({
        title: "Destination required",
        description: "Please select a destination location",
        variant: "destructive",
      });
      return;
    }
    if (!importPreview) {
      toast({ title: "No preview data", description: "Please parse the file first", variant: "destructive" });
      return;
    }
    importValidateMutation.mutate({ destinationLocationId: parseInt(importDestLocation), items: importPreview.items });
  };
  const handleImportSubmit = () => {
    if (!importDestLocation || !importPreview || !importValidationResult?.validatedItems) {
      toast({
        title: "Cannot import",
        description: "Please parse, validate, and fix any errors first",
        variant: "destructive",
      });
      return;
    }
    const validItems = importValidationResult.validatedItems.filter((item) => !item.error);
    if (importValidationResult?.errors?.length > 0) {
      setImportConfirmDialogOpen(true);
      return;
    }
    importMutation.mutate({
      destinationLocationId: parseInt(importDestLocation),
      transferDate: importDate,
      notes: importNotes,
      items: validItems,
    });
  };
  const handleConfirmedImport = () => {
    const validItems = importValidationResult?.validatedItems?.filter((item) => !item.error) || [];
    setImportConfirmDialogOpen(false);
    if (validItems.length === 0) {
      setImportDialogOpen(false);
      setImportFile(null);
      setImportPreview(null);
      setImportValidationResult(null);
      setImportDestLocation("");
      setImportDate(new Date().toLocaleDateString("en-CA"));
      setImportNotes("");
      toast({ title: "No items imported", description: "All items had validation errors. No transfer was created." });
      return;
    }
    importMutation.mutate({
      destinationLocationId: parseInt(importDestLocation),
      transferDate: importDate,
      notes: importNotes,
      items: validItems,
    });
  };
  const downloadImportTemplate = () => window.open("/api/stock-transfer-import/template-multi-source", "_blank");

  return {
    voucherIdToEdit,
    isPOS,
    toast,
    formatAmount,
    setLocation,
    stockItems,
    locations,
    myLocations,
    posLocationName,
    posSelectedSourceId,
    setPosSelectedSourceId,
    posSelectedSourceName,
    stockTransferToEdit,
    stableTransferId,
    transferRevisions,
    pendingTransferRevisions,
    stockTransferForm,
    transferFields,
    appendTransfer,
    removeTransfer,
    transferEntries,
    transferTotal,
    activeTransferRow,
    setActiveTransferRow,
    transferInventorySource,
    setTransferInventorySource,
    transferSearchTerm,
    setTransferSearchTerm,
    transferHighlightedIndex,
    setTransferHighlightedIndex,
    transferSourceSearchTerm,
    setTransferSourceSearchTerm,
    transferSourceHighlightedIndex,
    setTransferSourceHighlightedIndex,
    showSourceSidebar,
    setShowSourceSidebar,
    showItemSidebar,
    setShowItemSidebar,
    activeFieldType,
    setActiveFieldType,
    transferSidebarRef,
    transferFocusIdRef,
    transferQtyDraft,
    setTransferQtyDraft,
    transferInventory,
    filteredTransferInventory,
    transferRevisionDialogOpen,
    setTransferRevisionDialogOpen,
    transferRevisionNote,
    setTransferRevisionNote,
    isTransferSavingRevision,
    transferRevisionsExpanded,
    setTransferRevisionsExpanded,
    approveRevisionTarget,
    setApproveRevisionTarget,
    approveRevisionMutation,
    importDialogOpen,
    setImportDialogOpen,
    importFile,
    importPreview,
    importValidationResult,
    importDestLocation,
    setImportDestLocation,
    importDate,
    setImportDate,
    importNotes,
    setImportNotes,
    importConfirmDialogOpen,
    setImportConfirmDialogOpen,
    importIsValidated,
    importHasErrors,
    importValidItemsCount,
    importTotalItemsCount,
    importParseMutation,
    importValidateMutation,
    importMutation,
    stockTransferMutation,
    modeApiRequest,
    lastKnownTransferIdRef,
    computeTransferRevisionItems,
    handleTransferSaveAsRevision,
    confirmTransferSaveAsRevision,
    onStockTransferSubmit,
    handleExportStockTransfer,
    handleImportFileChange,
    handleImportParse,
    handleImportValidate,
    handleImportSubmit,
    handleConfirmedImport,
    downloadImportTemplate,
  };
}
export type StockTransferFormModel = ReturnType<typeof useStockTransferFormModel>;
