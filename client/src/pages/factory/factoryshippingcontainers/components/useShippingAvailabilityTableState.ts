// Extracted from ./ShippingAvailabilityTable.tsx
import type { ClientErrorLike } from "@/lib/clientError";
import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useExistingRecordChangeAccess } from "@/hooks/useExistingRecordChangeAccess";
import type { AvailRow, EditingAvail } from "../types";
import { AVAIL_KEY } from "../utils";

export function useShippingAvailabilityTableState() {
  const { toast } = useToast();
  const recordChanges = useExistingRecordChangeAccess();
  const canAddRow = recordChanges.canCreate("POST", AVAIL_KEY);
  const [editing, setEditing] = useState<EditingAvail | null>(null);
  const [adding, setAdding] = useState(false);
  const [expanded, setExpanded] = useState(true);
  const [archivedExpanded, setArchivedExpanded] = useState(false);
  const [newRow, setNewRow] = useState({
    date: "",
    shippingCompany: "",
    availableContainers: "",
    note: "",
    details: "",
  });

  const { data: rows = [], isLoading } = useQuery<AvailRow[]>({
    queryKey: [AVAIL_KEY],
    refetchInterval: 5000,
    refetchOnWindowFocus: true,
  });

  const activeRows = rows.filter((row) => !row.isArchived);
  const archivedRows = rows
    .filter((row) => row.isArchived)
    .sort((a, b) => {
      const aTime = a.archivedAt ? new Date(a.archivedAt).getTime() : 0;
      const bTime = b.archivedAt ? new Date(b.archivedAt).getTime() : 0;
      return bTime - aTime;
    });

  const addMutation = useMutation({
    mutationFn: () =>
      apiRequest("POST", AVAIL_KEY, {
        date: newRow.date,
        shippingCompany: newRow.shippingCompany.trim(),
        availableContainers: parseInt(newRow.availableContainers) || 0,
        note: newRow.note.trim() || null,
        details: newRow.details.trim() || null,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [AVAIL_KEY] });
      setNewRow({ date: "", shippingCompany: "", availableContainers: "", note: "", details: "" });
      setAdding(false);
      toast({ title: "Row added" });
    },
    onError: (e: ClientErrorLike) => toast({ title: "Failed to add", description: e.message, variant: "destructive" }),
  });

  const saveMutation = useMutation({
    mutationFn: (row: EditingAvail) =>
      apiRequest("PATCH", `${AVAIL_KEY}/${row.id}`, {
        date: row.date,
        shippingCompany: row.shippingCompany.trim(),
        availableContainers: parseInt(row.availableContainers) || 0,
        note: row.note.trim() || null,
        details: row.details.trim() || null,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [AVAIL_KEY] });
      setEditing(null);
      toast({ title: "Row saved" });
    },
    onError: (e: ClientErrorLike) => toast({ title: "Failed to save", description: e.message, variant: "destructive" }),
  });

  const archiveMutation = useMutation({
    mutationFn: ({ id, archived }: { id: number; archived: boolean }) =>
      apiRequest("PATCH", `${AVAIL_KEY}/${id}`, { isArchived: archived }),
    onSuccess: (_response, variables) => {
      queryClient.invalidateQueries({ queryKey: [AVAIL_KEY] });
      if (variables.archived) {
        setEditing(null);
        toast({ title: "Availability row archived" });
      } else {
        toast({ title: "Availability row restored" });
      }
    },
    onError: (e: ClientErrorLike) =>
      toast({ title: "Failed to update archive", description: e.message, variant: "destructive" }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `${AVAIL_KEY}/${id}`, undefined),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [AVAIL_KEY] });
      toast({ title: "Row deleted" });
    },
    onError: (e: ClientErrorLike) =>
      toast({ title: "Failed to delete", description: e.message, variant: "destructive" }),
  });

  function startEdit(row: AvailRow) {
    setEditing({
      id: row.id,
      date: row.date,
      shippingCompany: row.shippingCompany,
      availableContainers: String(row.availableContainers),
      note: row.note || "",
      details: row.details || "",
    });
  }

  function handleAddKey(e: React.KeyboardEvent) {
    if (e.key === "Enter") addMutation.mutate();
    if (e.key === "Escape") {
      setAdding(false);
      setNewRow({ date: "", shippingCompany: "", availableContainers: "", note: "", details: "" });
    }
  }

  function handleEditKey(e: React.KeyboardEvent) {
    if (e.key === "Enter" && editing) saveMutation.mutate(editing);
    if (e.key === "Escape") setEditing(null);
  }
  return {
    recordChanges,
    canAddRow,
    editing,
    setEditing,
    setAdding,
    adding,
    expanded,
    setExpanded,
    setArchivedExpanded,
    archivedExpanded,
    newRow,
    setNewRow,
    isLoading,
    activeRows,
    archivedRows,
    addMutation,
    saveMutation,
    archiveMutation,
    deleteMutation,
    startEdit,
    handleAddKey,
    handleEditKey,
  };
}
