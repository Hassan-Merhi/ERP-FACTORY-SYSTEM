import type { ClientErrorLike } from "@/lib/clientError";
import { useState, useRef, useMemo } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { PageHeader } from "@/components/PageHeader";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  Trash2,
  Printer,
  Search,
  ChevronDown,
  ChevronRight,
  Loader2,
  Weight,
  DollarSign,
  History,
  CheckSquare,
  ScanLine,
  X,
} from "lucide-react";

import type {
  Bale,
  ProductGroup,
  WasteDispatchHistoryBale,
  WasteDispatchHistoryEntry,
  WasteDispatchPrintData,
} from "./wastedispatch/types";
import { fmt, fmtKg, today } from "./wastedispatch/utils";
import { WasteDispatchDialogs } from "./wastedispatch/components/WasteDispatchDialogs";
export default function WasteDispatch() {
  const { toast } = useToast();
  const [, _navigate] = useLocation();

  // ── Dispatch tab state ─────────────────────────────────────────
  const [search, setSearch] = useState("");
  const [scanInput, setScanInput] = useState("");
  const scanInputRef = useRef<HTMLInputElement>(null);
  const [dispatchDate, setDispatchDate] = useState(today());
  const [notes, setNotes] = useState("");
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [expandedHistoryIds, setExpandedHistoryIds] = useState<Set<number>>(new Set());
  const [showAllHistory, setShowAllHistory] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [printData, setPrintData] = useState<WasteDispatchPrintData | null>(null);
  const [deleteDispatchId, setDeleteDispatchId] = useState<number | null>(null);

  // ── Dispatch queries ───────────────────────────────────────────
  const { data, isLoading } = useQuery<{ bales: Bale[]; categories: unknown[] }>({
    queryKey: ["/api/factory/waste-dispatch/bales", search],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (search) params.set("search", search);
      const r = await fetch(`/api/factory/waste-dispatch/bales?${params}`, { credentials: "include" });
      if (!r.ok) throw new Error(await r.text());
      return r.json();
    },
  });

  const { data: history = [] } = useQuery<WasteDispatchHistoryEntry[]>({
    queryKey: ["/api/factory/waste-dispatch/history"],
    queryFn: async () => {
      const r = await fetch("/api/factory/waste-dispatch/history", { credentials: "include" });
      if (!r.ok) throw new Error(await r.text());
      return r.json();
    },
  });

  // ── Dispatch helpers ───────────────────────────────────────────
  const bales: Bale[] = useMemo(() => data?.bales || [], [data?.bales]);

  const productGroups: ProductGroup[] = useMemo(() => {
    const map = new Map<string, ProductGroup>();
    for (const b of bales) {
      const key = `${b.productName}__${b.categoryName}`;
      const existing = map.get(key);
      if (existing) {
        existing.bales.push(b);
        existing.totalWeight += b.weightKg;
        existing.totalCost += b.totalCost;
      } else {
        map.set(key, {
          key,
          productName: b.productName,
          categoryName: b.categoryName,
          bales: [b],
          totalWeight: b.weightKg,
          totalCost: b.totalCost,
          avgRate: 0,
        });
      }
    }
    const groups = Array.from(map.values());
    for (const g of groups) {
      g.avgRate = g.bales.length > 0 ? g.totalCost / g.bales.length : 0;
    }
    return groups.sort((a, b) => a.productName.localeCompare(b.productName));
  }, [bales]);

  const grandTotals = useMemo(
    () => ({
      bales: bales.length,
      weight: bales.reduce((s, b) => s + b.weightKg, 0),
      cost: bales.reduce((s, b) => s + b.totalCost, 0),
    }),
    [bales]
  );

  const toggleBale = (id: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleGroup = (group: ProductGroup) => {
    const allSelected = group.bales.every((b) => selected.has(b.id));
    setSelected((prev) => {
      const next = new Set(prev);
      if (allSelected) {
        group.bales.forEach((b) => next.delete(b.id));
      } else {
        group.bales.forEach((b) => next.add(b.id));
      }
      return next;
    });
  };

  const toggleExpandGroup = (key: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const toggleAll = () => {
    if (selected.size === bales.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(bales.map((b) => b.id)));
    }
  };

  const handleScan = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "Enter") return;
    const ref = scanInput.trim().toUpperCase();
    if (!ref) return;
    const match = bales.find((b) => b.referenceNumber.toUpperCase() === ref);
    if (match) {
      setSelected((prev) => {
        const next = new Set(prev);
        next.add(match.id);
        return next;
      });
      const group = productGroups.find((g) => g.bales.some((b) => b.id === match.id));
      if (group) {
        setExpandedGroups((prev) => new Set(prev).add(group.key));
      }
      setScanInput("");
      toast({ title: "Bale added", description: `${match.referenceNumber} — ${match.productName}` });
    } else {
      toast({ title: "Not found", description: `No bale with ref "${ref}"`, variant: "destructive" });
      setScanInput("");
    }
  };

  const selectedBales = bales.filter((b) => selected.has(b.id));
  const totalWeight = selectedBales.reduce((s, b) => s + b.weightKg, 0);
  const totalCost = selectedBales.reduce((s, b) => s + b.totalCost, 0);

  const toggleHistoryItem = (id: number) => {
    setExpandedHistoryIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleHistoryPrint = (d: WasteDispatchHistoryEntry) => {
    const dispatchBales = d.bales || [];
    const totalW = dispatchBales.reduce((s: number, b: WasteDispatchHistoryBale) => s + parseFloat(String(b.weightKg || 0)), 0);
    const totalC = dispatchBales.reduce((s: number, b: WasteDispatchHistoryBale) => s + parseFloat(String(b.totalCost || 0)), 0);
    const baleRows = dispatchBales
      .map(
        (b: WasteDispatchHistoryBale) =>
          `<tr>
          <td style="border:1px solid #ccc;padding:5px 8px;font-family:monospace">${b.referenceNumber}</td>
          <td style="border:1px solid #ccc;padding:5px 8px">${b.productName || ""}</td>
          <td style="border:1px solid #ccc;padding:5px 8px;text-align:right">${fmtKg(parseFloat(String(b.weightKg || 0)))}</td>
          <td style="border:1px solid #ccc;padding:5px 8px;text-align:right">${fmt(parseFloat(String(b.totalCost || 0)))}</td>
        </tr>`
      )
      .join("");
    const win = window.open("", "_blank");
    if (!win) return;
    win.document.write(`<html><head><title>Waste Disposal — ${d.dispatchNumber}</title>
      <style>body{font-family:Arial,sans-serif;font-size:12px;margin:20px}
      h1{font-size:18px;margin-bottom:4px}.sub{color:#555;font-size:11px;margin-bottom:16px}
      table{width:100%;border-collapse:collapse;margin-top:12px}
      th,td{border:1px solid #ccc;padding:6px 8px;text-align:left}
      th{background:#f3f4f6;font-weight:bold}.footer{margin-top:24px;font-size:10px;color:#777}</style>
      </head><body>
      <h1>Waste Disposal Record</h1>
      <p class="sub">Dispatch No: ${d.dispatchNumber}&nbsp;|&nbsp;Date: ${d.dispatchDate}${d.notes ? `&nbsp;|&nbsp;Note: ${d.notes}` : ""}</p>
      <table><thead><tr>
        <th>Reference</th><th>Product</th>
        <th style="text-align:right">Weight (kg)</th>
        <th style="text-align:right">Cost Written Off</th>
      </tr></thead>
      <tbody>${baleRows}</tbody>
      <tfoot><tr>
        <td style="border:1px solid #ccc;padding:6px 8px;font-weight:bold" colspan="2">TOTAL — ${dispatchBales.length} bale(s)</td>
        <td style="border:1px solid #ccc;padding:6px 8px;text-align:right;font-weight:bold">${fmtKg(totalW)}</td>
        <td style="border:1px solid #ccc;padding:6px 8px;text-align:right;font-weight:bold;color:#dc2626">${fmt(totalC)}</td>
      </tr></tfoot></table>
      <p class="footer">This document confirms the waste disposal of factory bales. A daybook expense entry has been created automatically.</p>
      </body></html>`);
    win.document.close();
    win.focus();
    win.print();
    win.close();
  };

  // ── Dispatch mutation ──────────────────────────────────────────
  const submitMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/factory/waste-dispatch/submit", {
        baleIds: [...selected],
        dispatchDate,
        notes: notes.trim() || undefined,
      });
      return res.json();
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/waste-dispatch/bales"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/waste-dispatch/history"] });
      setSelected(new Set());
      setNotes("");
      setConfirming(false);
      setPrintData(result);
      toast({
        title: "Waste disposed",
        description: `${result.totalBales} bale(s) marked as disposed (${result.dispatch.dispatchNumber})`,
      });
    },
    onError: (err: ClientErrorLike) => {
      if (err?._handledGlobally) return;
      toast({ title: "Error", description: err.message, variant: "destructive" });
      setConfirming(false);
    },
  });

  // ── Delete dispatch mutation ───────────────────────────────────
  const deleteDispatchMutation = useMutation({
    mutationFn: async (id: number) => {
      const res = await apiRequest("DELETE", `/api/factory/waste-dispatch/${id}`);
      return res.json();
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/waste-dispatch/bales"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/waste-dispatch/history"] });
      setDeleteDispatchId(null);
      toast({
        title: "Dispatch deleted",
        description: `${result.restoredBales} bale(s) restored to stock.`,
      });
    },
    onError: (err: ClientErrorLike) => {
      if (err?._handledGlobally) return;
      toast({ title: "Error", description: err.message, variant: "destructive" });
      setDeleteDispatchId(null);
    },
  });

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Page Header */}
      <div className="flex items-center justify-between gap-3 px-6 py-3 border-b flex-wrap">
        <div>
          <PageHeader
            title="Waste Dispatch"
            subtitle="Manage waste bales — dispatch or create new entries"
            icon={<Trash2 className="h-5 w-5" />}
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {/* Dispatch Details + Scan — top bar */}
        <div className="flex flex-wrap gap-3">
          {/* Date + Notes */}
          <Card className="flex-1 min-w-60">
            <CardContent className="p-3">
              <div className="flex flex-wrap gap-3">
                <div className="flex flex-col gap-1">
                  <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                    Dispatch Date
                  </label>
                  <Input
                    type="date"
                    value={dispatchDate}
                    onChange={(e) => setDispatchDate(e.target.value)}
                    className="w-40"
                    data-testid="input-dispatch-date"
                  />
                </div>
                <div className="flex flex-col gap-1 flex-1 min-w-40">
                  <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                    Notes (optional)
                  </label>
                  <Textarea
                    placeholder="Reason for disposal..."
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    rows={1}
                    className="resize-none"
                    data-testid="input-notes"
                  />
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Scan input */}
          <Card className="min-w-56">
            <CardContent className="p-3 h-full flex flex-col justify-center">
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1 flex items-center gap-1">
                <ScanLine className="w-3 h-3" /> Scan / Enter Ref
              </label>
              <div className="relative">
                <ScanLine className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                <Input
                  ref={scanInputRef}
                  value={scanInput}
                  onChange={(e) => setScanInput(e.target.value)}
                  onKeyDown={handleScan}
                  placeholder="REF123456 + Enter"
                  className="pl-9 font-mono text-sm"
                  data-testid="input-scan-ref"
                  autoComplete="off"
                />
              </div>
              <p className="text-xs text-muted-foreground mt-1">Press Enter to select a bale</p>
            </CardContent>
          </Card>
        </div>

        {/* Bale Groups Table */}
        <Card>
          <CardHeader className="pb-2 px-4 pt-3">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div className="flex items-center gap-3">
                <CardTitle className="text-sm">Available Waste Bales</CardTitle>
                {!isLoading && (
                  <Badge variant="outline" className="text-xs">
                    {bales.length} bales · {productGroups.length} products
                  </Badge>
                )}
              </div>
              <div className="flex items-center gap-2">
                <div className="relative">
                  <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    placeholder="Filter products..."
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    className="pl-8 w-48 h-8 text-xs"
                    data-testid="input-search-bales"
                  />
                </div>
                {bales.length > 0 && (
                  <Button variant="outline" size="sm" onClick={toggleAll} className="text-xs h-8 px-3">
                    {selected.size === bales.length ? "Deselect All" : "Select All"}
                  </Button>
                )}
              </div>
            </div>
          </CardHeader>
          <CardContent className="p-0">
            {isLoading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
              </div>
            ) : productGroups.length === 0 ? (
              <div className="text-center py-12 text-muted-foreground">
                <Trash2 className="w-10 h-10 mx-auto mb-3 opacity-25" />
                <p className="text-sm">No Garbage or Wiper bales in stock.</p>
                <p className="text-xs mt-1">Only bales with Garbage or Wiper category are eligible.</p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow className="bg-muted/40">
                      <TableHead className="w-8 py-2 px-3"></TableHead>
                      <TableHead className="py-2 px-3 text-xs">Product</TableHead>
                      <TableHead className="py-2 px-3 text-xs">Category</TableHead>
                      <TableHead className="py-2 px-3 text-right text-xs">Bales</TableHead>
                      <TableHead className="py-2 px-3 text-right text-xs">Weight (kg)</TableHead>
                      <TableHead className="py-2 px-3 text-right text-xs">Avg Rate</TableHead>
                      <TableHead className="py-2 px-3 text-right text-xs">Total Cost</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {productGroups.map((group) => {
                      const isExpanded = expandedGroups.has(group.key);
                      const groupSelectedCount = group.bales.filter((b) => selected.has(b.id)).length;
                      const allGroupSelected = groupSelectedCount === group.bales.length;
                      const someGroupSelected = groupSelectedCount > 0 && !allGroupSelected;

                      return (
                        <>
                          <TableRow
                            key={group.key}
                            className={`cursor-pointer font-medium ${allGroupSelected ? "bg-destructive/5" : someGroupSelected ? "bg-destructive/3" : ""} hover:bg-muted/30`}
                            data-testid={`row-group-${group.key}`}
                          >
                            <TableCell className="py-2 px-3">
                              <Checkbox
                                checked={allGroupSelected}
                                data-state={
                                  someGroupSelected ? "indeterminate" : allGroupSelected ? "checked" : "unchecked"
                                }
                                onCheckedChange={() => toggleGroup(group)}
                                onClick={(e) => e.stopPropagation()}
                                data-testid={`checkbox-group-${group.key}`}
                              />
                            </TableCell>
                            <TableCell className="py-2 px-3" onClick={() => toggleExpandGroup(group.key)}>
                              <div className="flex items-center gap-2">
                                {isExpanded ? (
                                  <ChevronDown className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                                ) : (
                                  <ChevronRight className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                                )}
                                <span className="text-sm font-semibold">{group.productName}</span>
                                {groupSelectedCount > 0 && (
                                  <Badge
                                    variant="outline"
                                    className="text-xs text-destructive border-destructive/30 ml-1"
                                  >
                                    {groupSelectedCount} selected
                                  </Badge>
                                )}
                              </div>
                            </TableCell>
                            <TableCell className="py-2 px-3" onClick={() => toggleExpandGroup(group.key)}>
                              <Badge variant="outline" className="text-xs">
                                {group.categoryName}
                              </Badge>
                            </TableCell>
                            <TableCell
                              className="py-2 px-3 text-right text-sm"
                              onClick={() => toggleExpandGroup(group.key)}
                            >
                              {group.bales.length}
                            </TableCell>
                            <TableCell
                              className="py-2 px-3 text-right text-sm"
                              onClick={() => toggleExpandGroup(group.key)}
                            >
                              {fmtKg(group.totalWeight)}
                            </TableCell>
                            <TableCell
                              className="py-2 px-3 text-right text-xs text-muted-foreground"
                              onClick={() => toggleExpandGroup(group.key)}
                            >
                              {group.avgRate > 0 ? fmt(group.avgRate) : "—"}
                            </TableCell>
                            <TableCell
                              className="py-2 px-3 text-right text-sm font-medium"
                              onClick={() => toggleExpandGroup(group.key)}
                            >
                              {group.totalCost > 0 ? fmt(group.totalCost) : "—"}
                            </TableCell>
                          </TableRow>

                          {isExpanded &&
                            group.bales.map((b) => (
                              <TableRow
                                key={b.id}
                                className={`cursor-pointer text-xs ${selected.has(b.id) ? "bg-destructive/8" : "bg-muted/10"} hover:bg-muted/20`}
                                onClick={() => toggleBale(b.id)}
                                data-testid={`row-bale-${b.id}`}
                              >
                                <TableCell className="py-1.5 px-3 pl-5" onClick={(e) => e.stopPropagation()}>
                                  <Checkbox
                                    checked={selected.has(b.id)}
                                    onCheckedChange={() => toggleBale(b.id)}
                                    data-testid={`checkbox-bale-${b.id}`}
                                  />
                                </TableCell>
                                <TableCell className="py-1.5 px-3 pl-8" colSpan={2}>
                                  <div className="flex items-center gap-2">
                                    <span className="font-mono text-xs font-semibold text-primary">
                                      {b.referenceNumber}
                                    </span>
                                    <span className="text-xs text-muted-foreground">{b.locationName}</span>
                                  </div>
                                </TableCell>
                                <TableCell className="py-1.5 px-3 text-right text-xs">1</TableCell>
                                <TableCell className="py-1.5 px-3 text-right text-xs">{fmtKg(b.weightKg)}</TableCell>
                                <TableCell className="py-1.5 px-3 text-right text-xs text-muted-foreground">
                                  {b.totalCost > 0 ? fmt(b.totalCost) : "—"}
                                </TableCell>
                                <TableCell className="py-1.5 px-3 text-right text-xs">
                                  {b.totalCost > 0 ? fmt(b.totalCost) : "—"}
                                </TableCell>
                              </TableRow>
                            ))}
                        </>
                      );
                    })}

                    {/* Grand total row */}
                    <TableRow className="bg-muted/50 font-bold border-t-2">
                      <TableCell className="py-2 px-3"></TableCell>
                      <TableCell className="py-2 px-3 text-xs" colSpan={2}>
                        TOTAL — {productGroups.length} product{productGroups.length !== 1 ? "s" : ""}
                      </TableCell>
                      <TableCell className="py-2 px-3 text-right text-xs">{grandTotals.bales}</TableCell>
                      <TableCell className="py-2 px-3 text-right text-xs">{fmtKg(grandTotals.weight)}</TableCell>
                      <TableCell className="py-2 px-3 text-right text-xs text-muted-foreground">
                        {grandTotals.bales > 0 && grandTotals.cost > 0
                          ? fmt(grandTotals.cost / grandTotals.bales)
                          : "—"}
                      </TableCell>
                      <TableCell className="py-2 px-3 text-right text-xs">
                        {grandTotals.cost > 0 ? fmt(grandTotals.cost) : "—"}
                      </TableCell>
                    </TableRow>
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Selection Summary + Dispatch Button */}
        {selected.size > 0 && (
          <Card className="border-destructive/30 bg-destructive/3">
            <CardContent className="p-3">
              <div className="flex items-center justify-between gap-4 flex-wrap">
                <div className="flex items-center gap-5 flex-wrap">
                  <div className="flex items-center gap-2">
                    <CheckSquare className="w-4 h-4 text-destructive" />
                    <span className="text-sm font-semibold text-destructive" data-testid="text-selected-count">
                      {selected.size} bale{selected.size !== 1 ? "s" : ""} selected
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <Weight className="w-3.5 h-3.5 text-muted-foreground" />
                    <span className="text-sm" data-testid="text-total-weight">
                      {fmtKg(totalWeight)} kg
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <DollarSign className="w-3.5 h-3.5 text-muted-foreground" />
                    <span className="text-sm font-medium" data-testid="text-total-cost">
                      {fmt(totalCost)} write-off
                    </span>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Button variant="outline" size="sm" onClick={() => setSelected(new Set())} className="gap-1.5">
                    <X className="w-3.5 h-3.5" /> Clear
                  </Button>
                  <Button
                    variant="destructive"
                    onClick={() => setConfirming(true)}
                    data-testid="button-dispatch-waste"
                    className="gap-2"
                  >
                    <Trash2 className="w-4 h-4" />
                    Dispatch {selected.size} Bale{selected.size !== 1 ? "s" : ""}
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Dispatch History */}
        <Card>
          <CardHeader className="pb-2 px-4 pt-3 flex flex-row items-center justify-between gap-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <History className="w-4 h-4 text-muted-foreground" />
              Dispatch History
            </CardTitle>
            {history.length > 0 && (
              <span className="text-xs text-muted-foreground">
                {history.length} dispatch{history.length !== 1 ? "es" : ""}
              </span>
            )}
          </CardHeader>
          <CardContent className="p-0">
            {history.length === 0 ? (
              <p className="text-sm text-muted-foreground p-4">No dispatches yet.</p>
            ) : (
              <div className="divide-y">
                {(showAllHistory ? history : history.slice(0, 10)).map((d) => {
                  const isOpen = expandedHistoryIds.has(d.id);
                  const dispatchBales = d.bales || [];
                  return (
                    <div key={d.id}>
                      <div
                        className="flex items-center justify-between px-4 py-2.5 hover-elevate cursor-pointer"
                        onClick={() => toggleHistoryItem(d.id)}
                        data-testid={`row-dispatch-${d.id}`}
                      >
                        <div className="flex items-center gap-2">
                          <ChevronRight
                            className={`w-3.5 h-3.5 text-muted-foreground transition-transform ${isOpen ? "rotate-90" : ""}`}
                          />
                          <div>
                            <p className="font-semibold text-xs">{d.dispatchNumber}</p>
                            <p className="text-xs text-muted-foreground">{d.dispatchDate}</p>
                          </div>
                        </div>
                        <div className="flex items-center gap-3 text-xs">
                          <span className="text-muted-foreground">
                            {d.totalBales} bale{d.totalBales !== 1 ? "s" : ""}
                          </span>
                          <span className="text-muted-foreground">{fmtKg(parseFloat(String(d.totalWeightKg || "0")))} kg</span>
                          <Badge variant="outline" className="text-destructive border-destructive/30 text-xs">
                            {fmt(parseFloat(String(d.totalCostWrittenOff || "0")))}
                          </Badge>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="gap-1 h-6 px-2 text-xs"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleHistoryPrint(d);
                            }}
                            data-testid={`button-reprint-${d.id}`}
                          >
                            <Printer className="w-3 h-3" />
                            Print
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="gap-1 h-6 px-2 text-xs text-destructive hover:text-destructive"
                            onClick={(e) => {
                              e.stopPropagation();
                              setDeleteDispatchId(d.id);
                            }}
                            data-testid={`button-delete-dispatch-${d.id}`}
                          >
                            <Trash2 className="w-3 h-3" />
                            Delete
                          </Button>
                        </div>
                      </div>

                      {isOpen && (
                        <div className="bg-muted/30 px-4 pb-4 pt-1">
                          {d.notes && (
                            <p className="text-xs text-muted-foreground mb-2">
                              <span className="font-medium">Note:</span> {d.notes}
                            </p>
                          )}
                          {dispatchBales.length > 0 ? (
                            <table className="w-full text-xs mt-1 border-collapse">
                              <thead>
                                <tr className="border-b">
                                  <th className="text-left py-1.5 font-semibold text-muted-foreground">Reference</th>
                                  <th className="text-left py-1.5 font-semibold text-muted-foreground">Product</th>
                                  <th className="text-right py-1.5 font-semibold text-muted-foreground">Weight (kg)</th>
                                  <th className="text-right py-1.5 font-semibold text-muted-foreground">Cost W/O</th>
                                </tr>
                              </thead>
                              <tbody>
                                {dispatchBales.map((b: WasteDispatchHistoryBale) => (
                                  <tr key={b.id} className="border-b border-border/40 last:border-0">
                                    <td className="py-1 font-mono text-primary">{b.referenceNumber}</td>
                                    <td className="py-1">{b.productName}</td>
                                    <td className="py-1 text-right">{fmtKg(parseFloat(String(b.weightKg || "0")))}</td>
                                    <td className="py-1 text-right">{fmt(parseFloat(String(b.totalCost || "0")))}</td>
                                  </tr>
                                ))}
                              </tbody>
                              <tfoot>
                                <tr className="border-t font-semibold">
                                  <td className="pt-1.5" colSpan={2}>
                                    TOTAL — {dispatchBales.length} bale{dispatchBales.length !== 1 ? "s" : ""}
                                  </td>
                                  <td className="pt-1.5 text-right">
                                    {fmtKg(
                                      dispatchBales.reduce((s: number, b: WasteDispatchHistoryBale) => s + parseFloat(String(b.weightKg || 0)), 0)
                                    )}
                                  </td>
                                  <td className="pt-1.5 text-right text-destructive">
                                    {fmt(
                                      dispatchBales.reduce((s: number, b: WasteDispatchHistoryBale) => s + parseFloat(String(b.totalCost || 0)), 0)
                                    )}
                                  </td>
                                </tr>
                              </tfoot>
                            </table>
                          ) : (
                            <p className="text-xs text-muted-foreground">No bale details available.</p>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
                {history.length > 10 && (
                  <div className="px-4 py-3 flex items-center justify-between">
                    <span className="text-xs text-muted-foreground">
                      {showAllHistory
                        ? `Showing all ${history.length} dispatches`
                        : `Showing 10 of ${history.length} dispatches`}
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-xs h-7 px-3"
                      onClick={() => setShowAllHistory((v) => !v)}
                      data-testid="button-toggle-history"
                    >
                      {showAllHistory ? "Show less" : `Show all ${history.length}`}
                    </Button>
                  </div>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <WasteDispatchDialogs
        confirming={confirming}
        setConfirming={setConfirming}
        selectedCount={selected.size}
        totalWeight={totalWeight}
        totalCost={totalCost}
        dispatchDate={dispatchDate}
        notes={notes}
        submitPending={submitMutation.isPending}
        onSubmit={() => submitMutation.mutate()}
        deleteDispatchId={deleteDispatchId}
        setDeleteDispatchId={setDeleteDispatchId}
        deletePending={deleteDispatchMutation.isPending}
        onDelete={(id) => deleteDispatchMutation.mutate(id)}
        printData={printData}
        setPrintData={setPrintData}
      />
    </div>
  );
}
