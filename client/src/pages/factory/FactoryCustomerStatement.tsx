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
import { ArrowLeft, Download, FileSpreadsheet, X, ExternalLink, Upload, Plus, Save, Trash2 } from "lucide-react";
import { useDateFormat } from "@/contexts/DateFormatContext";
import { drCrClass } from "@/lib/formatNumber";
import { useState, useEffect, useMemo, useRef } from "react";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { factoryApiRequest } from "@/lib/factoryApi";
import { useToast } from "@/hooks/use-toast";
import { PageHeader } from "@/components/PageHeader";
import * as XLSX from "xlsx-js-style";

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

interface BalanceEntry {
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

interface StatementData {
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
  const { formatDisplayDate } = useDateFormat();
  const { toast } = useToast();
  const [, navigate] = useLocation();
  useEscapeToParent("/factory/customers");
  const params = useParams<{ id: string }>();
  const customerId = params.id;

  const [draftNote, setDraftNote] = useState<string | null>(null);
  const [rowNotes, setRowNotes] = useState<Record<number | string, string>>({});
  const [savingRowNote, setSavingRowNote] = useState<number | null>(null);

  const [filterDestination, setFilterDestination] = useState("");
  const [filterDateFrom, setFilterDateFrom] = useState("");
  const [filterDateTo, setFilterDateTo] = useState("");

  // Price list state
  const [priceEdits, setPriceEdits] = useState<Record<string, string>>({});
  const [newCode, setNewCode] = useState("");
  const [newPrice, setNewPrice] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  const { data: statement, isLoading } = useQuery<StatementData>({
    queryKey: ["/api/factory/customers", customerId, "statement"],
    queryFn: async () => {
      const res = await fetch(`/api/factory/customers/${customerId}/statement`, { credentials: "include" });
      if (!res.ok) throw new Error((await res.json()).message || "Failed to fetch statement");
      return res.json();
    },
    enabled: !!customerId,
  });

  const priceListQuery = useQuery<PriceListEntry[]>({
    queryKey: ["/api/factory/customer-price-lists", customerId],
    enabled: !!customerId,
    queryFn: async () => {
      const res = await fetch(`/api/factory/customer-price-lists/${customerId}`, { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
  });

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
    mutationFn: async (lines: { articleCode: string; pricePerBale: string | number }[]) => {
      const res = await factoryApiRequest("PUT", `/api/factory/customer-price-lists/${customerId}`, lines);
      return (await res.json()) as { saved?: number };
    },
    onSuccess: (data: { saved?: number }) => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/customer-price-lists", customerId] });
      setPriceEdits({});
      setNewCode("");
      setNewPrice("");
      toast({ title: "Price list saved", description: `${data?.saved ?? 0} price(s) updated` });
    },
    onError: () => {
      toast({ title: "Failed to save prices", variant: "destructive" });
    },
  });

  const deletePriceMutation = useMutation({
    mutationFn: async (articleCode: string) => {
      return await factoryApiRequest(
        "DELETE",
        `/api/factory/customer-price-lists/${customerId}/${encodeURIComponent(articleCode)}`,
        {}
      );
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/customer-price-lists", customerId] });
      toast({ title: "Price removed" });
    },
    onError: () => {
      toast({ title: "Failed to remove price", variant: "destructive" });
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

  const handleExcelUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
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
        savePricesMutation.mutate(lines);
      } catch {
        toast({ title: "Failed to read file", variant: "destructive" });
      }
    };
    reader.readAsArrayBuffer(file);
    e.target.value = "";
  };

