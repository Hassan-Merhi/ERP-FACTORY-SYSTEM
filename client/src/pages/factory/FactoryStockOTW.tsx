import { searchAny } from "@shared/searchNormalization";
import { useMemo, useState, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Checkbox } from "@/components/ui/checkbox";
import { Ship, Search, X, Package } from "lucide-react";
import { useLocation } from "wouter";
import { PageHeader } from "@/components/PageHeader";

// ── localStorage helpers ────────────────────────────────────────────────────
const NOTES_KEY = "factory-otw-row-notes";
const DOCS_KEY = "factory-otw-row-docs";

function loadMap(key: string): Record<string, string | boolean> {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "{}");
  } catch {
    return {};
  }
}
function saveMap(key: string, map: Record<string, unknown>) {
  localStorage.setItem(key, JSON.stringify(map));
}

// ── Types ───────────────────────────────────────────────────────────────────
interface FactoryContainer {
  id: number;
  containerNumber: string;
  supplierId: number | null;
  supplierName: string | null;
  origin: string | null;
  totalKg: string | null;
  status: string;
  arrivalDate: string | null;
  currencyCode: string;
  fxRateToUsd: string;
  ratePerKg: string | null;
  finalPayableAmount: string | null;
  finalPayableAmountUsd: string | null;
  freight: string | null;
  freightCurrencyCode: string | null;
  otherCharges: string | null;
  otherChargesCurrencyCode: string | null;
  commissionAmount: string | null;
  commissionCurrencyCode: string | null;
  additionalChargesSum: string | null;
  preRegisteredChargesSum: string | null;
}

// ── Helpers ─────────────────────────────────────────────────────────────────
const STATUS_ACTIVE = new Set(["PENDING", "IN_TRANSIT", "ARRIVED", "RECEIVED"]);

const CCY_SYMBOLS: Record<string, string> = {
  USD: "$",
  EUR: "€",
  GBP: "£",
  AUD: "A$",
  CAD: "C$",
  CHF: "CHF",
  JPY: "¥",
  CNY: "¥",
  AED: "AED",
  SAR: "SAR",
  LBP: "LL",
};

function ccySym(code: string | null | undefined): string {
  if (!code) return "$";
  return CCY_SYMBOLS[code] || code;
}

function num(v: string | null | undefined): number {
  const n = parseFloat(v ?? "");
  return isNaN(n) ? 0 : n;
}

