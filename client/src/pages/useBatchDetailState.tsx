// Extracted from ./BatchDetail.tsx to keep that module under the source-size cap.
import type { ClientErrorLike } from "@/lib/clientError";
import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Scale } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatNumber } from "@/lib/formatNumber";
import { useDateFormat } from "@/contexts/DateFormatContext";
import { useAppMode } from "@/contexts/AppModeContext";
import { getApiRequest } from "@/lib/factoryApi";
import { useToast } from "@/hooks/use-toast";
import { queryClient } from "@/lib/queryClient";
import type { FactoryMixBatch, FactoryMixBatchSource } from "@shared/schema";
import { formatUsd } from "@/lib/moneyDisplay";

interface BatchBaleRow {
  bale: {
    id: number;
    baleCode?: string;
    weightKg?: string;
    costPerKg?: string;
    category?: string;
    status: string;
    warehouseLocation?: string;
    createdAt?: string;
  };
  product?: { name?: string; articleCode?: string };
  location?: { name?: string };
}

export interface BatchDetailProps {
  batchId: number;
  onBack: () => void;
  onDeleted?: () => void;
}

export const costPerKgText = (value: number | string) => formatUsd(value, 4);

export function useBatchDetailState({ batchId, onBack, onDeleted }: BatchDetailProps) {
  const { formatDisplayDate } = useDateFormat();
  const { toast } = useToast();
  const appMode = useAppMode();
  const modeApiRequest = getApiRequest(appMode);

  const [editOpen, setEditOpen] = useState(false);
  const [editName, setEditName] = useState("");
  const [editNotes, setEditNotes] = useState("");
  const [deleteOpen, setDeleteOpen] = useState(false);

  const { data: batch, isLoading: batchLoading } = useQuery<FactoryMixBatch>({
    queryKey: ["/api/factory/mix-batches", batchId],
  });

  const { data: balesData, isLoading: balesLoading } = useQuery<BatchBaleRow[]>({
    queryKey: ["/api/factory/bales", { mixBatchId: batchId }],
    queryFn: async () => {
      const res = await fetch(`/api/factory/bales?mixBatchId=${batchId}`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to fetch bales");
      return res.json();
    },
  });

  const { data: sources, isLoading: sourcesLoading } = useQuery<FactoryMixBatchSource[]>({
    queryKey: ["/api/factory/mix-batches", batchId, "sources"],
    queryFn: async () => {
      const res = await fetch(`/api/factory/mix-batches/${batchId}/sources`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to fetch sources");
      return res.json();
    },
  });

  const editMutation = useMutation({
    mutationFn: async () => {
      const res = await modeApiRequest("PATCH", `/api/factory/mix-batches/${batchId}`, {
        name: editName,
        notes: editNotes,
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message || "Update failed");
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/mix-batches"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/mix-batches", batchId] });
      setEditOpen(false);
      toast({ title: "Saved", description: "Batch updated successfully" });
    },
    onError: (err: ClientErrorLike) => {
      toast({ title: "Update failed", description: err.message, variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async () => {
      const res = await modeApiRequest("DELETE", `/api/factory/mix-batches/${batchId}`);
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message || "Delete failed");
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/mix-batches"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/bales/unlinked"] });
      toast({ title: "Deleted", description: "Batch deleted. Bales have been unlinked and are preserved." });
      setDeleteOpen(false);
      (onDeleted || onBack)();
    },
    onError: (err: ClientErrorLike) => {
      toast({ title: "Delete failed", description: err.message, variant: "destructive" });
    },
  });

  const isLoading = batchLoading || balesLoading || sourcesLoading;
  return {
    balesData,
    batch,
    deleteMutation,
    deleteOpen,
    editMutation,
    editName,
    editNotes,
    editOpen,
    formatDisplayDate,
    isLoading,
    onBack,
    setDeleteOpen,
    setEditName,
    setEditNotes,
    setEditOpen,
    sources,
  };
}

export function BatchDetailCardSources({ sources }: Pick<ReturnType<typeof useBatchDetailState>, "sources">) {
  return (
    <Card data-testid="card-sources">
      <CardHeader>
        <div className="flex items-center gap-3 flex-wrap">
          <Scale className="h-5 w-5 text-muted-foreground" />
          <CardTitle>Sources</CardTitle>
        </div>
      </CardHeader>
      <CardContent>
        {(sources || []).length === 0 ? (
          <div className="text-center py-8 text-muted-foreground">
            <Scale className="h-10 w-10 mx-auto mb-2 opacity-30" />
            <p className="text-sm">No sources recorded</p>
          </div>
        ) : (
          <div className="border rounded-md overflow-auto">
            <Table>
              <TableHeader className="sticky top-0 z-30 bg-background">
                <TableRow>
                  <TableHead>Source</TableHead>
                  <TableHead className="text-right">Weight (kg)</TableHead>
                  <TableHead className="text-right">Cost/kg</TableHead>
                  <TableHead className="text-right">Total Cost</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(sources || []).map((source) => (
                  <TableRow key={source.id} data-testid={`row-source-${source.id}`}>
                    <TableCell className="font-medium">
                      {source.containerId
                        ? `Container #${source.containerId}`
                        : source.sourceBatchId
                          ? `Batch #${source.sourceBatchId}`
                          : "-"}
                    </TableCell>
                    <TableCell className="text-right font-mono">{formatNumber(parseFloat(source.weightKg))}</TableCell>
                    <TableCell className="text-right font-mono text-muted-foreground">
                      {costPerKgText(parseFloat(source.costPerKg))}
                    </TableCell>
                    <TableCell className="text-right font-mono">
                      ${formatNumber(parseFloat(source.totalCost), 2)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
