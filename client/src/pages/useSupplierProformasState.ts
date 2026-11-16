// Extracted from ./SupplierProformas.tsx to keep that module under the source-size cap.
import type { ClientErrorLike } from "@/lib/clientError";
import { getErrorDetails } from "@shared/errorUtils";
import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useParams, useSearch } from "wouter";
import { useBackToParent } from "@/hooks/use-back-to-parent";
import { useEscapeToParent } from "@/hooks/use-escape-to-parent";
import { useExistingRecordChangeAccess } from "@/hooks/useExistingRecordChangeAccess";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import * as XLSX from "@/lib/excelHelper";
import type { Proforma, ProformaLine } from "./SupplierProformasTypes";

export function useSupplierProformasState() {
  const { toast } = useToast();
  const handleBack = useBackToParent();
  const recordChanges = useExistingRecordChangeAccess();
  const params = useParams<{ supplierId: string }>();
  const supplierId = parseInt(params.supplierId);
  const searchString = useSearch();
  const requestedProformaId = new URLSearchParams(searchString).get("proformaId");
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

  useEffect(() => {
    if (!requestedProformaId || selectedProformaId || !proformas?.length) return;
    const parsedProformaId = Number.parseInt(requestedProformaId, 10);
    if (!Number.isFinite(parsedProformaId)) return;
    if (proformas.some((p) => p.id === parsedProformaId)) {
      setSelectedProformaId(parsedProformaId);
    }
  }, [requestedProformaId, proformas, selectedProformaId]);

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
  return {
    addLineMutation,
    addingLine,
    commitRename,
    createMutation,
    createNotes,
    createRef,
    deleteLineMutation,
    deleteMutation,
    downloadTemplate,
    editLineData,
    editingLineId,
    fileInputRef,
    handleBack,
    handleFileImport,
    isLoading,
    newLine,
    pendingDelete,
    proformas,
    recordChanges,
    renameInputRef,
    renameValue,
    renamingId,
    selectedProforma,
    selectedProformaId,
    setAddingLine,
    setCreateNotes,
    setCreateRef,
    setEditLineData,
    setEditingLineId,
    setImportTarget,
    setNewLine,
    setPendingDelete,
    setRenameValue,
    setRenamingId,
    setSelectedProformaId,
    setShowCreateDialog,
    showCreateDialog,
    starMutation,
    startEdit,
    startRename,
    supplierId,
    updateLineMutation,
  };
}