  const handleSavePrices = () => {
    const lines: { articleCode: string; pricePerBale: string | number }[] = [];
    for (const entry of priceListQuery.data ?? []) {
      const edited = priceEdits[entry.article_code];
      const price = edited !== undefined ? edited : entry.price_per_bale;
      const p = parseFloat(String(price));
      if (!isNaN(p) && p > 0) lines.push({ articleCode: entry.article_code, pricePerBale: p });
    }
    if (newCode.trim() && newPrice) {
      const p = parseFloat(newPrice);
      if (!isNaN(p) && p > 0) lines.push({ articleCode: newCode.trim(), pricePerBale: p });
    }
    if (lines.length === 0) {
      toast({ title: "No valid prices to save", variant: "destructive" });
      return;
    }
    savePricesMutation.mutate(lines);
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
    <div className="flex flex-col h-full p-6 overflow-y-auto">
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
        <div className="flex items-center gap-2 flex-shrink-0">
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              const params = new URLSearchParams();
              if (filterDateFrom) params.set("dateFrom", filterDateFrom);
              if (filterDateTo) params.set("dateTo", filterDateTo);
              if (filterDestination) params.set("destination", filterDestination);
              const qs = params.toString();
              const url = `/api/factory/customers/${customerId}/statement/export-pdf${qs ? `?${qs}` : ""}`;
              if (!navigator.onLine) {
                window.print();
                return;
              }
              window.open(url, "_blank");
            }}
            data-testid="button-export-pdf"
          >
            <Download className="mr-2 h-4 w-4" />
            Export PDF
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              const params = new URLSearchParams();
              if (filterDateFrom) params.set("dateFrom", filterDateFrom);
              if (filterDateTo) params.set("dateTo", filterDateTo);
              if (filterDestination) params.set("destination", filterDestination);
              const qs = params.toString();
              window.open(`/api/factory/customers/${customerId}/statement/export-excel${qs ? `?${qs}` : ""}`, "_blank");
            }}
            data-testid="button-export-excel"
          >
            <FileSpreadsheet className="mr-2 h-4 w-4" />
            Export Excel
          </Button>
        </div>
      </div>

      {/* Balance cards */}
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

      {/* Tabs */}
      <Tabs defaultValue="statement" className="flex-1">
        <TabsList className="mb-4">
          <TabsTrigger value="statement" data-testid="tab-statement">
            Statement
          </TabsTrigger>
          <TabsTrigger value="pricelist" data-testid="tab-pricelist">
            Price List
            {(priceListQuery.data?.length ?? 0) > 0 && (
              <Badge
                variant="secondary"
                className="ml-2 text-[10px] no-default-hover-elevate no-default-active-elevate"
              >
                {priceListQuery.data!.length}
              </Badge>
            )}
          </TabsTrigger>
        </TabsList>

        {/* ─── Statement Tab ─── */}
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
            <Table>
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
                        onClick={isInvoice ? () => navigate(`/factory/sales/invoices/${entry.referenceId}`) : undefined}
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
                        <TableCell className="text-right font-mono text-sm" data-testid={`text-balance-kg-${entry.id}`}>
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
                        <TableCell className="min-w-[160px]" onClick={(e) => e.stopPropagation()}>
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
                            className="w-full text-xs bg-transparent border border-border rounded px-2 py-1 placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-50"
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

        {/* ─── Price List Tab ─── */}
        <TabsContent value="pricelist">
          <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
            <div>
              <p className="text-sm font-semibold">Customer Price List</p>
              <p className="text-xs text-muted-foreground">
                These prices are automatically applied when creating a proforma for this customer.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <input
                type="file"
                accept=".xlsx,.xls,.csv"
                ref={fileInputRef}
                onChange={handleExcelUpload}
                className="hidden"
                data-testid="input-upload-pricelist"
              />
              <Button
                variant="outline"
                size="sm"
                onClick={() => fileInputRef.current?.click()}
                disabled={savePricesMutation.isPending}
                data-testid="button-upload-excel-pricelist"
              >
                <Upload className="h-4 w-4 mr-2" />
                Upload Excel
              </Button>
              {hasPriceEdits && (
                <Button
                  size="sm"
                  onClick={handleSavePrices}
                  disabled={savePricesMutation.isPending}
                  data-testid="button-save-pricelist"
                >
                  <Save className="h-4 w-4 mr-2" />
                  {savePricesMutation.isPending ? "Saving…" : "Save Changes"}
                </Button>
              )}
            </div>
          </div>

          <div className="rounded-xl border overflow-hidden">
            <Table>
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
                {priceListQuery.isLoading ? (
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
                      No prices set yet. Upload an Excel file or add manually below.
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
                          onChange={(e) => setPriceEdits((prev) => ({ ...prev, [entry.article_code]: e.target.value }))}
                          onBlur={() => {
                            if (priceEdits[entry.article_code] !== undefined) {
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
                          onClick={() => deletePriceMutation.mutate(entry.article_code)}
                          disabled={deletePriceMutation.isPending}
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
                      disabled={!newCode.trim() || !newPrice || savePricesMutation.isPending}
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
            <span className="font-mono">price</span> (or <span className="font-mono">price_per_bale</span>). Prices are
            also auto-saved when you create a proforma with prices set.
          </p>
        </TabsContent>
      </Tabs>
    </div>
  );
}
