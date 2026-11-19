// Extracted from ./OrphanedRecords.tsx: state, queries and handlers for OrphanedRecordsPage.
import type { ClientErrorLike } from "@/lib/clientError";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useToast } from "@/hooks/use-toast";
import { useAppMode } from "@/contexts/AppModeContext";
import { getApiRequest } from "@/lib/factoryApi";
import { useDateFormat } from "@/contexts/DateFormatContext";
import { useCurrencyContext } from "@/contexts/CurrencyContext";
import type { OrphanedRecordsResponse, StockGroupArchive } from "./orphanedRecordsTypes";

export function useOrphanedRecordsPageModel() {
  const appMode = useAppMode();
  const modeApiRequest = getApiRequest(appMode);
  const { formatDisplayDate } = useDateFormat();
  const { formatAmount } = useCurrencyContext();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [selectedVouchers, setSelectedVouchers] = useState<number[]>([]);
  const [selectedLocation, setSelectedLocation] = useState<string>("");

  const {
    data: recordsData,
    isLoading,
    isError,
    refetch,
  } = useQuery<OrphanedRecordsResponse>({
    queryKey: ["/api/orphaned-records"],
  });

  const orphanedRecords = recordsData?.orphanedVouchers || [];
  const unbalancedRecords = recordsData?.unbalancedVouchers || [];

  const { data: locations = [] } = useQuery<{ id: number; name: string }[]>({
    queryKey: ["/api/locations"],
  });

  const {
    data: stockGroupArchives = [],
    isLoading: archivesLoading,
    isError: archivesError,
    refetch: refetchArchives,
  } = useQuery<StockGroupArchive[]>({
    queryKey: ["/api/stock-group-archives"],
  });

  const restoreArchiveMutation = useMutation({
    mutationFn: async (archiveId: number) => {
      return modeApiRequest("POST", `/api/stock-group-archives/${archiveId}/restore`);
    },
    onSuccess: () => {
      toast({ title: "Restored", description: "Stock group inventory restored successfully" });
      queryClient.invalidateQueries({ queryKey: ["/api/stock-group-archives"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stock-items"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stock-items/light"] });
    },
    onError: (error: ClientErrorLike) => {
      if ((error as { _handledGlobally?: boolean })?._handledGlobally) return;
      toast({ title: "Restore failed", description: error.message, variant: "destructive" });
    },
  });

  const deleteArchiveMutation = useMutation({
    mutationFn: async ({ archiveId, permanent }: { archiveId: number; permanent: boolean }) => {
      return modeApiRequest("DELETE", `/api/stock-group-archives/${archiveId}?permanent=${permanent}`);
    },
    onSuccess: () => {
      toast({ title: "Deleted", description: "Archive deleted successfully" });
      queryClient.invalidateQueries({ queryKey: ["/api/stock-group-archives"] });
    },
    onError: (error: ClientErrorLike) => {
      if ((error as { _handledGlobally?: boolean })?._handledGlobally) return;
      toast({ title: "Delete failed", description: error.message, variant: "destructive" });
    },
  });

  const reassignMutation = useMutation({
    mutationFn: async (data: { voucherIds: number[]; newLocationId: number }) => {
      return modeApiRequest("POST", "/api/orphaned-records/reassign", data);
    },
    onSuccess: async (res) => {
      const data = (await res.json()) as { updated: number; newLocationName: string };
      toast({
        title: "Updated",
        description: `${data.updated} records reassigned to ${data.newLocationName}`,
      });
      queryClient.invalidateQueries({ queryKey: ["/api/orphaned-records"] });
      queryClient.invalidateQueries({
        predicate: (query) => {
          const key = query.queryKey[0];
          return (
            typeof key === "string" &&
            (key.startsWith("/api/sales-report") || key.startsWith("/api/dashboard/sales-report"))
          );
        },
        refetchType: "active",
      });
      setSelectedVouchers([]);
      setSelectedLocation("");
    },
    onError: (error: ClientErrorLike) => {
      if ((error as { _handledGlobally?: boolean })?._handledGlobally) return;
      toast({ title: "Reassign failed", description: error.message, variant: "destructive" });
    },
  });

  const deleteAllMutation = useMutation({
    mutationFn: async () => {
      const res = await modeApiRequest("DELETE", "/api/orphaned-records/delete-all");
      return res.json();
    },
    onSuccess: (data) => {
      toast({
        title: "Deleted",
        description: `${data.deleted} orphaned vouchers permanently deleted`,
      });
      queryClient.invalidateQueries({ queryKey: ["/api/orphaned-records"] });
      queryClient.invalidateQueries({
        predicate: (query) => {
          const key = query.queryKey[0];
          return (
            typeof key === "string" &&
            (key.startsWith("/api/sales-report") || key.startsWith("/api/dashboard/sales-report"))
          );
        },
        refetchType: "active",
      });
      setSelectedVouchers([]);
    },
    onError: (error: ClientErrorLike) => {
      if ((error as { _handledGlobally?: boolean })?._handledGlobally) return;
      toast({ title: "Delete failed", description: error.message, variant: "destructive" });
    },
  });

  const handleSelectAll = () => {
    if (selectedVouchers.length === orphanedRecords.length) {
      setSelectedVouchers([]);
    } else {
      setSelectedVouchers(orphanedRecords.map((v) => v.id));
    }
  };

  const handleToggleVoucher = (id: number) => {
    setSelectedVouchers((prev) => (prev.includes(id) ? prev.filter((v) => v !== id) : [...prev, id]));
  };

  const handleReassign = () => {
    if (selectedVouchers.length === 0) {
      toast({ title: "Missing information", description: "Please select records to reassign", variant: "destructive" });
      return;
    }
    if (!selectedLocation) {
      toast({ title: "Missing information", description: "Please select a location", variant: "destructive" });
      return;
    }
    reassignMutation.mutate({
      voucherIds: selectedVouchers,
      newLocationId: parseInt(selectedLocation),
    });
  };

  return {
    formatDisplayDate,
    formatAmount,
    selectedVouchers,
    selectedLocation,
    setSelectedLocation,
    recordsData,
    isLoading,
    isError,
    refetch,
    orphanedRecords,
    unbalancedRecords,
    locations,
    stockGroupArchives,
    archivesLoading,
    archivesError,
    refetchArchives,
    restoreArchiveMutation,
    deleteArchiveMutation,
    reassignMutation,
    deleteAllMutation,
    handleSelectAll,
    handleToggleVoucher,
    handleReassign,
  };
}

export type OrphanedRecordsPageModel = ReturnType<typeof useOrphanedRecordsPageModel>;
