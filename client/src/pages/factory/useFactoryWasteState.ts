// Extracted from ./FactoryWaste.tsx
import { useState, useEffect } from "react";
import { addDays, format } from "date-fns";
import { useDateFormat } from "@/contexts/DateFormatContext";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
import { useCompany } from "@/contexts/CompanyContext";
import { companyQueryKey } from "@/lib/companyQueryScope";
import { factoryApiRequest } from "@/lib/factoryApi";
import { useExistingRecordChangeAccess } from "@/hooks/useExistingRecordChangeAccess";
import { getDefaultDateRange, type WasteEntry } from "./FactoryWasteHelpers";

export function useFactoryWasteState() {
  const { selectedCompany } = useCompany();
  const { formatDisplayDate } = useDateFormat();
  const recordChanges = useExistingRecordChangeAccess();
  const canAddWaste = recordChanges.canCreate("POST", "/api/factory/waste");
  const defaults = getDefaultDateRange();
  const [from, setFrom] = useState(defaults.from);
  const [to, setTo] = useState(defaults.to);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [pendingDeleteId, setPendingDeleteId] = useState<number | null>(null);

  const [formDate, setFormDate] = useState(new Date().toLocaleDateString("en-CA"));
  const [formKg, setFormKg] = useState("");
  const [formWasteType, setFormWasteType] = useState("");
  const [formReason, setFormReason] = useState("");
  const [formMixBatchId, setFormMixBatchId] = useState("");
  const [formSupplierId, setFormSupplierId] = useState("");
  const [formContainerId, setFormContainerId] = useState("");

  // Keyboard date navigation: "-" = back 1 day, Shift+"+" = forward 1 day
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName?.toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select") return;
      const fmt = "yyyy-MM-dd";
      if (e.key === "-") {
        e.preventDefault();
        setFrom((prev) => format(addDays(new Date(prev + "T00:00:00"), -1), fmt));
        setTo((prev) => format(addDays(new Date(prev + "T00:00:00"), -1), fmt));
      } else if (e.key === "+" && e.shiftKey) {
        e.preventDefault();
        setFrom((prev) => format(addDays(new Date(prev + "T00:00:00"), 1), fmt));
        setTo((prev) => format(addDays(new Date(prev + "T00:00:00"), 1), fmt));
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  const wasteQuery = useQuery<WasteEntry[]>({
    queryKey: companyQueryKey("/api/factory/waste", selectedCompany?.id, from, to),
    enabled: Boolean(selectedCompany?.id),
    queryFn: async () => {
      const res = await fetch(`/api/factory/waste?from=${from}&to=${to}`);
      if (!res.ok) throw new Error("Failed to load waste entries");
      return res.json();
    },
  });

  const createMutation = useMutation({
    mutationFn: async (data: {
      date: string;
      kgWaste: number;
      wasteType?: string;
      reason?: string;
      mixBatchId?: number;
      supplierId?: number;
      containerId?: number;
    }) => {
      const res = await factoryApiRequest("POST", "/api/factory/waste", data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: companyQueryKey("/api/factory/waste", selectedCompany?.id, from, to) });
      setDialogOpen(false);
      resetForm();
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: number) => {
      if (!recordChanges.allowed) throw new Error(recordChanges.reason ?? "");
      await factoryApiRequest("DELETE", `/api/factory/waste/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: companyQueryKey("/api/factory/waste", selectedCompany?.id, from, to) });
      setPendingDeleteId(null);
    },
  });

  function resetForm() {
    setFormDate(new Date().toLocaleDateString("en-CA"));
    setFormKg("");
    setFormWasteType("");
    setFormReason("");
    setFormMixBatchId("");
    setFormSupplierId("");
    setFormContainerId("");
  }
  return {
    formatDisplayDate,
    recordChanges,
    canAddWaste,
    from,
    setFrom,
    to,
    setTo,
    dialogOpen,
    setDialogOpen,
    setPendingDeleteId,
    pendingDeleteId,
    formDate,
    setFormDate,
    formKg,
    setFormKg,
    formWasteType,
    setFormWasteType,
    formReason,
    setFormReason,
    formMixBatchId,
    setFormMixBatchId,
    formSupplierId,
    setFormSupplierId,
    formContainerId,
    setFormContainerId,
    wasteQuery,
    createMutation,
    deleteMutation,
  };
}
