// Extracted from ./FactoryCustomerStatement.tsx to keep that module under the source-size cap.
import { useMutation, useQuery } from "@tanstack/react-query";
import { useLocation, useParams } from "wouter";
import { useEscapeToParent } from "@/hooks/use-escape-to-parent";
import { useDateFormat } from "@/contexts/DateFormatContext";
import { useEffect, useRef, useState } from "react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { factoryApiRequest } from "@/lib/factoryApi";
import { useToast } from "@/hooks/use-toast";
import { useExistingRecordChangeAccess } from "@/hooks/useExistingRecordChangeAccess";
import type { FactoryMyAccess } from "@shared/apiTypes";
import { useCompany } from "@/contexts/CompanyContext";
import { companyQueryKey } from "@/lib/companyQueryScope";
import {
  LEGACY_PRICE_DESTINATION,
  normalizePriceDestination,
  type PriceListEntry,
  type PriceListLine,
  priceListUrl,
  type StatementData,
} from "./factorycustomerstatement/statementHelpers";
import { confirmAction } from "@/components/ConfirmHost";

export function useFactoryCustomerStatementStatePart1() {
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

  const selectPriceDestination = async (destination: string) => {
    if (!destination || savePricesMutation.isPending || deletePriceMutation.isPending) return;
    const hasPendingEdits = Object.keys(priceEdits).length > 0 || !!(newCode.trim() && newPrice);
    if (
      hasPendingEdits &&
      !(await confirmAction({
        title: "Discard unsaved price edits?",
        description: "Changing destination will discard the price edits you have not saved.",
        confirmText: "Discard",
        tone: "warning",
      }))
    )
      return;
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
    void selectPriceDestination(destination);
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
    formatDisplayDate,
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
    setSavingRowNote,
    showPriceListTab,
    showStatementTab,
    statement,
    toast,
  };
}
