// Extracted from ./WasteDispatch.tsx to keep that module under the source-size cap.
import type { ClientErrorLike } from "@/lib/clientError";
import { useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useCompany } from "@/contexts/CompanyContext";
import { companyQueryKey } from "@/lib/companyQueryScope";
import { useToast } from "@/hooks/use-toast";
import type {
  Bale,
  ProductGroup,
  WasteDispatchHistoryBale,
  WasteDispatchHistoryEntry,
  WasteDispatchPrintData,
} from "./wastedispatch/types";
import { fmt, fmtKg, today } from "./wastedispatch/utils";

export function useWasteDispatchState() {
  const { selectedCompany } = useCompany();
  const { toast } = useToast();

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
    queryKey: companyQueryKey("/api/factory/waste-dispatch/bales", selectedCompany?.id, search),
    enabled: Boolean(selectedCompany?.id),
    queryFn: async () => {
      const params = new URLSearchParams();
      if (search) params.set("search", search);
      const r = await fetch(`/api/factory/waste-dispatch/bales?${params}`, { credentials: "include" });
      if (!r.ok) throw new Error(await r.text());
      return r.json();
    },
  });

  const { data: history = [] } = useQuery<WasteDispatchHistoryEntry[]>({
    queryKey: companyQueryKey("/api/factory/waste-dispatch/history", selectedCompany?.id),
    enabled: Boolean(selectedCompany?.id),
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

  const scanReference = (code: string) => {
    const ref = code.trim().toUpperCase();
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

  const handleScan = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      scanReference(scanInput);
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
    const totalW = dispatchBales.reduce(
      (s: number, b: WasteDispatchHistoryBale) => s + parseFloat(String(b.weightKg || 0)),
      0
    );
    const totalC = dispatchBales.reduce(
      (s: number, b: WasteDispatchHistoryBale) => s + parseFloat(String(b.totalCost || 0)),
      0
    );
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
  return {
    bales,
    confirming,
    deleteDispatchId,
    deleteDispatchMutation,
    dispatchDate,
    expandedGroups,
    expandedHistoryIds,
    grandTotals,
    handleHistoryPrint,
    handleScan,
    history,
    isLoading,
    notes,
    printData,
    productGroups,
    scanInput,
    scanInputRef,
    scanReference,
    search,
    selected,
    setConfirming,
    setDeleteDispatchId,
    setDispatchDate,
    setNotes,
    setPrintData,
    setScanInput,
    setSearch,
    setSelected,
    setShowAllHistory,
    showAllHistory,
    submitMutation,
    toggleAll,
    toggleBale,
    toggleExpandGroup,
    toggleGroup,
    toggleHistoryItem,
    totalCost,
    totalWeight,
  };
}
