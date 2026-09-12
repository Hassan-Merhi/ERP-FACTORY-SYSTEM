import type { ClientErrorLike } from "@/lib/clientError";
import { getErrorDetails } from "@shared/errorUtils";
import { useState, useRef, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useParams, useLocation } from "wouter";
import { useBackToParent } from "@/hooks/use-back-to-parent";
import { useEscapeToParent } from "@/hooks/use-escape-to-parent";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { ArrowLeft, Plus, Trash2, Upload, Download, FileText, Pencil, Save, X, Star } from "lucide-react";
import { format } from "date-fns";
import * as XLSX from "@/lib/excelHelper";
import { DeleteConfirmDialog } from "@/components/ConfirmationDialog";
import { PageHeader } from "@/components/PageHeader";

interface ProformaLine {
  id: number;
  proformaId: number;
  barcode: string;
  itemName: string;
  qty: number;
  weightPerBale: string;
  pricePerBale: string;
}

interface Proforma {
  id: number;
  companyId: number;
  supplierId: number;
  reference: string;
  notes: string | null;
  isStarred: boolean;
  createdAt: string;
  updatedAt: string;
  lines?: ProformaLine[];
}

const parseFiniteNumber = (value: number | string | null | undefined) => {
  const parsed = typeof value === "number" ? value : Number.parseFloat(value ?? "");
  return Number.isFinite(parsed) ? parsed : 0;
};

const calculateLineTotal = (qty: number | string, pricePerBale: number | string) =>
  parseFiniteNumber(qty) * parseFiniteNumber(pricePerBale);

