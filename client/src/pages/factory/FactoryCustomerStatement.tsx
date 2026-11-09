import { useQuery, useMutation } from "@tanstack/react-query";
import { useParams, useLocation } from "wouter";
import { useEscapeToParent } from "@/hooks/use-escape-to-parent";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ArrowLeft, X, ExternalLink, Upload, Download, Plus, Save, Trash2 } from "lucide-react";
import { useDateFormat } from "@/contexts/DateFormatContext";
import { CustomerStatementExports } from "./factorycustomerstatement/CustomerStatementExports";
import { drCrClass } from "@/lib/formatNumber";
import { useState, useEffect, useMemo, useRef } from "react";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { factoryApiRequest } from "@/lib/factoryApi";
import { useToast } from "@/hooks/use-toast";
import { PageHeader } from "@/components/PageHeader";
import * as XLSX from "xlsx-js-style";
import type { FactoryMyAccess } from "@shared/apiTypes";
import { useCompany } from "@/contexts/CompanyContext";
import { companyQueryKey } from "@/lib/companyQueryScope";
import {
  type LedgerSplitFields,
  type NotInLedgerRowFields,
} from "./factorycustomerstatement/NotInLedgerParts";

interface CustomerInfo {
  id: number;
  code: string;
  legalName: string;
  phone: string | null;
  openingBalance: string | null;
  openingBalanceSide: string | null;
  active: boolean;
  statementNote: string | null;
}

interface BalanceEntry extends NotInLedgerRowFields {
  id: number | string; // numeric for customerBalances rows, "ve-{n}" for voucher-entry rows
  transactionDate: string;
  transactionType: string;
  description: string | null;
  referenceType: string | null;
  referenceId: number | null;
  debitAmount: string;
  creditAmount: string;
  balance: string;
  currency: string;
  containerNumber: string | null;
  destination: string | null;
  totalQtyBales: number | null;
  totalWeightKg: number | null;
  runningBalance: number;
  runningBalanceSide: string;
  rowNote: string | null;
}

interface StatementData extends LedgerSplitFields {
  customer: CustomerInfo;
  invoices: unknown[];
  balanceHistory: BalanceEntry[];
  currentBalance: number;
  currentBalanceSide: string;
  openingBalance: number;
  openingBalanceSide: string;
}

interface PriceListEntry {
  article_code: string;
  item_name: string;
  price_per_bale: string;
  updated_at: string;
}

// Older customer-wide prices are retained for reference, but never used as
// destination-specific agreed prices on new proformas.
const LEGACY_PRICE_DESTINATION = "__legacy__";

function priceListUrl(customerId: string | undefined, destination: string, articleCode?: string): string {
  const base = `/api/factory/customer-price-lists/${customerId}`;
  const path = articleCode ? `${base}/${encodeURIComponent(articleCode)}` : base;
  return destination === LEGACY_PRICE_DESTINATION
    ? path
    : `${path}?destination=${encodeURIComponent(destination)}`;
}

function normalizePriceDestination(value: string): string {
  const normalized = value.trim().replace(/\s+/g, " ").toUpperCase().replace(/[\u2019\u2018]/g, "'");
  if (["LUBUMBASHI", "LSHI", "L'SHI", "L SHI"].includes(normalized)) return "L'SHI";
  if (normalized === "MALI 53") return "MALI";
  return normalized;
}

