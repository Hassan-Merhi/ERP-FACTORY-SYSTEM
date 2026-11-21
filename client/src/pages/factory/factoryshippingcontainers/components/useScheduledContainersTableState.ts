// Extracted from ./ScheduledContainersTable.tsx
import type { ClientErrorLike } from "@/lib/clientError";
import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useExistingRecordChangeAccess } from "@/hooks/useExistingRecordChangeAccess";
import { SCHEDULED_KEY, type ScheduledRow, type EditingScheduled } from "./ScheduledContainersTableModel";

export function useScheduledContainersTableState() {
  const { toast } = useToast();
  const recordChanges = useExistingRecordChangeAccess();
  const canAddRow = recordChanges.canCreate("POST", SCHEDULED_KEY);
  const [editing, setEditing] = useState<EditingScheduled | null>(null);
  const [adding, setAdding] = useState(false);
  const [expanded, setExpanded] = useState(true);
  const [newRow, setNewRow] = useState({
    date: "",
    shippingCompany: "",
    scheduledContainers: "",
    note: "",
    details: "",
  });

  const {
    data: rows = [],
    isLoading,
    isError,
    refetch,
  } = useQuery<ScheduledRow[]>({
    queryKey: [SCHEDULED_KEY],
    // This is an editable schedule, not a live status feed. Background polling
    // used to refetch every five seconds while someone was typing into a row.
    // Successful add/edit/delete actions already invalidate this key.
    staleTime: 5 * 60 * 1000,
    refetchInterval: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: false,
  });

  const activeRows = rows.filter((row) => !row.isArchived);
  const addMutation = useMutation({
    mutationFn: () =>
      apiRequest("POST", SCHEDULED_KEY, {
        date: newRow.date,
        shippingCompany: newRow.shippingCompany.trim(),
        scheduledContainers: parseInt(newRow.scheduledContainers) || 0,
        note: newRow.note.trim() || null,
        details: newRow.details.trim() || null,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [SCHEDULED_KEY] });
      setNewRow({ date: "", shippingCompany: "", scheduledContainers: "", note: "", details: "" });
      setAdding(false);
      toast({ title: "Row added" });
    },
    onError: (e: ClientErrorLike) => toast({ title: "Failed to add", description: e.message, variant: "destructive" }),
  });

  const saveMutation = useMutation({
    mutationFn: (row: EditingScheduled) =>
      apiRequest("PATCH", `${SCHEDULED_KEY}/${row.id}`, {
        date: row.date,
        shippingCompany: row.shippingCompany.trim(),
        scheduledContainers: parseInt(row.scheduledContainers) || 0,
        note: row.note.trim() || null,
        details: row.details.trim() || null,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [SCHEDULED_KEY] });
      setEditing(null);
      toast({ title: "Row saved" });
    },
    onError: (e: ClientErrorLike) => toast({ title: "Failed to save", description: e.message, variant: "destructive" }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `${SCHEDULED_KEY}/${id}`, undefined),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [SCHEDULED_KEY] });
      toast({ title: "Row deleted" });
    },
    onError: (e: ClientErrorLike) =>
      toast({ title: "Failed to delete", description: e.message, variant: "destructive" }),
  });

  function startEdit(row: ScheduledRow) {
    setEditing({
      id: row.id,
      date: row.date,
      shippingCompany: row.shippingCompany,
      scheduledContainers: String(row.scheduledContainers),
      note: row.note || "",
      details: row.details || "",
    });
  }

  function handleAddKey(e: React.KeyboardEvent) {
    if (e.key === "Enter") addMutation.mutate();
    if (e.key === "Escape") {
      setAdding(false);
      setNewRow({ date: "", shippingCompany: "", scheduledContainers: "", note: "", details: "" });
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
    newRow,
    setNewRow,
    isLoading,
    isError,
    refetch,
    activeRows,
    addMutation,
    saveMutation,
    deleteMutation,
    startEdit,
    handleAddKey,
    handleEditKey,
  };
}
