// Extracted from ./FactoryOpeningBalanceEdit.tsx
import { useState, useEffect } from "react";
import { useLocation, useParams } from "wouter";
import { useEscapeToParent } from "@/hooks/use-escape-to-parent";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { queryClient } from "@/lib/queryClient";
import { useCompany } from "@/contexts/CompanyContext";
import { companyQueryKey } from "@/lib/companyQueryScope";
import { factoryApiRequest } from "@/lib/factoryApi";

interface OBRecord {
  id: number;
  containerId: number;
  receivedKg: string;
  usedKg: string;
  remainingKg: string;
  costPerKg: string;
  costPerKgUsd: string;
  containerNumber: string;
  currencyCode: string | null;
  fxRateToUsd: string | null;
  notes: string | null;
  supplierId: number | null;
  supplierName: string | null;
}

interface FactorySupplier {
  id: number;
  name: string;
  parentId: number | null;
}

export function useFactoryOpeningBalanceEditState() {
  const { selectedCompany } = useCompany();
  const { id } = useParams<{ id: string }>();
  const [, navigate] = useLocation();
  useEscapeToParent("/factory/raw-materials");
  const { toast } = useToast();

  const [form, setForm] = useState({
    supplierId: "",
    supplierName: "",
    receivedKg: "",
    costPerKg: "",
    currencyCode: "USD",
    fxRateToUsd: "1",
    notes: "",
  });
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);

  const { data: record, isLoading } = useQuery<OBRecord>({
    queryKey: companyQueryKey("/api/factory/raw-stock/opening-balance", selectedCompany?.id, id),
    queryFn: async () => {
      const res = await factoryApiRequest("GET", `/api/factory/raw-stock/opening-balance/${id}`);
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message || "Failed to load record");
      }
      return res.json();
    },
    enabled: Boolean(selectedCompany?.id) && !!id,
  });

  const { data: suppliers } = useQuery<FactorySupplier[]>({
    queryKey: companyQueryKey("/api/factory/suppliers", selectedCompany?.id),
    enabled: Boolean(selectedCompany?.id),
  });

  useEffect(() => {
    if (record) {
      setForm({
        supplierId: record.supplierId ? String(record.supplierId) : "",
        supplierName: record.supplierName || "",
        receivedKg: record.receivedKg,
        costPerKg: record.costPerKg,
        currencyCode: record.currencyCode || "USD",
        fxRateToUsd: record.fxRateToUsd || "1",
        notes: record.notes || "",
      });
    }
  }, [record]);

  const updateMutation = useMutation({
    mutationFn: async () => {
      const body: Record<string, unknown> = {
        receivedKg: form.receivedKg,
        costPerKg: form.costPerKg,
        currencyCode: form.currencyCode,
        fxRateToUsd: form.fxRateToUsd,
        notes: form.notes,
      };
      if (form.supplierId) {
        body.supplierId = parseInt(form.supplierId);
      } else if (form.supplierName) {
        body.supplierName = form.supplierName;
      }
      const res = await factoryApiRequest("PATCH", `/api/factory/raw-stock/opening-balance/${id}`, body);
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message || "Failed to update");
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/raw-stock"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/raw-stock/by-container"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/raw-stock/opening-balance", id] });
      toast({ title: "Saved", description: "Opening balance updated successfully." });
    },
    onError: (err: Error) => {
      if (err?._handledGlobally) return;
      toast({ title: "Save failed", description: err.message, variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async () => {
      const res = await factoryApiRequest("DELETE", `/api/factory/raw-stock/opening-balance/${id}`);
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message || "Failed to delete");
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/raw-stock"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/raw-stock/by-container"] });
      toast({ title: "Deleted", description: "Opening balance removed. Bales remain intact." });
      navigate("/factory/raw-materials");
    },
    onError: (err: Error) => {
      if (err?._handledGlobally) return;
      toast({ title: "Delete failed", description: err.message, variant: "destructive" });
      setDeleteDialogOpen(false);
    },
  });

  const handleFieldChange = (field: string, value: string) => {
    setForm((prev) => ({ ...prev, [field]: value }));
  };
  return {
    navigate,
    form,
    setDeleteDialogOpen,
    deleteDialogOpen,
    isLoading,
    record,
    suppliers,
    updateMutation,
    deleteMutation,
    handleFieldChange,
  };
}
