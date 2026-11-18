// Extracted from ./ContainerDetailPage.tsx to keep that module under the source-size cap.
import { useState } from "react";
import { useParams } from "wouter";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@/lib/form-resolver";
import { z } from "zod";
import { queryClient } from "@/lib/queryClient";
import { useDateFormat } from "@/contexts/DateFormatContext";
import { useToast } from "@/hooks/use-toast";
import { useExistingRecordChangeAccess } from "@/hooks/useExistingRecordChangeAccess";
import type { SpContainerDetailResponse } from "./containers/types";

import { formatUsd } from "@/lib/moneyDisplay";
export function fmt2(v: number | string | null | undefined) {
  const n = parseFloat(String(v ?? "0"));
  return isNaN(n) ? "$0.00" : formatUsd(n, 2);
}

export function fmt4(v: number | string | null | undefined) {
  const n = parseFloat(String(v ?? "0"));
  return isNaN(n) ? "$0.0000" : formatUsd(n, 4);
}

const editSchema = z.object({
  supplierId: z.number().optional(),
  supplierName: z.string().min(1, "Required"),
  containerNumber: z.string().optional(),
  invoiceNumber: z.string().min(1, "Required"),
  invoiceDate: z.string().min(1, "Required"),
  invoiceTotalUsd: z.string().min(1, "Required"),
  discountPct: z.string().optional(),
  freightEstimateUsd: z.string().optional(),
  notes: z.string().optional(),
});

type EditForm = z.infer<typeof editSchema>;

export function useSpContainerDetailViewState() {
  const { id } = useParams<{ id: string }>();
  const [showOffloadDialog, setShowOffloadDialog] = useState(false);
  const [showEditDialog, setShowEditDialog] = useState(false);
  const { toast } = useToast();
  const recordChanges = useExistingRecordChangeAccess();
  const { formatDisplayDate } = useDateFormat();

  const { data: spc, isLoading } = useQuery<SpContainerDetailResponse>({
    queryKey: [`/api/sp/containers/${id}`],
    queryFn: () => fetch(`/api/sp/containers/${id}`, { credentials: "include" }).then((r) => r.json()),
    enabled: !!id,
  });

  const { data: suppliers = [] } = useQuery<{ id: number; legalName: string; code: string }[]>({
    queryKey: ["/api/suppliers"],
  });

  const editForm = useForm<EditForm>({
    resolver: zodResolver(editSchema),
    defaultValues: {
      supplierId: undefined,
      supplierName: "",
      containerNumber: "",
      invoiceNumber: "",
      invoiceDate: "",
      invoiceTotalUsd: "",
      discountPct: "0",
      freightEstimateUsd: "0",
      notes: "",
    },
  });

  const editMutation = useMutation({
    mutationFn: async (data: EditForm) => {
      if (!recordChanges.allowed) throw new Error(recordChanges.reason ?? "");
      const res = await fetch(`/api/sp/containers/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(data),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message || "Failed to update container");
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/sp/containers/${id}`] });
      queryClient.invalidateQueries({ queryKey: ["/api/sp/containers"] });
      toast({ title: "Container updated", description: "Accounting voucher has been regenerated." });
      setShowEditDialog(false);
    },
    onError: (err: Error) => {
      toast({ title: "Update failed", description: err.message, variant: "destructive" });
    },
  });

  const openEdit = () => {
    if (!spc || "message" in spc) return;
    editForm.reset({
      supplierId: spc.supplierId ?? undefined,
      supplierName: spc.supplierName ?? "",
      containerNumber: spc.containerNumber ?? "",
      invoiceNumber: spc.invoiceNumber ?? "",
      invoiceDate: spc.invoiceDate ?? "",
      invoiceTotalUsd: spc.invoiceTotalUsd ?? "",
      discountPct: spc.discountPct ?? "0",
      freightEstimateUsd: spc.freightEstimateUsd ?? "0",
      notes: spc.notes ?? "",
    });
    setShowEditDialog(true);
  };
  return {
    editForm,
    editMutation,
    formatDisplayDate,
    id,
    isLoading,
    openEdit,
    recordChanges,
    setShowEditDialog,
    setShowOffloadDialog,
    showEditDialog,
    showOffloadDialog,
    spc,
    suppliers,
    toast,
  };
}