function fmtAmt(symbol: string, amount: number): string {
  if (amount === 0) return "—";
  return `${symbol} ${amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtDate(d: string | null | undefined): string {
  if (!d) return "—";
  const plain = d.slice(0, 10);
  const [y, m, day] = plain.split("-");
  if (!y || !m || !day) return "—";
  return `${day}/${m}/${y.slice(2)}`;
}

function containerCost(c: FactoryContainer): { symbol: string; amount: number } {
  const ccy = c.currencyCode || "USD";
  const symbol = ccySym(ccy);
  const amount = num(c.finalPayableAmount) > 0 ? num(c.finalPayableAmount) : num(c.ratePerKg) * num(c.totalKg);
  return { symbol, amount };
}

// ── Inline editable notes cell ───────────────────────────────────────────────
function NotesCell({
  containerId,
  notes,
  onSave,
}: {
  containerId: number;
  notes: Record<string, string>;
  onSave: (id: number, val: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const current = notes[String(containerId)] ?? "";

  function startEdit() {
    setDraft(current);
    setEditing(true);
  }

  function commit() {
    onSave(containerId, draft);
    setEditing(false);
  }

  if (editing) {
    return (
      <Input
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          if (e.key === "Escape") setEditing(false);
        }}
        className="h-7 text-xs min-w-[140px]"
        data-testid={`input-notes-${containerId}`}
      />
    );
  }

  return (
    <span
      className={`text-xs cursor-pointer rounded px-1 py-0.5 hover-elevate ${current ? "text-foreground" : "text-muted-foreground italic"}`}
      onClick={startEdit}
      data-testid={`text-notes-${containerId}`}
      title="Click to edit"
    >
      {current || "Add note…"}
    </span>
  );
}

// ── Main component ───────────────────────────────────────────────────────────
export default function FactoryStockOTW() {
  const [, navigate] = useLocation();
  const [search, setSearch] = useState("");
  const [supplierFilter, setSupplierFilter] = useState<string>("all");

  const [notes, setNotes] = useState<Record<string, string>>(() => loadMap(NOTES_KEY) as Record<string, string>);
  const [docs, setDocs] = useState<Record<string, boolean>>(() => loadMap(DOCS_KEY) as Record<string, boolean>);

  const { data: containers = [], isLoading } = useQuery<FactoryContainer[]>({
    queryKey: ["/api/factory/containers"],
  });

  const otwContainers = useMemo(() => containers.filter((c) => STATUS_ACTIVE.has(c.status)), [containers]);

  const suppliers = useMemo(() => {
    const seen = new Map<string, string>();
    for (const c of otwContainers) {
      const key = String(c.supplierId ?? "none");
      if (!seen.has(key)) seen.set(key, c.supplierName || "No Supplier");
    }
    return Array.from(seen.entries()).sort((a, b) => a[1].localeCompare(b[1]));
  }, [otwContainers]);

  const filtered = useMemo(() => {
    let rows = otwContainers;
    if (supplierFilter !== "all") {
      rows = rows.filter((c) => String(c.supplierId ?? "none") === supplierFilter);
    }
    if (search.trim()) {
      rows = rows.filter((c) => searchAny(search, c.containerNumber, c.supplierName, c.origin));
    }
    return rows;
  }, [otwContainers, supplierFilter, search]);

  const totals = useMemo(() => {
    const costByCcy: Record<string, number> = {};
    const freightByCcy: Record<string, number> = {};
    const commByCcy: Record<string, number> = {};
    for (const c of filtered) {
      const { symbol, amount } = containerCost(c);
      if (amount) costByCcy[symbol] = (costByCcy[symbol] || 0) + amount;
      const freightSym = ccySym(c.freightCurrencyCode || c.currencyCode);
      const fr = num(c.freight);
      if (fr) freightByCcy[freightSym] = (freightByCcy[freightSym] || 0) + fr;
      const commSym = ccySym(c.commissionCurrencyCode || "USD");
      const comm = num(c.commissionAmount);
      if (comm) commByCcy[commSym] = (commByCcy[commSym] || 0) + comm;
    }
    return { costByCcy, freightByCcy, commByCcy };
  }, [filtered]);

  const saveNote = useCallback((id: number, val: string) => {
    setNotes((prev) => {
      const next = { ...prev, [String(id)]: val };
      saveMap(NOTES_KEY, next);
      return next;
    });
  }, []);

  const toggleDoc = useCallback((id: number, checked: boolean) => {
    setDocs((prev) => {
      const next = { ...prev, [String(id)]: checked };
      saveMap(DOCS_KEY, next);
      return next;
    });
  }, []);

  function fmtTotals(map: Record<string, number>): string {
    const entries = Object.entries(map).filter(([, v]) => v > 0);
    if (!entries.length) return "—";
    return entries
      .map(
        ([sym, amt]) =>
          `${sym} ${amt.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
      )
      .join(" · ");
  }

  const docsReceived = filtered.filter((c) => docs[String(c.id)]).length;

  return (
    <div className="flex flex-col gap-4 p-6">
      {/* Header */}
      <div className="flex items-center gap-3 flex-wrap">
        <Ship className="h-5 w-5 text-muted-foreground shrink-0" />
        <PageHeader title="OTW Container Tracking" subtitle="Containers currently in transit" />
        <Badge variant="outline" className="ml-auto shrink-0" data-testid="badge-total-count">
          {otwContainers.length} container{otwContainers.length !== 1 ? "s" : ""}
        </Badge>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search container #, supplier…"
            className="pl-8"
            data-testid="input-search"
          />
        </div>
        <Select value={supplierFilter} onValueChange={setSupplierFilter}>
          <SelectTrigger className="w-[200px]" data-testid="select-supplier-filter">
            <SelectValue placeholder="All suppliers" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All suppliers</SelectItem>
            {suppliers.map(([key, name]) => (
              <SelectItem key={key} value={key}>
                {name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {(search || supplierFilter !== "all") && (
          <Button
            variant="ghost"
            size="icon"
            onClick={() => {
              setSearch("");
              setSupplierFilter("all");
            }}
            data-testid="button-clear-filters"
          >
            <X className="h-4 w-4" />
          </Button>
        )}
        <span className="text-xs text-muted-foreground ml-auto">
          {filtered.length !== otwContainers.length
            ? `${filtered.length} of ${otwContainers.length}`
            : `${filtered.length}`}{" "}
          shown · {docsReceived} docs received
        </span>
      </div>

      {/* Table */}
      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-muted-foreground gap-2">
          <Ship className="h-12 w-12 opacity-30" />
          <p className="text-sm">
            {otwContainers.length === 0 ? "No containers currently in transit." : "No containers match your search."}
          </p>
        </div>
      ) : (
        <div className="rounded-md border overflow-x-auto">
          <Table>
            <TableHeader className="sticky top-0 z-20 bg-background">
              <TableRow>
                <TableHead className="w-10 text-center">#</TableHead>
                <TableHead className="whitespace-nowrap">Container #</TableHead>
                <TableHead className="whitespace-nowrap">Supplier</TableHead>
                <TableHead className="whitespace-nowrap">ETA</TableHead>
                <TableHead className="whitespace-nowrap text-right">Cost</TableHead>
                <TableHead className="whitespace-nowrap text-right">Freight</TableHead>
                <TableHead className="whitespace-nowrap text-right">Commission</TableHead>
                <TableHead className="whitespace-nowrap text-center">Docs</TableHead>
                <TableHead className="whitespace-nowrap min-w-[160px]">Notes</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((c, idx) => {
                const cost = containerCost(c);
                const frSym = ccySym(c.freightCurrencyCode || c.currencyCode);
                const commSym = ccySym(c.commissionCurrencyCode || "USD");
                const docDone = !!docs[String(c.id)];

                return (
                  <TableRow key={c.id} className="hover-elevate" data-testid={`row-container-${c.id}`}>
                    {/* # */}
                    <TableCell className="text-center text-muted-foreground text-sm">{idx + 1}</TableCell>

                    {/* Container # — clickable */}
                    <TableCell
                      className="font-mono font-semibold text-sm whitespace-nowrap cursor-pointer hover:underline"
                      onClick={() => navigate(`/containers/${c.id}`)}
                      data-testid={`text-container-num-${c.id}`}
                    >
                      {c.containerNumber || "—"}
                    </TableCell>

                    {/* Supplier */}
                    <TableCell className="text-sm whitespace-nowrap" data-testid={`text-supplier-${c.id}`}>
                      {c.supplierName ?? <span className="text-muted-foreground">—</span>}
                    </TableCell>

                    {/* ETA */}
                    <TableCell className="text-sm whitespace-nowrap font-medium" data-testid={`text-eta-${c.id}`}>
                      {c.arrivalDate ? (
                        <span>{fmtDate(c.arrivalDate)}</span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>

                    {/* Cost */}
                    <TableCell
                      className="text-right text-sm tabular-nums whitespace-nowrap"
                      data-testid={`text-cost-${c.id}`}
                    >
                      {cost.amount > 0 ? (
                        <span className="font-medium">{fmtAmt(cost.symbol, cost.amount)}</span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>

                    {/* Freight */}
                    <TableCell
                      className="text-right text-sm tabular-nums whitespace-nowrap"
                      data-testid={`text-freight-${c.id}`}
                    >
                      {num(c.freight) > 0 ? (
                        fmtAmt(frSym, num(c.freight))
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>

                    {/* Commission */}
                    <TableCell
                      className="text-right text-sm tabular-nums whitespace-nowrap"
                      data-testid={`text-commission-${c.id}`}
                    >
                      {num(c.commissionAmount) > 0 ? (
                        fmtAmt(commSym, num(c.commissionAmount))
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>

                    {/* Docs checkbox */}
                    <TableCell className="text-center" data-testid={`cell-docs-${c.id}`}>
                      <Checkbox
                        checked={docDone}
                        onCheckedChange={(v) => toggleDoc(c.id, !!v)}
                        data-testid={`checkbox-docs-${c.id}`}
                        aria-label="Docs received"
                      />
                    </TableCell>

                    {/* Notes — inline editable */}
                    <TableCell data-testid={`cell-notes-${c.id}`}>
                      <NotesCell containerId={c.id} notes={notes} onSave={saveNote} />
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      {/* Sticky totals bar */}
      {filtered.length > 0 && (
        <div className="sticky bottom-0 z-50 rounded-md border bg-background shadow-md" data-testid="div-totals-bar">
          <div className="flex flex-wrap items-center gap-6 px-4 py-3">
            <div className="flex items-center gap-2">
              <Package className="h-4 w-4 text-muted-foreground shrink-0" />
              <div>
                <p className="text-xs text-muted-foreground">Containers</p>
                <p className="text-base font-bold tabular-nums" data-testid="text-total-count">
                  {filtered.length}
                </p>
              </div>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Total Cost</p>
              <p className="text-base font-bold tabular-nums whitespace-nowrap" data-testid="text-total-cost">
                {fmtTotals(totals.costByCcy)}
              </p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Total Freight</p>
              <p className="text-base font-bold tabular-nums whitespace-nowrap" data-testid="text-total-freight">
                {fmtTotals(totals.freightByCcy)}
              </p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Total Commission</p>
              <p className="text-base font-bold tabular-nums whitespace-nowrap" data-testid="text-total-commission">
                {fmtTotals(totals.commByCcy)}
              </p>
            </div>
            <div className="ml-auto">
              <p className="text-xs text-muted-foreground">Docs Received</p>
              <p className="text-base font-bold tabular-nums" data-testid="text-docs-received">
                {docsReceived} / {filtered.length}
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
