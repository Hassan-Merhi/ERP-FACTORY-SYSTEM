/**
 * ScanningPanel — extracted sub-component.
 *
 * Extracted from FactoryStockAllocationV3.tsx during the Phase 4 god-file split.
 */
import { useState, useRef, useCallback } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ScanLine, CheckCircle, Trash2, AlertTriangle, Loader2, ArrowLeft } from "lucide-react";

import type { LoadDetail, V3Load } from "../types";
import { fmtKg } from "../utils";
import { StatusBadge } from "./StatusBadge";

export function ScanningPanel({ load, onClose }: { load: V3Load; onClose: () => void }) {
  const { toast } = useToast();
  const [scanCode, setScanCode] = useState("");
  const [scanFlash, setScanFlash] = useState<"success" | "error" | null>(null);
  const [pendingBypass, setPendingBypass] = useState<{ code: string; message: string } | null>(null);
  const [confirmFinalize, setConfirmFinalize] = useState(false);
  const scannerRef = useRef<HTMLInputElement>(null);

  const { data: detail, isLoading } = useQuery<LoadDetail>({
    queryKey: ["/api/factory/v3/loads", load.id],
    queryFn: async () => {
      const r = await fetch(`/api/factory/v3/loads/${load.id}`, { credentials: "include" });
      if (!r.ok) throw new Error("Failed to fetch load detail");
      return r.json();
    },
    refetchInterval: 30000,
  });

  const scanMutation = useMutation({
    mutationFn: async ({ code, bypass }: { code: string; bypass?: boolean }) => {
      const r = await fetch(`/api/factory/v3/loads/${load.id}/bales`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ scanCode: code, bypass: bypass ?? false }),
      });
      const data = await r.json();
      if (!r.ok) throw { status: r.status, ...data };
      return data;
    },
    onSuccess: () => {
      setScanFlash("success");
      setScanCode("");
      setPendingBypass(null);
      setTimeout(() => setScanFlash(null), 800);
      queryClient.invalidateQueries({ queryKey: ["/api/factory/v3/loads", load.id] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/v3/loads"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/v3/stock-overview"] });
      scannerRef.current?.focus();
    },
    onError: (err: unknown) => {
      const scanErr = err as { code?: string; message?: string };
      if (scanErr.code === "RESERVED_WARNING" || scanErr.code === "OTHER_V3_LOAD_WARNING") {
        setPendingBypass({ code: scanCode, message: scanErr.message ?? "Scan warning" });
        setScanCode("");
        return;
      }
      setScanFlash("error");
      setTimeout(() => setScanFlash(null), 800);
      toast({ title: "Scan failed", description: scanErr.message, variant: "destructive" });
      setScanCode("");
      scannerRef.current?.focus();
    },
  });

  const removeMutation = useMutation({
    mutationFn: async (lbId: number) => {
      const r = await fetch(`/api/factory/v3/loads/${load.id}/bales/${lbId}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!r.ok) throw new Error("Failed to remove bale");
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/v3/loads", load.id] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/v3/loads"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/v3/stock-overview"] });
    },
    onError: (err) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  const finalizeMutation = useMutation({
    mutationFn: async () => {
      const r = await fetch(`/api/factory/v3/loads/${load.id}/finalize`, {
        method: "POST",
        credentials: "include",
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.message);
      return data;
    },
    onSuccess: () => {
      toast({ title: "Load finalized", description: `${load.loadName} has been finalized.` });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/v3/loads"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/v3/stock-overview"] });
      onClose();
    },
    onError: (err) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  const handleScan = useCallback(() => {
    const code = scanCode.trim();
    if (!code) return;
    scanMutation.mutate({ code });
  }, [scanCode, scanMutation]);

  const handleBypass = () => {
    if (!pendingBypass) return;
    scanMutation.mutate({ code: pendingBypass.code, bypass: true });
  };

  const activeBales = detail?.bales.filter((b) => !b.removedAt) ?? [];
  const removedBales = detail?.bales.filter((b) => b.removedAt) ?? [];

  // Build per-article summary: expected (from proforma lines) vs scanned
  const summaryMap = new Map<
    string,
    { productName: string; expectedQty: number; scannedBales: number; scannedKg: number }
  >();
  for (const line of detail?.proformaLines ?? []) {
    summaryMap.set(line.articleCode, {
      productName: line.productName,
      expectedQty: line.quantity,
      scannedBales: 0,
      scannedKg: 0,
    });
  }
  for (const b of activeBales) {
    if (!b.articleCode) continue;
    const row = summaryMap.get(b.articleCode) ?? {
      productName: b.productName ?? b.articleCode,
      expectedQty: 0,
      scannedBales: 0,
      scannedKg: 0,
    };
    row.scannedBales++;
    row.scannedKg += parseFloat(b.weightKg ?? "0");
    summaryMap.set(b.articleCode, row);
  }
  const summaryRows = Array.from(summaryMap.entries()).map(([code, v]) => ({ code, ...v }));

  const totalExpected = summaryRows.reduce((s, r) => s + r.expectedQty, 0);
  const totalScanned = activeBales.length;
  const diff = totalScanned - totalExpected;

  const flashClass =
    scanFlash === "success"
      ? "ring-2 ring-green-500 bg-green-50 dark:bg-green-950/20"
      : scanFlash === "error"
        ? "ring-2 ring-red-500 bg-red-50 dark:bg-red-950/20"
        : "";

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3 border-b">
        <Button variant="ghost" size="icon" onClick={onClose} data-testid="button-v3-scan-back">
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-semibold truncate">{load.loadName}</span>
            <StatusBadge status={load.status} />
          </div>
          <p className="text-xs text-muted-foreground truncate">
            {load.proformaName} · {load.customerName}
          </p>
        </div>
        <Button
          variant="default"
          size="sm"
          onClick={() => setConfirmFinalize(true)}
          disabled={finalizeMutation.isPending || activeBales.length === 0}
          data-testid="button-v3-finalize"
        >
          <CheckCircle className="h-3.5 w-3.5 mr-1.5" />
          Finalize Load
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {/* Scan input */}
        <Card className={`transition-all duration-150 ${flashClass}`}>
          <CardContent className="p-4">
            <p className="text-xs font-medium text-muted-foreground mb-2 uppercase tracking-wide">Scan Bale</p>
            <div className="flex gap-2">
              <Input
                ref={scannerRef}
                autoFocus
                value={scanCode}
                onChange={(e) => setScanCode(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleScan();
                }}
                placeholder="Scan barcode or type reference..."
                className="font-mono text-sm"
                data-testid="input-v3-scan"
              />
              <Button
                onClick={handleScan}
                disabled={scanMutation.isPending || !scanCode.trim()}
                data-testid="button-v3-scan-submit"
              >
                {scanMutation.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <ScanLine className="h-4 w-4" />
                )}
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Totals strip */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <Card>
            <CardContent className="p-3 text-center">
              <p className="text-xs text-muted-foreground">Expected</p>
              <p className="text-lg font-semibold">{totalExpected}</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-3 text-center">
              <p className="text-xs text-muted-foreground">Scanned</p>
              <p className="text-lg font-semibold text-green-600 dark:text-green-400">{totalScanned}</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-3 text-center">
              <p className="text-xs text-muted-foreground">Difference</p>
              <p
                className={`text-lg font-semibold ${diff < 0 ? "text-orange-500" : diff > 0 ? "text-blue-500" : "text-muted-foreground"}`}
              >
                {diff > 0 ? "+" : ""}
                {diff}
              </p>
            </CardContent>
          </Card>
        </div>

        {/* Per-article summary */}
        {summaryRows.length > 0 && (
          <Card>
            <CardHeader className="pb-2 pt-3 px-4">
              <CardTitle className="text-sm">Item Summary</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <Table>
                <TableHeader className="sticky top-0 z-30 bg-background">
                  <TableRow>
                    <TableHead className="pl-4 text-xs">Item</TableHead>
                    <TableHead className="text-xs text-right">Expected</TableHead>
                    <TableHead className="text-xs text-right">Scanned</TableHead>
                    <TableHead className="pr-4 text-xs text-right">Diff</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {summaryRows.map((r) => {
                    const d = r.scannedBales - r.expectedQty;
                    return (
                      <TableRow key={r.code}>
                        <TableCell className="pl-4 py-2">
                          <p className="text-sm font-medium">{r.productName}</p>
                          <p className="text-xs text-muted-foreground font-mono">{r.code}</p>
                        </TableCell>
                        <TableCell className="text-right text-sm py-2">{r.expectedQty}</TableCell>
                        <TableCell className="text-right text-sm py-2 text-green-600 dark:text-green-400">
                          {r.scannedBales}
                        </TableCell>
                        <TableCell
                          className={`pr-4 text-right text-sm py-2 font-medium ${d < 0 ? "text-orange-500" : d > 0 ? "text-blue-500" : "text-muted-foreground"}`}
                        >
                          {d > 0 ? "+" : ""}
                          {d}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        )}

        {/* Scanned bales list */}
        <Card>
          <CardHeader className="pb-2 pt-3 px-4">
            <CardTitle className="text-sm">Scanned Bales ({activeBales.length})</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {isLoading && <p className="text-sm text-muted-foreground text-center py-4">Loading...</p>}
            {!isLoading && activeBales.length === 0 && (
              <p className="text-sm text-muted-foreground text-center py-4">No bales scanned yet</p>
            )}
            <Table>
              <TableBody>
                {activeBales.map((b) => (
                  <TableRow key={b.id} data-testid={`row-v3-bale-${b.id}`}>
                    <TableCell className="pl-4 py-2">
                      <p className="text-sm font-mono font-medium">{b.baleReference}</p>
                      <p className="text-xs text-muted-foreground">{b.productName ?? b.articleCode ?? "—"}</p>
                    </TableCell>
                    <TableCell className="text-sm py-2 text-muted-foreground">{fmtKg(b.weightKg)}</TableCell>
                    <TableCell className="py-2 text-right">
                      <Button
                        size="icon"
                        variant="ghost"
                        onClick={() => removeMutation.mutate(b.id)}
                        disabled={removeMutation.isPending}
                        data-testid={`button-v3-remove-bale-${b.id}`}
                      >
                        <Trash2 className="h-3.5 w-3.5 text-muted-foreground" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        {/* Removed bales (collapsed) */}
        {removedBales.length > 0 && (
          <p className="text-xs text-muted-foreground text-center">
            {removedBales.length} bale(s) removed from this load
          </p>
        )}
      </div>

      {/* Bypass warning dialog */}
      <AlertDialog
        open={!!pendingBypass}
        onOpenChange={(open) => {
          if (!open) setPendingBypass(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-orange-500" /> Warning
            </AlertDialogTitle>
            <AlertDialogDescription>{pendingBypass?.message}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              onClick={() => {
                setPendingBypass(null);
                scannerRef.current?.focus();
              }}
            >
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction onClick={handleBypass}>Load Anyway</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Finalize confirm */}
      <AlertDialog open={confirmFinalize} onOpenChange={setConfirmFinalize}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Finalize Load?</AlertDialogTitle>
            <AlertDialogDescription>
              This will mark all {activeBales.length} scanned bales as SOLD and close the load. This action cannot be
              undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirmFinalize(false);
                finalizeMutation.mutate();
              }}
            >
              Finalize
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ─────────────────────── Create Load Dialog ───────────────────────
