// Extracted from ./FactoryCustomerStatement.tsx to keep that module under the source-size cap.
import { useMutation, useQuery } from "@tanstack/react-query";
import { useLocation, useParams } from "wouter";
import { useEscapeToParent } from "@/hooks/use-escape-to-parent";
import { useDateFormat } from "@/contexts/DateFormatContext";
import { useEffect, useMemo, useRef, useState } from "react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { factoryApiRequest } from "@/lib/factoryApi";
import { useToast } from "@/hooks/use-toast";
import { useExistingRecordChangeAccess } from "@/hooks/useExistingRecordChangeAccess";
import * as XLSX from "xlsx-js-style";
import type { FactoryMyAccess } from "@shared/apiTypes";
import { useCompany } from "@/contexts/CompanyContext";
import { companyQueryKey } from "@/lib/companyQueryScope";
import {
  downloadPriceListTemplate,
  LEGACY_PRICE_DESTINATION,
  normalizePriceDestination,
  parsePriceListRows,
  type PriceListEntry,
  type PriceListLine,
  priceListUrl,
  type StatementData,
} from "./factorycustomerstatement/statementHelpers";

export function useFactoryCustomerStatementState() {
  const { selectedCompany } = useCompany();
  const { formatDisplayDate } = useDateFormat();
  const { toast } = useToast();
  const [, navigate] = useLocation();
  useEscapeToParent("/factory/customers");
  const params = useParams<{ id: string }>();
  const customerId = params.id;
  const recordChanges = useExistingRecordChangeAccess();
  const { data: myAccess } = useQuery<FactoryMyAccess>({
    queryKey: companyQueryKey("/api/factory/my-access", selectedCompany?.id),
    enabled: Boolean(selectedCompany?.id),
    staleTime: 5 * 60000,
  });
  const hiddenTabs =
    myAccess?.companyId === selectedCompany?.id && myAccess?.hasFactoryAccess === true
      ? myAccess.hiddenCostFields
      : ["hide_tab_customer_statement", "hide_tab_customer_pricelist"];
  const showStatementTab = !hiddenTabs.includes("hide_tab_customer_statement");
  const showPriceListTab = !hiddenTabs.includes("hide_tab_customer_pricelist");
  const visibleCustomerTabs = [showStatementTab ? "statement" : null, showPriceListTab ? "pricelist" : null].filter(
    (value): value is "statement" | "pricelist" => value !== null
  );
  const [requestedCustomerTab, setRequestedCustomerTab] = useState<"statement" | "pricelist">("statement");
  const activeCustomerTab = visibleCustomerTabs.includes(requestedCustomerTab)
    ? requestedCustomerTab
    : visibleCustomerTabs[0];

  useEffect(() => {
    if (activeCustomerTab && requestedCustomerTab !== activeCustomerTab) {
      setRequestedCustomerTab(activeCustomerTab);
    }
  }, [activeCustomerTab, requestedCustomerTab]);

  const [draftNote, setDraftNote] = useState<string | null>(null);
  const [rowNotes, setRowNotes] = useState<Record<number | string, string>>({});
  const [savingRowNote, setSavingRowNote] = useState<number | null>(null);

  const [filterDestination, setFilterDestination] = useState("");
  const [filterDateFrom, setFilterDateFrom] = useState("");
  const [filterDateTo, setFilterDateTo] = useState("");

  // Prices are scoped by customer and selected destination.
  const [priceDestination, setPriceDestination] = useState("");
  const [newDestination, setNewDestination] = useState("");
  const [priceEdits, setPriceEdits] = useState<Record<string, string>>({});
  const [newCode, setNewCode] = useState("");
  const [newPrice, setNewPrice] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  const { data: statement, isLoading } = useQuery<StatementData>({
    queryKey: companyQueryKey(
      "/api/factory/customers",
      selectedCompany?.id,
      customerId,
      "statement",
      filterDateFrom,
      filterDateTo
    ),
    queryFn: async () => {
      // Re-group at each date boundary: a late charge must never shift into
      // a different accounting period when filtering the statement.
      const params = new URLSearchParams();
      if (filterDateFrom) params.set("dateFrom", filterDateFrom);
      if (filterDateTo) params.set("dateTo", filterDateTo);
      const query = params.toString();
      const res = await fetch(`/api/factory/customers/${customerId}/statement${query ? `?${query}` : ""}`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error((await res.json()).message || "Failed to fetch statement");
      return res.json();
    },
    enabled: !!customerId && Boolean(selectedCompany?.id),
  });

  const priceDestinationsQuery = useQuery<string[]>({
    queryKey: companyQueryKey("/api/factory/customer-price-lists", selectedCompany?.id, customerId, "destinations"),
    enabled: !!customerId && showPriceListTab && Boolean(selectedCompany?.id),
    queryFn: async () => {
      const res = await fetch(`/api/factory/customer-price-lists/${customerId}/destinations`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to load customer price destinations");
      return res.json();
    },
  });

  const priceListQuery = useQuery<PriceListEntry[]>({
    queryKey: companyQueryKey("/api/factory/customer-price-lists", selectedCompany?.id, customerId, priceDestination),
    enabled: !!customerId && !!priceDestination && showPriceListTab && Boolean(selectedCompany?.id),
    queryFn: async () => {
      const res = await fetch(priceListUrl(customerId, priceDestination), { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load destination agreed prices");
      return res.json();
    },
  });

  useEffect(() => {
    setPriceDestination("");
    setPriceEdits({});
    setNewCode("");
    setNewPrice("");
    setNewDestination("");
  }, [customerId]);

  useEffect(() => {
    if (!priceDestination && priceDestinationsQuery.data) {
      setPriceDestination(priceDestinationsQuery.data[0] ?? LEGACY_PRICE_DESTINATION);
    }
  }, [priceDestination, priceDestinationsQuery.data]);

  const selectPriceDestination = (destination: string) => {
    if (!destination || savePricesMutation.isPending || deletePriceMutation.isPending) return;
    const hasPendingEdits = Object.keys(priceEdits).length > 0 || !!(newCode.trim() && newPrice);
    if (hasPendingEdits && !window.confirm("Discard unsaved price edits before changing destination?")) return;
    setPriceDestination(destination);
    setPriceEdits({});
    setNewCode("");
    setNewPrice("");
  };

  const addPriceDestination = () => {
    const destination = normalizePriceDestination(newDestination);
    if (!destination || destination.length > 120 || destination === LEGACY_PRICE_DESTINATION.toUpperCase()) {
      toast({ title: "Enter a valid destination (up to 120 characters)", variant: "destructive" });
      return;
    }
    selectPriceDestination(destination);
    setNewDestination("");
  };

  useEffect(() => {
    if (statement?.customer && draftNote === null) {
      setDraftNote(statement.customer.statementNote ?? "");
    }
    if (statement?.balanceHistory) {
      setRowNotes((prev) => {
        const next: Record<number | string, string> = { ...prev };
        for (const entry of statement.balanceHistory) {
          if (!(entry.id in next)) {
            next[entry.id] = entry.rowNote ?? "";
          }
        }
        return next;
      });
    }
  }, [draftNote, statement]);

  const saveNoteMutation = useMutation({
    mutationFn: async (note: string) => {
      if (!recordChanges.allowed) throw new Error(recordChanges.reason ?? "");
      await apiRequest("PATCH", `/api/factory/customers/${customerId}/statement-note`, { statementNote: note });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/customers"] });
      toast({ title: "Note saved" });
    },
    onError: () => {
      toast({ title: "Failed to save note", variant: "destructive" });
    },
  });

  const savePricesMutation = useMutation({
    mutationFn: async (payload: { destination: string; lines: PriceListLine[] }) => {
      if (!recordChanges.allowed) throw new Error(recordChanges.reason ?? "");
      const res = await factoryApiRequest("PUT", priceListUrl(customerId, payload.destination), payload.lines);
      return (await res.json()) as { saved?: number };
    },
    onSuccess: (data, variables) => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/customer-price-lists"] });
      if (priceDestination === variables.destination) {
        setPriceEdits({});
        setNewCode("");
        setNewPrice("");
      }
      toast({
        title: "Agreed prices saved",
        description: `${data?.saved ?? 0} price(s) updated for ${variables.destination === LEGACY_PRICE_DESTINATION ? "legacy prices" : variables.destination}`,
      });
    },
    onError: () => {
      toast({ title: "Failed to save destination prices", variant: "destructive" });
    },
  });

  const deletePriceMutation = useMutation({
    mutationFn: async (payload: { articleCode: string; destination: string }) => {
      if (!recordChanges.allowed) throw new Error(recordChanges.reason ?? "");
      return factoryApiRequest("DELETE", priceListUrl(customerId, payload.destination, payload.articleCode), {});
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/customer-price-lists"] });
      if (priceDestination === variables.destination) {
        setPriceEdits((prev) => {
          const next = { ...prev };
          delete next[variables.articleCode];
          return next;
        });
      }
      toast({ title: "Price removed from selected destination" });
    },
    onError: () => {
      toast({ title: "Failed to remove destination price", variant: "destructive" });
    },
  });

  const saveRowNote = async (entryId: number | string, note: string) => {
    // Voucher-entry rows have string IDs ("ve-N") — they have no customerBalances record to update
    if (typeof entryId === "string" || !recordChanges.allowed) return;
    const original = statement?.balanceHistory.find((e) => e.id === entryId)?.rowNote ?? "";
    if (note === original) return;
    setSavingRowNote(entryId);
    try {
      await apiRequest("PATCH", `/api/factory/customers/${customerId}/balance/${entryId}/note`, { rowNote: note });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/customers"] });
    } catch {
      toast({ title: "Failed to save row note", variant: "destructive" });
    } finally {
      setSavingRowNote(null);
    }
  };

  const filteredHistory = useMemo(() => {
    if (!statement?.balanceHistory) return [];
    return statement.balanceHistory.filter((entry) => {
      if (filterDestination) {
        const dest = entry.destination?.toLowerCase() ?? "";
        if (!dest.includes(filterDestination.toLowerCase())) return false;
      }
      if (filterDateFrom && entry.transactionDate) {
        if (entry.transactionDate.toString().slice(0, 10) < filterDateFrom) return false;
      }
      if (filterDateTo && entry.transactionDate) {
        if (entry.transactionDate.toString().slice(0, 10) > filterDateTo) return false;
      }
      return true;
    });
  }, [statement?.balanceHistory, filterDestination, filterDateFrom, filterDateTo]);

  const totals = useMemo(() => {
    let totalBales = 0;
    let totalAmountDebit = 0;
    let totalAmountCredit = 0;
    let totalKg = 0;
    for (const entry of filteredHistory) {
      totalAmountDebit += parseFloat(entry.debitAmount || "0");
      totalAmountCredit += parseFloat(entry.creditAmount || "0");
      if (entry.totalQtyBales != null) totalBales += entry.totalQtyBales;
      if (entry.totalWeightKg != null) totalKg += entry.totalWeightKg;
    }
    return { totalBales, totalAmountDebit, totalAmountCredit, totalKg };
  }, [filteredHistory]);

  const hasFilters = filterDestination || filterDateFrom || filterDateTo;

  const handlePriceListTemplateDownload = async () => {
    try {
      await downloadPriceListTemplate();
    } catch {
      toast({ title: "Failed to download price-list template", variant: "destructive" });
    }
  };

  const handleExcelUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !priceDestination) return;
    // Capture the scope before FileReader completes so an import cannot land
    // in whichever destination happens to be selected later.
    const destination = priceDestination;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const data = new Uint8Array(ev.target?.result as ArrayBuffer);
        const workbook = XLSX.read(data, { type: "array" });
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "" });
        const lines = parsePriceListRows(rows);
        if (lines.length === 0) {
          toast({
            title: "No valid rows found",
            description: "Excel must have columns: article_code, price",
            variant: "destructive",
          });
          return;
        }
        savePricesMutation.mutate({ destination, lines });
      } catch {
        toast({ title: "Failed to read file", variant: "destructive" });
      }
    };
    reader.readAsArrayBuffer(file);
    e.target.value = "";
  };

  const handleSavePrices = () => {
    if (!priceDestination) return;
    // Save only edited/new rows: resending stale unchanged prices can overwrite
    // a newer explicit save from another screen.
    const lines: PriceListLine[] = [];
    for (const [articleCode, value] of Object.entries(priceEdits)) {
      const price = Number(value);
      if (!Number.isFinite(price) || price <= 0) {
        toast({ title: `Enter a valid positive price for ${articleCode}`, variant: "destructive" });
        return;
      }
      lines.push({ articleCode, pricePerBale: price });
    }
    if (newCode.trim() && newPrice) {
      const price = Number(newPrice);
      if (!Number.isFinite(price) || price <= 0) {
        toast({ title: "Enter a valid positive new price", variant: "destructive" });
        return;
      }
      lines.push({ articleCode: newCode.trim(), pricePerBale: price });
    }
    if (lines.length === 0) {
      toast({ title: "No valid prices to save", variant: "destructive" });
      return;
    }
    savePricesMutation.mutate({ destination: priceDestination, lines });
  };

  const hasPriceEdits = Object.keys(priceEdits).length > 0 || (newCode.trim() !== "" && newPrice !== "");
  return {
    activeCustomerTab,
    addPriceDestination,
    customerId,
    deletePriceMutation,
    draftNote,
    fileInputRef,
    filterDateFrom,
    filterDateTo,
    filterDestination,
    filteredHistory,
    formatDisplayDate,
    handleExcelUpload,
    handlePriceListTemplateDownload,
    handleSavePrices,
    hasFilters,
    hasPriceEdits,
    isLoading,
    navigate,
    newCode,
    newDestination,
    newPrice,
    priceDestination,
    priceDestinationsQuery,
    priceEdits,
    priceListQuery,
    recordChanges,
    rowNotes,
    saveNoteMutation,
    savePricesMutation,
    saveRowNote,
    savingRowNote,
    selectPriceDestination,
    setDraftNote,
    setFilterDateFrom,
    setFilterDateTo,
    setFilterDestination,
    setNewCode,
    setNewDestination,
    setNewPrice,
    setPriceEdits,
    setRequestedCustomerTab,
    setRowNotes,
    showPriceListTab,
    showStatementTab,
    statement,
    totals,
  };
}
