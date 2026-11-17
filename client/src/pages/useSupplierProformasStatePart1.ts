// Extracted from ./SupplierProformas.tsx to keep that module under the source-size cap.
import type { ClientErrorLike } from "@/lib/clientError";
import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useParams, useSearch } from "wouter";
import { useBackToParent } from "@/hooks/use-back-to-parent";
import { useCompany } from "@/contexts/CompanyContext";
import { useEscapeToParent } from "@/hooks/use-escape-to-parent";
import { useExistingRecordChangeAccess } from "@/hooks/useExistingRecordChangeAccess";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";

export interface ProformaLine {
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
  destinationCompanyId: number | null;
  createdAt: string;
  updatedAt: string;
  lines?: ProformaLine[];
}

export const parseFiniteNumber = (value: number | string | null | undefined) => {
  const parsed = typeof value === "number" ? value : Number.parseFloat(value ?? "");
  return Number.isFinite(parsed) ? parsed : 0;
};

export const calculateLineTotal = (qty: number | string, pricePerBale: number | string) =>
  parseFiniteNumber(qty) * parseFiniteNumber(pricePerBale);

export function useSupplierProformasStatePart1() {
  const { toast } = useToast();
  const handleBack = useBackToParent();
  const recordChanges = useExistingRecordChangeAccess();
  const params = useParams<{ supplierId: string }>();
  const supplierId = parseInt(params.supplierId);
  const searchString = useSearch();
  const requestedProformaId = new URLSearchParams(searchString).get("proformaId");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { selectedCompany } = useCompany();
  useEscapeToParent(selectedCompany?.companyType === "properties" ? "/properties/suppliers" : "/suppliers");

  const [selectedProformaId, setSelectedProformaId] = useState<number | null>(null);
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<(() => void) | null>(null);
  const [createRef, setCreateRef] = useState("");
  const [createNotes, setCreateNotes] = useState("");
  const [createDestinationId, setCreateDestinationId] = useState("");
  const [filterDestinationId, setFilterDestinationId] = useState("all");
  const { data: companies = [] } = useQuery<{ id: number; name: string; parentCompanyId?: number | null }[]>({
    queryKey: ["/api/companies"],
  });
  const ownerCompanyId = selectedCompany?.id;
  const destinations = companies.filter(
    (company) => company.id === ownerCompanyId || company.parentCompanyId === ownerCompanyId
  );
  const destinationLabel = (id: number | null) =>
    companies.find((company) => company.id === (id ?? ownerCompanyId))?.name ?? `Company #${id ?? ownerCompanyId}`;
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
  const {
    data: proformas,
    isLoading,
    isError,
    refetch,
  } = useQuery<Proforma[]>({
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
    mutationFn: async (data: { reference: string; notes: string; destinationCompanyId: number }) => {
      const res = await apiRequest("POST", `/api/suppliers/${supplierId}/proformas`, data);
      return res.json();
    },
    onSuccess: (p: Proforma) => {
      queryClient.invalidateQueries({ queryKey: ["/api/suppliers", supplierId, "proformas"] });
      setShowCreateDialog(false);
      setCreateRef("");
      setCreateNotes("");
      setCreateDestinationId("");
      setSelectedProformaId(p.id);
      toast({ title: "Proforma created" });
    },
    onError: (e: ClientErrorLike) => {
      if (e?._handledGlobally) return;
      toast({ title: "Save failed", description: e.message, variant: "destructive" });
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
      toast({ title: "Delete failed", description: e.message, variant: "destructive" });
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
      toast({ title: "Save failed", description: e.message, variant: "destructive" });
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
      toast({ title: "Update failed", description: e.message, variant: "destructive" });
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
      toast({ title: "Delete failed", description: e.message, variant: "destructive" });
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
      toast({ title: "Update failed", description: e.message, variant: "destructive" });
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
      toast({ title: "Update failed", description: e.message, variant: "destructive" });
    },
  });
  return {
    isError,
    refetch,
    addLineMutation,
    addingLine,
    commitRename,
    createDestinationId,
    createMutation,
    createNotes,
    createRef,
    deleteLineMutation,
    deleteMutation,
    destinationLabel,
    destinations,
    editLineData,
    editingLineId,
    fileInputRef,
    filterDestinationId,
    handleBack,
    importTarget,
    isLoading,
    newLine,
    ownerCompanyId,
    pendingDelete,
    proformas,
    recordChanges,
    renameInputRef,
    renameValue,
    renamingId,
    selectedProforma,
    selectedProformaId,
    setAddingLine,
    setCreateDestinationId,
    setCreateNotes,
    setCreateRef,
    setEditLineData,
    setEditingLineId,
    setFilterDestinationId,
    setImportTarget,
    setNewLine,
    setPendingDelete,
    setRenameValue,
    setRenamingId,
    setSelectedProformaId,
    setShowCreateDialog,
    showCreateDialog,
    starMutation,
    startRename,
    supplierId,
    toast,
    updateLineMutation,
  };
}