export default function SupplierProformas() {
  const { toast } = useToast();
  const [, _navigate] = useLocation();
  const handleBack = useBackToParent();
  const params = useParams<{ supplierId: string }>();
  const supplierId = parseInt(params.supplierId);
  const fileInputRef = useRef<HTMLInputElement>(null);
  useEscapeToParent("/suppliers");

  const [selectedProformaId, setSelectedProformaId] = useState<number | null>(null);
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<(() => void) | null>(null);
  const [createRef, setCreateRef] = useState("");
  const [createNotes, setCreateNotes] = useState("");
  const [addingLine, setAddingLine] = useState(false);
  const [newLine, setNewLine] = useState({
    barcode: "",
    itemName: "",
    qty: "0",
    weightPerBale: "0",
    pricePerBale: "0",
  });
  const [editingLineId, setEditingLineId] = useState<number | null>(null);
  const [editLineData, setEditLineData] = useState({
    barcode: "",
    itemName: "",
    qty: "0",
    weightPerBale: "0",
    pricePerBale: "0",
  });
  const [importTarget, setImportTarget] = useState<number | null>(null);
  const [renamingId, setRenamingId] = useState<number | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const renameInputRef = useRef<HTMLInputElement>(null);

  const { data: proformas, isLoading } = useQuery<Proforma[]>({
    queryKey: ["/api/suppliers", supplierId, "proformas"],
    queryFn: async () => {
      const res = await fetch(`/api/suppliers/${supplierId}/proformas`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch proformas");
      return res.json();
    },
    enabled: !!supplierId,
  });

  const { data: selectedProforma } = useQuery<Proforma>({
    queryKey: ["/api/suppliers", supplierId, "proformas", selectedProformaId],
    queryFn: async () => {
      const res = await fetch(`/api/suppliers/${supplierId}/proformas/${selectedProformaId}`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to fetch proforma");
      return res.json();
    },
    enabled: !!selectedProformaId,
  });

  const createMutation = useMutation({
    mutationFn: async (data: { reference: string; notes: string }) => {
      const res = await apiRequest("POST", `/api/suppliers/${supplierId}/proformas`, data);
      return res.json();
    },
    onSuccess: (p: Proforma) => {
      queryClient.invalidateQueries({ queryKey: ["/api/suppliers", supplierId, "proformas"] });
      setShowCreateDialog(false);
      setCreateRef("");
      setCreateNotes("");
      setSelectedProformaId(p.id);
      toast({ title: "Proforma created" });
    },
    onError: (e: ClientErrorLike) => {
      if (e?._handledGlobally) return;
      toast({ title: "Error", description: e.message, variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: number) => {
      await apiRequest("DELETE", `/api/suppliers/${supplierId}/proformas/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/suppliers", supplierId, "proformas"] });
      if (selectedProformaId) setSelectedProformaId(null);
      toast({ title: "Proforma deleted" });
    },
    onError: (e: ClientErrorLike) => {
      if (e?._handledGlobally) return;
      toast({ title: "Error", description: e.message, variant: "destructive" });
    },
  });

  const addLineMutation = useMutation({
    mutationFn: async (data: {
      barcode: string;
      itemName: string;
      qty: string;
      weightPerBale: string;
      pricePerBale: string;
    }) => {
      const res = await apiRequest("POST", `/api/suppliers/${supplierId}/proformas/${selectedProformaId}/lines`, data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/suppliers", supplierId, "proformas", selectedProformaId] });
      setAddingLine(false);
      setNewLine({ barcode: "", itemName: "", qty: "0", weightPerBale: "0", pricePerBale: "0" });
    },
    onError: (e: ClientErrorLike) => {
      if (e?._handledGlobally) return;
      toast({ title: "Error", description: e.message, variant: "destructive" });
    },
  });

  const updateLineMutation = useMutation({
    mutationFn: async ({ id, data }: { id: number; data: unknown }) => {
      const res = await apiRequest("PATCH", `/api/supplier-proforma-lines/${id}`, data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/suppliers", supplierId, "proformas", selectedProformaId] });
      setEditingLineId(null);
    },
    onError: (e: ClientErrorLike) => {
      if (e?._handledGlobally) return;
      toast({ title: "Error", description: e.message, variant: "destructive" });
    },
  });

  const deleteLineMutation = useMutation({
    mutationFn: async (id: number) => {
      await apiRequest("DELETE", `/api/supplier-proforma-lines/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/suppliers", supplierId, "proformas", selectedProformaId] });
    },
    onError: (e: ClientErrorLike) => {
      if (e?._handledGlobally) return;
      toast({ title: "Error", description: e.message, variant: "destructive" });
    },
  });

  const renameMutation = useMutation({
    mutationFn: async ({ id, reference }: { id: number; reference: string }) => {
      const res = await apiRequest("PATCH", `/api/suppliers/${supplierId}/proformas/${id}`, { reference });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/suppliers", supplierId, "proformas"] });
      queryClient.invalidateQueries({ queryKey: ["/api/suppliers", supplierId, "proformas", renamingId] });
      setRenamingId(null);
      toast({ title: "Proforma renamed" });
    },
    onError: (e: ClientErrorLike) => {
      if (e?._handledGlobally) return;
      toast({ title: "Error", description: e.message, variant: "destructive" });
    },
  });

  const startRename = (e: React.MouseEvent, p: Proforma) => {
    e.stopPropagation();
    setRenamingId(p.id);
    setRenameValue(p.reference);
  };

  const commitRename = (id: number) => {
    const trimmed = renameValue.trim();
    if (!trimmed) {
      setRenamingId(null);
      return;
    }
    renameMutation.mutate({ id, reference: trimmed });
  };

  useEffect(() => {
    if (renamingId !== null) renameInputRef.current?.focus();
  }, [renamingId]);

  const starMutation = useMutation({
    mutationFn: async (proformaId: number) => {
      const res = await apiRequest("PATCH", `/api/suppliers/${supplierId}/proformas/${proformaId}/star`, {});
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/suppliers", supplierId, "proformas"] });
    },
    onError: (e: ClientErrorLike) => {
      if (e?._handledGlobally) return;
      toast({ title: "Error", description: e.message, variant: "destructive" });
    },
  });

  const importLinesMutation = useMutation({
    mutationFn: async ({ proformaId, lines }: { proformaId: number; lines: unknown[] }) => {
      const res = await apiRequest("POST", `/api/suppliers/${supplierId}/proformas/${proformaId}/import-lines`, {
        lines,
      });
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/suppliers", supplierId, "proformas", selectedProformaId] });
      toast({ title: "Import complete", description: `${data.imported} lines imported` });
    },
    onError: (e: ClientErrorLike) => {
      if (e?._handledGlobally) return;
      toast({ title: "Import error", description: e.message, variant: "destructive" });
    },
  });

  const handleFileImport = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !importTarget) return;
    const reader = new FileReader();
    reader.onload = async (evt) => {
      try {
        const data = new Uint8Array(evt.target?.result as ArrayBuffer);
        const wb = await XLSX.read(data, { type: "array" });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(ws);
        /** Parse a human-entered decimal from Excel into a plain number, 0 on failure. */
        const parseExcelNum = (v: unknown): number => {
          const raw = String(v ?? "").trim();
          const stripped = raw.replace(/^[^0-9\-(]+/, "").replace(/[^0-9.]+$/, "");
          const noCommas = stripped.replace(/,(?=\d{3}(?:[,.]|$))/g, "");
          if (!/^-?\d+(\.\d+)?$/.test(noCommas)) return 0;
          const n = parseFloat(noCommas);
          return isFinite(n) ? n : 0;
        };
        const lines = rows
          .map((r) => ({
            barcode: String(r.Barcode || r.barcode || "").trim(),
            itemName: String(r["Item Name"] || r.itemName || r.Name || "").trim(),
            qty: Math.max(0, Math.trunc(parseExcelNum(r.Qty ?? r.qty ?? r.Quantity))),
            weightPerBale: String(parseExcelNum(r["Weight per Bale"] ?? r.weightPerBale ?? r.Weight)),
            pricePerBale: String(parseExcelNum(r["Price per Bale"] ?? r.pricePerBale ?? r.Price)),
          }))
          .filter((l) => l.barcode);
        if (lines.length === 0) {
          toast({
            title: "No data found",
            description: "Check that your Excel has columns: Barcode, Item Name, Qty, Weight per Bale, Price per Bale",
            variant: "destructive",
          });
          return;
        }
        importLinesMutation.mutate({ proformaId: importTarget, lines });
      } catch (err) {
        toast({ title: "Parse error", description: getErrorDetails(err).message, variant: "destructive" });
      }
    };
    reader.readAsArrayBuffer(file);
    e.target.value = "";
  };

  const downloadTemplate = async () => {
    const ws = XLSX.utils.aoa_to_sheet([
      ["Barcode", "Item Name", "Qty", "Weight per Bale", "Price per Bale"],
      ["SAMPLE001", "Sample Item", 10, 45, 25.5],
    ]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Proforma");
    await XLSX.writeFile(wb, "proforma_template.xlsx");
  };

  const startEdit = (line: ProformaLine) => {
    setEditingLineId(line.id);
    setEditLineData({
      barcode: line.barcode,
      itemName: line.itemName,
      qty: String(line.qty),
      weightPerBale: line.weightPerBale,
      pricePerBale: line.pricePerBale,
    });
  };

  if (isLoading) {
    return (
      <div className="p-6">
        <Skeleton className="h-10 w-64 mb-4" />
        <Skeleton className="h-96" />
      </div>
    );
  }

  const lines = selectedProforma?.lines || [];
  const totalQty = lines.reduce((total, line) => total + parseFiniteNumber(line.qty), 0);
  const totalAmount = lines.reduce((total, line) => total + calculateLineTotal(line.qty, line.pricePerBale), 0);

  return (
    <div className="flex flex-col h-full p-4 lg:p-6 overflow-y-auto">
      <input ref={fileInputRef} type="file" accept=".xlsx,.csv" className="hidden" onChange={handleFileImport} />

      <div className="flex flex-wrap items-center justify-between gap-4 mb-6">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" onClick={handleBack} data-testid="button-back">
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div>
            <PageHeader title="Supplier Proformas" />
            <p className="text-muted-foreground text-sm">Manage proformas for supplier #{supplierId}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={downloadTemplate} data-testid="button-download-template">
            <Download className="mr-2 h-4 w-4" />
            Template
          </Button>
          <Button onClick={() => setShowCreateDialog(true)} data-testid="button-create-proforma">
            <Plus className="mr-2 h-4 w-4" />
            New Proforma
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div>
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Proformas</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {(!proformas || proformas.length === 0) && (
                <p className="text-sm text-muted-foreground">No proformas yet. Create one to get started.</p>
              )}
              {proformas?.map((p) => (
                <div
                  key={p.id}
                  className={`flex items-center justify-between gap-2 p-2 rounded-md cursor-pointer ${selectedProformaId === p.id ? "bg-accent" : "hover-elevate"}`}
                  onClick={() => setSelectedProformaId(p.id)}
                  data-testid={`row-proforma-${p.id}`}
                >
                  <div className="min-w-0 flex-1" onClick={(e) => renamingId === p.id && e.stopPropagation()}>
                    {renamingId === p.id ? (
                      <Input
                        ref={renameInputRef}
                        value={renameValue}
                        onChange={(e) => setRenameValue(e.target.value)}
                        onBlur={() => commitRename(p.id)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            commitRename(p.id);
                          }
                          if (e.key === "Escape") {
                            e.stopPropagation();
                            setRenamingId(null);
                          }
                        }}
                        onClick={(e) => e.stopPropagation()}
                        className="h-7 text-sm px-2 py-0"
                        data-testid={`input-rename-proforma-${p.id}`}
                      />
                    ) : (
                      <>
                        <div className="flex items-center gap-1.5">
                          {p.isStarred && <Star className="h-3 w-3 shrink-0 fill-amber-400 text-amber-400" />}
                          <span className="text-sm font-medium truncate">{p.reference}</span>
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {format(new Date(p.createdAt), "MMM d, yyyy")}
                        </div>
                      </>
                    )}
                  </div>
                  {renamingId !== p.id && (
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={(e) => startRename(e, p)}
                      data-testid={`button-rename-proforma-${p.id}`}
                      title="Rename"
                    >
                      <Pencil className="h-3 w-3 text-muted-foreground" />
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={(e) => {
                      e.stopPropagation();
                      starMutation.mutate(p.id);
                    }}
                    data-testid={`button-star-proforma-${p.id}`}
                    title={p.isStarred ? "Unstar (remove as default)" : "Star (use for auto-comparison)"}
                  >
                    <Star
                      className={`h-3.5 w-3.5 ${p.isStarred ? "fill-amber-400 text-amber-400" : "text-muted-foreground"}`}
                    />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={(e) => {
                      e.stopPropagation();
                      setPendingDelete(() => () => deleteMutation.mutate(p.id));
                    }}
                    data-testid={`button-delete-proforma-${p.id}`}
                  >
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </div>
              ))}
            </CardContent>
          </Card>
        </div>

        <div className="lg:col-span-2">
          {selectedProformaId && selectedProforma ? (
            <Card>
              <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
                <div>
                  <CardTitle className="text-lg">{selectedProforma.reference}</CardTitle>
                  {selectedProforma.notes && (
                    <p className="text-xs text-muted-foreground mt-1">{selectedProforma.notes}</p>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant="secondary">{lines.length} items</Badge>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setImportTarget(selectedProformaId);
                      fileInputRef.current?.click();
                    }}
                    data-testid="button-import-lines"
                  >
                    <Upload className="mr-1 h-3 w-3" />
                    Import Excel
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      window.location.href = `/api/suppliers/${supplierId}/proformas/${selectedProformaId}/export-excel`;
                    }}
                    data-testid="button-export-excel"
                  >
                    <Download className="mr-1 h-3 w-3" />
                    Export Excel
                  </Button>
                  <Button size="sm" onClick={() => setAddingLine(true)} data-testid="button-add-line">
                    <Plus className="mr-1 h-3 w-3" />
                    Add Line
                  </Button>
                </div>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader className="sticky top-0 z-30 bg-background">
                    <TableRow>
                      <TableHead>Barcode</TableHead>
                      <TableHead>Item Name</TableHead>
                      <TableHead className="text-right">Qty</TableHead>
                      <TableHead className="text-right">Price/Bale</TableHead>
                      <TableHead className="text-right">Total Amount</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {addingLine && (
                      <TableRow>
                        <TableCell>
                          <Input
                            value={newLine.barcode}
                            onChange={(e) => setNewLine({ ...newLine, barcode: e.target.value })}
                            placeholder="Barcode"
                            className="h-8 text-xs"
                            data-testid="input-new-barcode"
                          />
                        </TableCell>
                        <TableCell>
                          <Input
                            value={newLine.itemName}
                            onChange={(e) => setNewLine({ ...newLine, itemName: e.target.value })}
                            placeholder="Item Name"
                            className="h-8 text-xs"
                            data-testid="input-new-itemname"
                          />
                        </TableCell>
                        <TableCell>
                          <Input
                            type="number"
                            value={newLine.qty}
                            onChange={(e) => setNewLine({ ...newLine, qty: e.target.value })}
                            className="h-8 text-xs w-16 text-right"
                            data-testid="input-new-qty"
                          />
                        </TableCell>
                        <TableCell>
                          <Input
                            type="number"
                            step="0.01"
                            value={newLine.pricePerBale}
                            onChange={(e) => setNewLine({ ...newLine, pricePerBale: e.target.value })}
                            className="h-8 text-xs w-20 text-right"
                            data-testid="input-new-price"
                          />
                        </TableCell>
                        <TableCell className="text-right font-mono">
                          {calculateLineTotal(newLine.qty, newLine.pricePerBale).toFixed(2)}
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex items-center justify-end gap-1">
                            <Button
                              size="icon"
                              variant="ghost"
                              onClick={() => addLineMutation.mutate(newLine)}
                              data-testid="button-save-new-line"
                            >
                              <Save className="h-3 w-3" />
                            </Button>
                            <Button
                              size="icon"
                              variant="ghost"
                              onClick={() => setAddingLine(false)}
                              data-testid="button-cancel-new-line"
                            >
                              <X className="h-3 w-3" />
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    )}
                    {lines.map((line) => (
                      <TableRow key={line.id} data-testid={`row-line-${line.id}`}>
                        {editingLineId === line.id ? (
                          <>
                            <TableCell>
                              <Input
                                value={editLineData.barcode}
                                onChange={(e) => setEditLineData({ ...editLineData, barcode: e.target.value })}
                                className="h-8 text-xs"
                              />
                            </TableCell>
                            <TableCell>
                              <Input
                                value={editLineData.itemName}
                                onChange={(e) => setEditLineData({ ...editLineData, itemName: e.target.value })}
                                className="h-8 text-xs"
                              />
                            </TableCell>
                            <TableCell>
                              <Input
                                type="number"
                                value={editLineData.qty}
                                onChange={(e) => setEditLineData({ ...editLineData, qty: e.target.value })}
                                className="h-8 text-xs w-16 text-right"
                              />
                            </TableCell>
                            <TableCell>
                              <Input
                                type="number"
                                step="0.01"
                                value={editLineData.pricePerBale}
                                onChange={(e) => setEditLineData({ ...editLineData, pricePerBale: e.target.value })}
                                className="h-8 text-xs w-20 text-right"
                              />
                            </TableCell>
                            <TableCell className="text-right font-mono">
                              {calculateLineTotal(editLineData.qty, editLineData.pricePerBale).toFixed(2)}
                            </TableCell>
                            <TableCell className="text-right">
                              <div className="flex items-center justify-end gap-1">
                                <Button
                                  size="icon"
                                  variant="ghost"
                                  onClick={() => updateLineMutation.mutate({ id: line.id, data: editLineData })}
                                >
                                  <Save className="h-3 w-3" />
                                </Button>
                                <Button size="icon" variant="ghost" onClick={() => setEditingLineId(null)}>
                                  <X className="h-3 w-3" />
                                </Button>
                              </div>
                            </TableCell>
                          </>
                        ) : (
                          <>
                            <TableCell className="font-mono text-xs">{line.barcode}</TableCell>
                            <TableCell className="text-sm">{line.itemName}</TableCell>
                            <TableCell className="text-right font-mono">{line.qty}</TableCell>
                            <TableCell className="text-right font-mono">
                              {parseFloat(line.pricePerBale).toFixed(2)}
                            </TableCell>
                            <TableCell className="text-right font-mono">
                              {calculateLineTotal(line.qty, line.pricePerBale).toFixed(2)}
                            </TableCell>
                            <TableCell className="text-right">
                              <div className="flex items-center justify-end gap-1">
                                <Button
                                  size="icon"
                                  variant="ghost"
                                  onClick={() => startEdit(line)}
                                  data-testid={`button-edit-line-${line.id}`}
                                >
                                  <Pencil className="h-3 w-3" />
                                </Button>
                                <Button
                                  size="icon"
                                  variant="ghost"
                                  onClick={() => setPendingDelete(() => () => deleteLineMutation.mutate(line.id))}
                                  data-testid={`button-delete-line-${line.id}`}
                                >
                                  <Trash2 className="h-3 w-3" />
                                </Button>
                              </div>
                            </TableCell>
                          </>
                        )}
                      </TableRow>
                    ))}
                    {lines.length === 0 && !addingLine && (
                      <TableRow>
                        <TableCell colSpan={6} className="text-center text-muted-foreground text-sm py-8">
                          No lines yet. Add lines manually or import from Excel.
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                  {lines.length > 0 && (
                    <TableFooter>
                      <TableRow data-testid="row-proforma-totals">
                        <TableCell colSpan={2} className="font-semibold">
                          Total
                        </TableCell>
                        <TableCell className="text-right font-mono font-semibold" data-testid="total-proforma-qty">
                          {totalQty}
                        </TableCell>
                        <TableCell />
                        <TableCell className="text-right font-mono font-semibold" data-testid="total-proforma-amount">
                          {totalAmount.toFixed(2)}
                        </TableCell>
                        <TableCell />
                      </TableRow>
                    </TableFooter>
                  )}
                </Table>
              </CardContent>
            </Card>
          ) : (
            <Card>
              <CardContent className="flex items-center justify-center py-16">
                <div className="text-center text-muted-foreground">
                  <FileText className="h-12 w-12 mx-auto mb-3 opacity-50" />
                  <p className="text-sm">Select a proforma from the list or create a new one</p>
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      </div>

      <DeleteConfirmDialog
        open={!!pendingDelete}
        onOpenChange={(o) => {
          if (!o) setPendingDelete(null);
        }}
        onConfirm={() => {
          pendingDelete?.();
          setPendingDelete(null);
        }}
      />

      <Dialog open={showCreateDialog} onOpenChange={setShowCreateDialog}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Create Proforma</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <label className="text-sm font-medium mb-1 block">Reference *</label>
              <Input
                value={createRef}
                onChange={(e) => setCreateRef(e.target.value)}
                placeholder="e.g. PF-2026-001"
                data-testid="input-proforma-ref"
              />
            </div>
            <div>
              <label className="text-sm font-medium mb-1 block">Notes</label>
              <Textarea
                value={createNotes}
                onChange={(e) => setCreateNotes(e.target.value)}
                placeholder="Optional notes..."
                data-testid="input-proforma-notes"
              />
            </div>
            <div className="flex items-center justify-end gap-2">
              <Button variant="outline" onClick={() => setShowCreateDialog(false)}>
                Cancel
              </Button>
              <Button
                onClick={() => createMutation.mutate({ reference: createRef, notes: createNotes })}
                disabled={!createRef.trim() || createMutation.isPending}
                data-testid="button-confirm-create"
              >
                Create
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