function fmtMoney(value: number | null | undefined): string {
  if (value == null || isNaN(value)) return "$0";
  const abs = Math.abs(value);
  if (abs % 1 === 0) {
    return `$${Math.round(abs).toLocaleString()}`;
  }
  return `$${abs.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtNum(value: number | null | undefined): string {
  if (value == null || isNaN(value)) return "0";
  if (value % 1 === 0) return Math.round(value).toLocaleString();
  return value.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

export default function FactoryCustomerStatement() {
  const { selectedCompany } = useCompany();
  const { formatDisplayDate } = useDateFormat();
  const { toast } = useToast();
  const [, navigate] = useLocation();
  useEscapeToParent("/factory/customers");
  const params = useParams<{ id: string }>();
  const customerId = params.id;
  const { data: myAccess } = useQuery<FactoryMyAccess>({
    queryKey: companyQueryKey("/api/factory/my-access", selectedCompany?.id),
    enabled: Boolean(selectedCompany?.id),
    staleTime: 5 * 60000,
  });
  const hiddenTabs = myAccess?.companyId === selectedCompany?.id && myAccess?.hasFactoryAccess === true
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
    queryKey: companyQueryKey("/api/factory/customers", selectedCompany?.id, customerId, "statement", filterDateFrom, filterDateTo),
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
      await apiRequest("PATCH", `/api/factory/customers/${customerId}/statement-note`, { statementNote: note });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/customers", customerId, "statement"] });
      toast({ title: "Note saved" });
    },
    onError: () => {
      toast({ title: "Failed to save note", variant: "destructive" });
    },
  });

  const savePricesMutation = useMutation({
    mutationFn: async (payload: {
      destination: string;
      lines: { articleCode: string; pricePerBale: string | number }[];
    }) => {
      const res = await factoryApiRequest("PUT", priceListUrl(customerId, payload.destination), payload.lines);
      return (await res.json()) as { saved?: number };
    },
    onSuccess: (data, variables) => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/customer-price-lists", customerId] });
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
      return factoryApiRequest("DELETE", priceListUrl(customerId, payload.destination, payload.articleCode), {});
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/customer-price-lists", customerId] });
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
    if (typeof entryId === "string") return;
    const original = statement?.balanceHistory.find((e) => e.id === entryId)?.rowNote ?? "";
    if (note === original) return;
    setSavingRowNote(entryId);
    try {
      await apiRequest("PATCH", `/api/factory/customers/${customerId}/balance/${entryId}/note`, { rowNote: note });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/customers", customerId, "statement"] });
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
    // The first sheet matches the importer headers and contains no fake example articles.
    const workbook = XLSX.utils.book_new();
    const sheet = XLSX.utils.aoa_to_sheet([["article_code", "price"]]);
    sheet["!cols"] = [{ wch: 28 }, { wch: 18 }];
    sheet["!rows"] = [{ hpt: 26 }];
    sheet["!autofilter"] = { ref: "A1:B1" };
    for (const cell of ["A1", "B1"]) {
      sheet[cell].s = {
        font: { bold: true, color: { rgb: "FFFFFF" } },
        fill: { patternType: "solid", fgColor: { rgb: "1E293B" } },
        alignment: { vertical: "center" },
      };
    }
    XLSX.utils.book_append_sheet(workbook, sheet, "Price List");

    const guide = XLSX.utils.aoa_to_sheet([
      ["How to upload agreed prices"],
      ["1. In Price List, enter existing article codes under article_code and positive USD prices per bale under price."],
      ["2. Keep both headers unchanged. Enter prices as numbers without a dollar sign."],
      ["3. In the ERP, select the correct customer and destination, then use Upload Excel."],
      ["4. Only that customer and destination are updated; existing proforma line prices are not changed."],
    ]);
    guide["!cols"] = [{ wch: 110 }];
    guide["A1"].s = {
      font: { bold: true, color: { rgb: "FFFFFF" } },
      fill: { patternType: "solid", fgColor: { rgb: "1E293B" } },
    };
    XLSX.utils.book_append_sheet(workbook, guide, "Instructions");

    try {
      await XLSX.writeFile(workbook, "agreed-prices-upload-template.xlsx");
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
        const lines: { articleCode: string; pricePerBale: string | number }[] = [];
        for (const row of rows) {
          const code = String(
            row["article_code"] ?? row["Article Code"] ?? row["ARTICLE_CODE"] ?? row["code"] ?? ""
          ).trim();
          const price =
            row["price"] ?? row["price_per_bale"] ?? row["Price"] ?? row["Price Per Bale"] ?? row["PRICE"] ?? "";
          if (code && price !== "") {
            const p = parseFloat(String(price));
            if (!isNaN(p) && p > 0) lines.push({ articleCode: code, pricePerBale: p });
          }
        }
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
    const lines: { articleCode: string; pricePerBale: string | number }[] = [];
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

  if (isLoading) {
    return (
      <div className="flex flex-col h-full p-6 space-y-4">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (!statement) {
    return (
      <div className="flex flex-col items-center justify-center h-full p-6">
        <p className="text-muted-foreground" data-testid="text-not-found">
          Customer not found
        </p>
        <Button
          variant="outline"
          className="mt-4"
          onClick={() => navigate("/factory/customers")}
          data-testid="button-back"
        >
          <ArrowLeft className="mr-2 h-4 w-4" />
          Back to Customers
        </Button>
      </div>
    );
  }

  const { customer, currentBalance, currentBalanceSide, openingBalance, openingBalanceSide } = statement;
  const hasOpeningBalance = Number(openingBalance || 0) !== 0;

  return (
    <div className="flex h-full flex-col overflow-y-auto sm:p-6">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-2 mb-6">
        <Button variant="ghost" size="icon" onClick={() => navigate("/factory/customers")} data-testid="button-back">
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-3">
            <PageHeader title={customer.legalName} />
            <Badge variant={customer.active ? "default" : "secondary"} data-testid="badge-customer-status">
              {customer.active ? "Active" : "Inactive"}
            </Badge>
          </div>
          {customer.phone && (
            <p className="text-muted-foreground text-sm mt-1" data-testid="text-customer-phone">
              {customer.phone}
            </p>
          )}
        </div>
        {showStatementTab && (
          <CustomerStatementExports
            customerId={customerId}
            filterDateFrom={filterDateFrom}
            filterDateTo={filterDateTo}
            filterDestination={filterDestination}
          />
        )}
      </div>

      {/* Balance cards */}
      {showStatementTab && (
        <div className={`grid grid-cols-1 gap-4 mb-6 ${hasOpeningBalance ? "sm:grid-cols-3" : "sm:grid-cols-2"}`}>
          <div className="rounded-xl border p-4">
            <p className="text-xs text-muted-foreground mb-1">Current Balance</p>
            <p className="text-2xl font-bold font-mono" data-testid="text-current-balance">
              {fmtMoney(currentBalance)}
            </p>
            <Badge variant="outline" className="mt-1 text-xs" data-testid="badge-balance-side">
              {currentBalanceSide}
            </Badge>
          </div>
          {hasOpeningBalance && (
            <div className="rounded-xl border p-4">
              <p className="text-xs text-muted-foreground mb-1">Opening Balance</p>
              <p className="text-xl font-semibold font-mono" data-testid="text-opening-balance">
                {fmtMoney(Number(openingBalance || 0))}
              </p>
              <Badge variant="outline" className="mt-1 text-xs">
                {openingBalanceSide}
              </Badge>
            </div>
          )}
          <div className="rounded-xl border p-4">
            <p className="text-xs text-muted-foreground mb-1">Total Invoices</p>
            <p className="text-2xl font-bold" data-testid="text-total-invoices">
              {statement.invoices.length}
            </p>
          </div>
        </div>
      )}

      {/* Tabs */}
      {activeCustomerTab ? (
        <Tabs
          value={activeCustomerTab}
          onValueChange={(value) => setRequestedCustomerTab(value as "statement" | "pricelist")}
          className="flex-1"
        >
          <div className="erp-mobile-scroll-tabs mb-4 pb-1">
            <TabsList className="w-max min-w-full sm:min-w-0 sm:w-fit" aria-label="Customer statement sections">
              {showStatementTab && (
                <TabsTrigger value="statement" data-testid="tab-statement">
                  Statement
                </TabsTrigger>
              )}
              {showPriceListTab && (
                <TabsTrigger value="pricelist" data-testid="tab-pricelist">
                  Price List
                  {(priceListQuery.data?.length ?? 0) > 0 && (
                    <Badge
                      variant="secondary"
                      className="ml-2 text-[11px] no-default-hover-elevate no-default-active-elevate"
                    >
                      {priceListQuery.data!.length}
                    </Badge>
                  )}
                </TabsTrigger>
              )}
            </TabsList>
          </div>

          {/* ─── Statement Tab ─── */}
          {showStatementTab && (
            <TabsContent value="statement">
              {/* Filters */}
              <div className="flex flex-wrap items-end gap-3 mb-4">
                <div className="flex flex-col gap-1">
                  <label className="text-xs text-muted-foreground font-medium">Destination</label>
                  <Input
                    value={filterDestination}
                    onChange={(e) => setFilterDestination(e.target.value)}
                    placeholder="Filter by destination…"
                    className="w-48"
                    data-testid="input-filter-destination"
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <label className="text-xs text-muted-foreground font-medium">Date From</label>
                  <Input
                    type="date"
                    value={filterDateFrom}
                    onChange={(e) => setFilterDateFrom(e.target.value)}
                    className="w-40"
                    data-testid="input-filter-date-from"
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <label className="text-xs text-muted-foreground font-medium">Date To</label>
                  <Input
                    type="date"
                    value={filterDateTo}
                    onChange={(e) => setFilterDateTo(e.target.value)}
                    className="w-40"
                    data-testid="input-filter-date-to"
                  />
                </div>
                {hasFilters && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setFilterDestination("");
                      setFilterDateFrom("");
                      setFilterDateTo("");
                    }}
                    data-testid="button-clear-filters"
                  >
                    <X className="h-4 w-4 mr-1" />
                    Clear
                  </Button>
                )}
                <p className="text-xs text-muted-foreground ml-auto self-end">
                  {filteredHistory.length} of {statement.balanceHistory.length} rows
                </p>
              </div>

              {/* Totals bar */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
                <div className="rounded-xl border p-3">
                  <p className="text-xs text-muted-foreground mb-0.5">Total Bales</p>
                  <p className="text-lg font-bold font-mono" data-testid="text-total-bales">
                    {fmtNum(totals.totalBales)}
                  </p>
                </div>
                <div className="rounded-xl border p-3">
                  <p className="text-xs text-muted-foreground mb-0.5">Total Invoiced</p>
                  <p className="text-lg font-bold font-mono" data-testid="text-total-debit">
                    {fmtMoney(totals.totalAmountDebit)}
                  </p>
                </div>
                <div className="rounded-xl border p-3">
                  <p className="text-xs text-muted-foreground mb-0.5">Total Paid</p>
                  <p className="text-lg font-bold font-mono" data-testid="text-total-credit">
                    {fmtMoney(totals.totalAmountCredit)}
                  </p>
                </div>
              </div>

              {/* Statement table */}
              <div className="rounded-xl border overflow-hidden table-responsive">
                <Table mobileLayout="cards">
                  <TableHeader className="sticky top-0 z-30">
                    <TableRow className="bg-muted border-b-2 border-border/60 hover:bg-muted">
                      <TableHead className="text-xs font-semibold uppercase tracking-wide text-muted-foreground py-2">
                        Date
                      </TableHead>
                      <TableHead className="text-xs font-semibold uppercase tracking-wide text-muted-foreground py-2">
                        Type
                      </TableHead>
                      <TableHead className="text-xs font-semibold uppercase tracking-wide text-muted-foreground py-2">
                        Container
                      </TableHead>
                      <TableHead className="text-xs font-semibold uppercase tracking-wide text-muted-foreground py-2">
                        Destination
                      </TableHead>
                      <TableHead className="text-right text-xs font-semibold uppercase tracking-wide text-muted-foreground py-2">
                        Bales
                      </TableHead>
                      <TableHead className="text-right text-xs font-semibold uppercase tracking-wide text-muted-foreground py-2">
                        Kg
                      </TableHead>
                      <TableHead className="text-right text-xs font-semibold uppercase tracking-wide text-muted-foreground py-2">
                        Debit
                      </TableHead>
                      <TableHead className="text-right text-xs font-semibold uppercase tracking-wide text-muted-foreground py-2">
                        Credit
                      </TableHead>
                      <TableHead className="text-right text-xs font-semibold uppercase tracking-wide text-muted-foreground py-2">
                        Balance
                      </TableHead>
                      <TableHead className="text-xs font-semibold uppercase tracking-wide text-muted-foreground py-2">
                        Side
                      </TableHead>
                      <TableHead className="min-w-[160px] text-xs font-semibold uppercase tracking-wide text-muted-foreground py-2">
                        Note
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredHistory.length === 0 ? (
                      <TableRow>
                        <TableCell
                          colSpan={11}
                          className="text-center text-muted-foreground py-8"
                          data-testid="text-no-transactions"
                        >
                          {hasFilters ? "No rows match the current filters" : "No transactions yet"}
                        </TableCell>
                      </TableRow>
                    ) : (
                      filteredHistory.map((entry) => {
                        const isInvoice = entry.referenceType === "INVOICE" && entry.referenceId;
                        return (
                          <TableRow
                            key={entry.id}
                            data-testid={`row-balance-${entry.id}`}
                            className={isInvoice ? "cursor-pointer hover-elevate" : undefined}
                            onClick={
                              isInvoice ? () => navigate(`/factory/sales/invoices/${entry.referenceId}`) : undefined
                            }
                          >
                            <TableCell
                              className="text-sm font-mono whitespace-nowrap"
                              data-testid={`text-balance-date-${entry.id}`}
                            >
                              {entry.transactionDate ? formatDisplayDate(entry.transactionDate) : "-"}
                            </TableCell>
                            <TableCell data-testid={`text-balance-type-${entry.id}`}>
                              <div className="flex items-center gap-1.5">
                                <Badge variant="outline" className="text-xs">
                                  {entry.transactionType}
                                </Badge>
                                {isInvoice && <ExternalLink className="h-3 w-3 text-muted-foreground shrink-0" />}

                              </div>
                            </TableCell>
                            <TableCell
                              className="text-sm font-mono text-muted-foreground whitespace-nowrap"
                              data-testid={`text-balance-container-${entry.id}`}
                            >
                              {entry.containerNumber || "-"}
                            </TableCell>
                            <TableCell
                              className="text-sm text-muted-foreground"
                              data-testid={`text-balance-destination-${entry.id}`}
                            >
                              {entry.destination || "-"}
                            </TableCell>
                            <TableCell
                              className="text-right font-mono text-sm"
                              data-testid={`text-balance-bales-${entry.id}`}
                            >
                              {entry.totalQtyBales != null ? fmtNum(entry.totalQtyBales) : "-"}
                            </TableCell>
                            <TableCell
                              className="text-right font-mono text-sm"
                              data-testid={`text-balance-kg-${entry.id}`}
                            >
                              {entry.totalWeightKg != null ? fmtNum(entry.totalWeightKg) : "-"}
                            </TableCell>
                            <TableCell
                              className="text-right font-mono text-sm"
                              data-testid={`text-balance-debit-${entry.id}`}
                            >
                              {Number(entry.debitAmount || 0) > 0 ? fmtMoney(Number(entry.debitAmount)) : "-"}
                            </TableCell>
                            <TableCell
                              className="text-right font-mono text-sm"
                              data-testid={`text-balance-credit-${entry.id}`}
                            >
                              {Number(entry.creditAmount || 0) > 0 ? fmtMoney(Number(entry.creditAmount)) : "-"}
                            </TableCell>
                            <TableCell
                              className="text-right font-mono font-semibold"
                              data-testid={`text-balance-running-${entry.id}`}
                            >
                              {fmtMoney(Math.abs(entry.runningBalance))}
                            </TableCell>
                            <TableCell>
                              <Badge
                                variant="outline"
                                className={`text-xs font-semibold ${drCrClass(entry.runningBalanceSide)}`}
                              >
                                {entry.runningBalanceSide}
                              </Badge>
                            </TableCell>
                            <TableCell
                              className="min-w-[160px]"
                              data-mobile-cell="wide"
                              onClick={(e) => e.stopPropagation()}
                            >
                              <input
                                type="text"
                                value={rowNotes[entry.id] ?? ""}
                                onChange={(e) =>
                                  typeof entry.id === "number" &&
                                  setRowNotes((prev) => ({ ...prev, [entry.id]: e.target.value }))
                                }
                                onBlur={() => saveRowNote(entry.id, rowNotes[entry.id] ?? "")}
                                placeholder={typeof entry.id === "string" ? "—" : "Add note…"}
                                disabled={savingRowNote === entry.id || typeof entry.id === "string"}
                                className="w-full text-xs bg-transparent border border-border rounded-sm px-2 py-1 placeholder:text-muted-foreground/50 focus:outline-hidden focus:ring-1 focus:ring-ring disabled:opacity-50"
                                data-testid={`input-row-note-${entry.id}`}
                              />
                            </TableCell>
                          </TableRow>
                        );
                      })
                    )}
                  </TableBody>
                </Table>
              </div>

              {/* Statement Note */}
              <div className="rounded-xl border p-4 mt-4 space-y-2">
                <p className="text-sm font-semibold">Statement Note</p>
                <p className="text-xs text-muted-foreground">This note appears on exported PDF and Excel statements.</p>
                <Textarea
                  value={draftNote ?? ""}
                  onChange={(e) => setDraftNote(e.target.value)}
                  placeholder="Add a note for this customer's statement..."
                  rows={3}
                  data-testid="textarea-statement-note"
                />
                <Button
                  size="sm"
                  onClick={() => saveNoteMutation.mutate(draftNote ?? "")}
                  disabled={saveNoteMutation.isPending}
                  data-testid="button-save-statement-note"
                >
                  {saveNoteMutation.isPending ? "Saving…" : "Save Note"}
                </Button>
              </div>
            </TabsContent>
          )}

          {/* ─── Price List Tab ─── */}
          {showPriceListTab && (
            <TabsContent value="pricelist">
              <div className="mb-4 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="text-sm font-semibold">Saved Agreed Prices by Destination</p>
                    <p className="text-xs text-muted-foreground">
                      New proformas use only agreed prices for their own customer and destination.
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button variant="outline" size="sm" onClick={handlePriceListTemplateDownload}
                      data-testid="button-download-pricelist-template">
                      <Download className="h-4 w-4 mr-2" /> Download Template
                    </Button>
                    <input type="file" accept=".xlsx,.xls,.csv" ref={fileInputRef}
                      onChange={handleExcelUpload} className="hidden" data-testid="input-upload-pricelist" />
                    <Button variant="outline" size="sm" onClick={() => fileInputRef.current?.click()}
                      disabled={!priceDestination || savePricesMutation.isPending || deletePriceMutation.isPending}
                      data-testid="button-upload-excel-pricelist">
                      <Upload className="h-4 w-4 mr-2" /> Upload Excel
                    </Button>
                    {hasPriceEdits && (
                      <Button size="sm" onClick={handleSavePrices}
                        disabled={!priceDestination || savePricesMutation.isPending || deletePriceMutation.isPending}
                        data-testid="button-save-pricelist">
                        <Save className="h-4 w-4 mr-2" />
                        {savePricesMutation.isPending ? "Saving…" : "Save Changes"}
                      </Button>
                    )}
                  </div>
                </div>
                <div className="flex flex-wrap items-end gap-3 rounded-xl border bg-muted/20 p-3">
                  <div className="min-w-[200px] flex-1 sm:max-w-[320px]">
                    <label htmlFor="customer-price-destination" className="mb-1 block text-xs font-semibold">
                      Price list destination
                    </label>
                    <select id="customer-price-destination" data-testid="select-price-destination"
                      className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground"
                      value={priceDestination} onChange={(e) => selectPriceDestination(e.target.value)}
                      disabled={savePricesMutation.isPending || deletePriceMutation.isPending}>
                      <option value="" disabled>Select destination</option>
                      {(priceDestinationsQuery.data ?? []).map((destination) => (
                        <option key={destination} value={destination}>{destination}</option>
                      ))}
                      {priceDestination && priceDestination !== LEGACY_PRICE_DESTINATION &&
                        !(priceDestinationsQuery.data ?? []).includes(priceDestination) && (
                          <option value={priceDestination}>{priceDestination}</option>
                        )}
                      <option value={LEGACY_PRICE_DESTINATION}>Legacy / Unassigned (old prices)</option>
                    </select>
                  </div>
                  <div className="flex min-w-[220px] flex-1 items-end gap-2">
                    <div className="flex-1">
                      <label htmlFor="customer-new-price-destination" className="mb-1 block text-xs font-semibold">
                        Add another destination
                      </label>
                      <Input id="customer-new-price-destination" data-testid="input-new-price-destination"
                        value={newDestination} onChange={(e) => setNewDestination(e.target.value)}
                        placeholder="e.g. L'SHI, MALI" maxLength={120}
                        disabled={savePricesMutation.isPending || deletePriceMutation.isPending}
                        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addPriceDestination(); } }} />
                    </div>
                    <Button size="sm" variant="outline" data-testid="button-add-price-destination"
                      onClick={addPriceDestination}
                      disabled={!newDestination.trim() || savePricesMutation.isPending || deletePriceMutation.isPending}>
                      Use
                    </Button>
                  </div>
                  {priceDestinationsQuery.isError && (
                    <p role="alert" className="w-full text-xs text-destructive">
                      Failed to load customer destinations. Please refresh and retry.
                    </p>
                  )}
                  {priceDestination === LEGACY_PRICE_DESTINATION ? (
                    <p className="w-full text-xs text-amber-600 dark:text-amber-400">
                      Older customer-wide prices are separate and are not applied to new destination-linked proformas.
                    </p>
                  ) : priceDestination ? (
                    <p className="w-full text-xs text-muted-foreground">
                      Only {priceDestination} prices will change here. Existing proforma line prices remain unchanged.
                    </p>
                  ) : null}
                </div>
              </div>

              <div className="rounded-xl border overflow-hidden">
                <Table mobileLayout="cards">
                  <TableHeader className="sticky top-0 z-30">
                    <TableRow className="bg-muted border-b-2 border-border/60 hover:bg-muted">
                      <TableHead className="text-xs font-semibold uppercase tracking-wide text-muted-foreground py-2">
                        Article Code
                      </TableHead>
                      <TableHead className="text-xs font-semibold uppercase tracking-wide text-muted-foreground py-2">
                        Name
                      </TableHead>
                      <TableHead className="text-right text-xs font-semibold uppercase tracking-wide text-muted-foreground py-2">
                        Price per Bale ($)
                      </TableHead>
                      <TableHead className="text-right text-xs font-semibold uppercase tracking-wide text-muted-foreground py-2">
                        Last Updated
                      </TableHead>
                      <TableHead className="w-[50px] py-2"></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {!priceDestination || priceDestinationsQuery.isLoading ? (
                      <TableRow>
                        <TableCell colSpan={5} className="text-center text-muted-foreground py-6">
                          Select a destination to view its agreed prices.
                        </TableCell>
                      </TableRow>
                    ) : priceListQuery.isError ? (
                      <TableRow>
                        <TableCell colSpan={5} role="alert" className="text-center text-destructive py-6">
                          Failed to load prices for this destination. Please retry.
                        </TableCell>
                      </TableRow>
                    ) : priceListQuery.isLoading ? (
                      <TableRow>
                        <TableCell colSpan={5} className="text-center py-6">
                          <Skeleton className="h-4 w-48 mx-auto" />
                        </TableCell>
                      </TableRow>
                    ) : (priceListQuery.data ?? []).length === 0 && !newCode ? (
                      <TableRow>
                        <TableCell
                          colSpan={5}
                          className="text-center text-muted-foreground py-8"
                          data-testid="text-no-prices"
                        >
                          No agreed prices for this destination yet. Upload Excel or add them manually below.
                        </TableCell>
                      </TableRow>
                    ) : (
                      (priceListQuery.data ?? []).map((entry) => (
                        <TableRow key={entry.article_code} data-testid={`row-price-${entry.article_code}`}>
                          <TableCell
                            className="font-mono text-sm font-medium"
                            data-testid={`text-price-code-${entry.article_code}`}
                          >
                            {entry.article_code}
                          </TableCell>
                          <TableCell className="text-sm text-muted-foreground">{entry.item_name || "-"}</TableCell>
                          <TableCell className="text-right">
                            <Input
                              type="number"
                              step="0.01"
                              min="0"
                              value={
                                priceEdits[entry.article_code] !== undefined
                                  ? priceEdits[entry.article_code]
                                  : entry.price_per_bale
                              }
                              onChange={(e) =>
                                setPriceEdits((prev) => ({ ...prev, [entry.article_code]: e.target.value }))
                              }
                              onBlur={() => {
                                if (priceEdits[entry.article_code] !== undefined && !savePricesMutation.isPending) {
                                  handleSavePrices();
                                }
                              }}
                              className="w-32 ml-auto text-right font-mono"
                              data-testid={`input-price-${entry.article_code}`}
                            />
                          </TableCell>
                          <TableCell className="text-right text-xs text-muted-foreground whitespace-nowrap">
                            {entry.updated_at ? new Date(entry.updated_at).toLocaleDateString() : "-"}
                          </TableCell>
                          <TableCell>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="text-destructive"
                              onClick={() => deletePriceMutation.mutate({ articleCode: entry.article_code, destination: priceDestination })}
                              disabled={!priceDestination || deletePriceMutation.isPending || savePricesMutation.isPending}
                              data-testid={`button-delete-price-${entry.article_code}`}
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </TableCell>
                        </TableRow>
                      ))
                    )}

                    {/* Add new row */}
                    <TableRow data-testid="row-add-price">
                      <TableCell>
                        <Input
                          placeholder="Article code…"
                          value={newCode}
                          onChange={(e) => setNewCode(e.target.value)}
                          className="font-mono"
                          data-testid="input-new-price-code"
                        />
                      </TableCell>
                      <TableCell />
                      <TableCell className="text-right">
                        <Input
                          type="number"
                          step="0.01"
                          min="0"
                          placeholder="0.00"
                          value={newPrice}
                          onChange={(e) => setNewPrice(e.target.value)}
                          className="w-32 ml-auto text-right font-mono"
                          data-testid="input-new-price-value"
                        />
                      </TableCell>
                      <TableCell />
                      <TableCell>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={handleSavePrices}
                          disabled={!priceDestination || !newCode.trim() || !newPrice || savePricesMutation.isPending || deletePriceMutation.isPending}
                          data-testid="button-add-price"
                        >
                          <Plus className="h-4 w-4" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  </TableBody>
                </Table>
              </div>

              <p className="text-xs text-muted-foreground mt-3">
                Excel format: columns named <span className="font-mono">article_code</span> and{" "}
                <span className="font-mono">price</span> (or <span className="font-mono">price_per_bale</span>). Prices
                are saved only to the selected destination. Use "Save as Agreed Prices" on a proforma to store its prices here.
              </p>
            </TabsContent>
          )}
        </Tabs>
      ) : (
        <div className="rounded-md border p-6 text-sm text-muted-foreground">
          No Customer Profile tabs are available for this user.
        </div>
      )}
    </div>
  );
}
