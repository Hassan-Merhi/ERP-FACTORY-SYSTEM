// Extracted from ./CostCenters.tsx
import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useCompany } from "@/contexts/CompanyContext";
import { useAppMode } from "@/contexts/AppModeContext";
import { useToast } from "@/hooks/use-toast";
import { queryClient } from "@/lib/queryClient";
import { useLocation } from "wouter";
import type { CostCenter, CostCenterCatalog, CostCenterBalance, CostCenterActivity } from "@/api/costCentersApi";
import { readCostCenterApi, writeCostCenterApi } from "@/api/costCentersApi";
import { emptyForm, detailsFrom, errorMessage, sortCenters, type Form } from "./CostCentersHelpers";

export function useCostCentersState() {
  const { selectedCompany } = useCompany();
  const isFactory = useAppMode() === "factory";
  const baseUrl = isFactory ? "/api/factory/cost-centers" : "/api/cost-centers";
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const companyId = selectedCompany?.id;
  const role = selectedCompany?.role || "";
  const canWrite = ["Admin", "Owner", "Developer"].includes(role);
  const key = [baseUrl, companyId];
  const [includeArchived, setIncludeArchived] = useState(false);
  const [filter, setFilter] = useState("");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [activityOffset, setActivityOffset] = useState(0);
  const [activityFrom, setActivityFrom] = useState("");
  const [activityTo, setActivityTo] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [form, setForm] = useState<Form>(emptyForm);
  const { data, isLoading, isError, error, refetch } = useQuery<CostCenterCatalog>({
    queryKey: [...key, includeArchived],
    queryFn: () => readCostCenterApi<CostCenterCatalog>(baseUrl + (includeArchived ? "?includeArchived=true" : "")),
    enabled: !!companyId,
    staleTime: 30000,
  });
  const centers = useMemo(() => data?.costCenters ?? [], [data]);
  const rows = useMemo(
    () =>
      sortCenters(centers).filter(({ center }) =>
        [center.name, center.code, center.description || ""].some((s) => s.toLowerCase().includes(filter.toLowerCase()))
      ),
    [centers, filter]
  );
  const selected = centers.find((c) => c.id === selectedId) || null;
  const { data: balance, isLoading: loadingBalance } = useQuery<CostCenterBalance>({
    queryKey: [baseUrl, companyId, selectedId, "balance"],
    queryFn: () => readCostCenterApi<CostCenterBalance>(baseUrl + "/" + selectedId + "/balance"),
    enabled: !!companyId && !!selectedId,
  });
  const { data: activity, isLoading: loadingActivity } = useQuery<CostCenterActivity>({
    queryKey: [baseUrl, companyId, selectedId, "activity", activityOffset, activityFrom, activityTo],
    queryFn: () =>
      readCostCenterApi<CostCenterActivity>(
        baseUrl +
          "/" +
          selectedId +
          "/activity?limit=50&offset=" +
          activityOffset +
          (activityFrom ? "&fromDate=" + activityFrom : "") +
          (activityTo ? "&toDate=" + activityTo : "")
      ),
    enabled: !!companyId && !!selectedId,
  });
  const invalidate = async () => {
    await queryClient.invalidateQueries({ queryKey: [baseUrl, companyId] });
  };
  const save = useMutation({
    mutationFn: () => {
      const body = {
        code: form.code.trim(),
        name: form.name.trim(),
        description: form.description.trim() || null,
        parentId: form.parentId === "root" ? null : Number(form.parentId),
      };
      return editingId == null
        ? writeCostCenterApi("POST", baseUrl, body)
        : writeCostCenterApi("PATCH", baseUrl + "/" + editingId, body);
    },
    onSuccess: async () => {
      setDialogOpen(false);
      await invalidate();
      toast({ title: editingId == null ? "Cost center created" : "Cost center updated" });
    },
    onError: (e: unknown) =>
      toast({ title: "Could not save cost center", description: errorMessage(e), variant: "destructive" }),
  });
  const archive = useMutation({
    mutationFn: (id: number) => writeCostCenterApi("POST", baseUrl + "/" + id + "/archive", {}),
    onSuccess: async () => {
      await invalidate();
      setSelectedId(null);
      toast({ title: "Cost center archived", description: "Historical allocations are preserved." });
    },
    onError: (e: unknown) =>
      toast({ title: "Could not archive cost center", description: errorMessage(e), variant: "destructive" }),
  });
  function edit(center?: CostCenter) {
    setEditingId(center?.id || null);
    setForm(center ? detailsFrom(center) : emptyForm);
    setDialogOpen(true);
  }
  return {
    isFactory,
    baseUrl,
    navigate,
    canWrite,
    setIncludeArchived,
    includeArchived,
    filter,
    setFilter,
    selectedId,
    setSelectedId,
    editingId,
    setActivityOffset,
    activityOffset,
    activityFrom,
    setActivityFrom,
    activityTo,
    setActivityTo,
    dialogOpen,
    setDialogOpen,
    form,
    setForm,
    refetch,
    isError,
    error,
    isLoading,
    centers,
    rows,
    selected,
    balance,
    loadingBalance,
    loadingActivity,
    activity,
    save,
    archive,
    edit,
  };
}
