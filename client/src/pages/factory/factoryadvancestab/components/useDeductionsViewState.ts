// Extracted from ./DeductionsView.tsx
import { useState, useMemo } from "react";
import { useExistingRecordChangeAccess } from "@/hooks/useExistingRecordChangeAccess";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useDateFormat } from "@/contexts/DateFormatContext";
import { useToast } from "@/hooks/use-toast";
import { queryClient, apiRequest } from "@/lib/queryClient";
import type { FactoryWorker } from "@shared/schema";
import type { DeductionRecord } from "../types";

export function useDeductionsViewState() {
  const { formatDisplayDate } = useDateFormat();
  const { toast } = useToast();
  const recordChanges = useExistingRecordChangeAccess();

  const formatDate = (d: string | null | undefined) => {
    if (!d) return "\u2014";
    try {
      return formatDisplayDate(new Date(d));
    } catch {
      return d;
    }
  };

  const [addOpen, setAddOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<DeductionRecord | null>(null);
  const [filterWorker, setFilterWorker] = useState("all");
  const [filterStatus, setFilterStatus] = useState("pending");
  const [form, setForm] = useState({
    workerId: "",
    amount: "",
    reason: "",
    deductionDate: new Date().toLocaleDateString("en-CA"),
  });

  const { data: workers = [] } = useQuery<FactoryWorker[]>({
    queryKey: ["/api/factory/workers"],
    queryFn: async () => {
      const res = await fetch("/api/factory/workers", { credentials: "include" });
      return res.json();
    },
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

  const { data: deductions = [], isLoading } = useQuery<DeductionRecord[]>({
    queryKey: ["/api/factory/worker-deductions"],
    queryFn: async () => {
      const res = await fetch("/api/factory/worker-deductions", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch deductions");
      return res.json();
    },
  });

  const createMutation = useMutation({
    mutationFn: async () => {
      if (!recordChanges.allowed) throw new Error(recordChanges.reason ?? "");
      const res = await apiRequest("POST", `/api/factory/workers/${form.workerId}/deductions`, {
        amount: form.amount,
        reason: form.reason || undefined,
        deductionDate: form.deductionDate,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || "Failed to create deduction");
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/worker-deductions"] });
      toast({ title: "Deduction recorded" });
      setAddOpen(false);
      setForm({ workerId: "", amount: "", reason: "", deductionDate: new Date().toLocaleDateString("en-CA") });
    },
    onError: (err: Error) => {
      if ((err as { _handledGlobally?: boolean })?._handledGlobally) return;
      toast({ title: "Save failed", description: err.message, variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async ({ workerId, id }: { workerId: number; id: number }) => {
      if (!recordChanges.allowed) throw new Error(recordChanges.reason ?? "");
      const res = await fetch(`/api/factory/workers/${workerId}/deductions/${id}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message || "Failed to delete deduction");
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/worker-deductions"] });
      toast({ title: "Deduction deleted" });
      setDeleteTarget(null);
    },
    onError: (err: Error) => {
      if ((err as { _handledGlobally?: boolean })?._handledGlobally) return;
      toast({ title: "Delete failed", description: err.message, variant: "destructive" });
    },
  });

  const filtered = useMemo(() => {
    let list = Array.isArray(deductions) ? deductions : [];
    if (filterWorker !== "all") list = list.filter((d) => d.workerId === parseInt(filterWorker));
    if (filterStatus === "pending") list = list.filter((d) => !d.applied);
    else if (filterStatus === "applied") list = list.filter((d) => d.applied);
    return list;
  }, [deductions, filterWorker, filterStatus]);

  const pendingTotal = useMemo(
    () => deductions.filter((d) => !d.applied).reduce((s, d) => s + parseFloat(d.amount || "0"), 0),
    [deductions]
  );
  const pendingCount = deductions.filter((d) => !d.applied).length;
  return {
    recordChanges,
    formatDate,
    setAddOpen,
    addOpen,
    setDeleteTarget,
    deleteTarget,
    filterWorker,
    setFilterWorker,
    filterStatus,
    setFilterStatus,
    form,
    setForm,
    workers,
    isLoading,
    createMutation,
    deleteMutation,
    filtered,
    pendingTotal,
    pendingCount,
  };
}
