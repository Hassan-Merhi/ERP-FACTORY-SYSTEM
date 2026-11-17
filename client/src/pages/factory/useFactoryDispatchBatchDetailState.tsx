// Extracted from ./FactoryDispatchBatchDetail.tsx to keep that module under the source-size cap.
import { visibleTabInterval } from "@/lib/queryPolicies";
import type { ClientErrorLike } from "@/lib/clientError";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useCompany } from "@/contexts/CompanyContext";
import { companyQueryKey } from "@/lib/companyQueryScope";
import { useState } from "react";
import { useLocation, useRoute } from "wouter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { useExistingRecordChangeAccess } from "@/hooks/useExistingRecordChangeAccess";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useDateFormat } from "@/contexts/DateFormatContext";
import type { AuditScan, BatchDetail, InvoicePreview } from "./factorydispatchbatchdetail/types";
import { fmt } from "./factorydispatchbatchdetail/utils";

export function useFactoryDispatchBatchDetailState() {
  const { selectedCompany } = useCompany();
  const [, navigate] = useLocation();
  const [, params] = useRoute("/factory/dispatch-batches/:id");
  const batchId = params?.id ? parseInt(params.id) : null;
  const { toast } = useToast();
  const { formatDisplayDate } = useDateFormat();

  const [addRideOpen, setAddRideOpen] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [generateOpen, setGenerateOpen] = useState(false);
  const [reopenRideId, setReopenRideId] = useState<number | null>(null);
  const [reopenReason, setReopenReason] = useState("");
  const { data: me } = useQuery<{ role: string }>({ queryKey: ["/api/auth/me"] });
  const isDeveloper = me?.role === "Developer";
  const recordChanges = useExistingRecordChangeAccess();

  const [showBales, setShowBales] = useState(false);
  const [invoiceDate, setInvoiceDate] = useState(new Date().toISOString().split("T")[0]);

  const [rideForm, setRideForm] = useState({
    truckPlate: "",
    driverName: "",
    destination: "",
    notes: "",
  });

  const { data, isLoading, isError, error, refetch } = useQuery<BatchDetail>({
    queryKey: companyQueryKey(`/api/factory/dispatch-batches/${batchId}`, selectedCompany?.id),
    queryFn: async () => {
      const res = await fetch(`/api/factory/dispatch-batches/${batchId}`, { credentials: "include" });
      if (!res.ok) throw new Error((await res.json()).message);
      return res.json();
    },
    enabled: Boolean(selectedCompany?.id) && !!batchId,
    refetchInterval: visibleTabInterval(15_000),
  });

  const { data: preview, isLoading: previewLoading } = useQuery<InvoicePreview>({
    queryKey: companyQueryKey(`/api/factory/dispatch-batches/${batchId}/invoice-preview`, selectedCompany?.id),
    queryFn: async () => {
      const res = await fetch(`/api/factory/dispatch-batches/${batchId}/invoice-preview`, { credentials: "include" });
      if (!res.ok) throw new Error((await res.json()).message);
      return res.json();
    },
    enabled: Boolean(selectedCompany?.id) && !!batchId && previewOpen,
    staleTime: 15000,
  });

  const { data: auditScans = [] } = useQuery<AuditScan[]>({
    queryKey: companyQueryKey(`/api/factory/dispatch-batches/${batchId}/audit`, selectedCompany?.id),
    queryFn: async () => {
      const res = await fetch(`/api/factory/dispatch-batches/${batchId}/audit`, { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
    enabled: Boolean(selectedCompany?.id) && !!batchId && showBales,
  });

  const addRideMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/factory/dispatch-batches/${batchId}/truck-rides`, {
        truckPlate: rideForm.truckPlate || undefined,
        driverName: rideForm.driverName || undefined,
        destination: rideForm.destination || undefined,
        notes: rideForm.notes || undefined,
      });
      if (!res.ok) throw new Error((await res.json()).message);
      return res.json();
    },
    onSuccess: (d) => {
      queryClient.invalidateQueries({ queryKey: [`/api/factory/dispatch-batches/${batchId}`] });
      toast({ title: "Truck ride added", description: `Ride #${d.rideNumber} added.` });
      setAddRideOpen(false);
      setRideForm({ truckPlate: "", driverName: "", destination: "", notes: "" });
      if (d.id) navigate(`/factory/dispatch-batches/${batchId}/rides/${d.id}/scan`);
    },
    onError: (err: ClientErrorLike) =>
      toast({ title: "Save failed", description: err.message, variant: "destructive" }),
  });

  const cancelMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("DELETE", `/api/factory/dispatch-batches/${batchId}`, {});
      if (!res.ok) throw new Error((await res.json()).message);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/dispatch-batches"] });
      queryClient.invalidateQueries({ queryKey: [`/api/factory/dispatch-batches/${batchId}`] });
      toast({ title: "Batch cancelled", description: "All bales have been returned to stock." });
      setCancelOpen(false);
    },
    onError: (err: ClientErrorLike) =>
      toast({ title: "Cancel failed", description: err.message, variant: "destructive" }),
  });

  const generateMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/factory/dispatch-batches/${batchId}/generate-invoice`, {
        invoiceDate,
      });
      if (!res.ok) throw new Error((await res.json()).message);
      return res.json();
    },
    onSuccess: (d) => {
      queryClient.invalidateQueries({ queryKey: [`/api/factory/dispatch-batches/${batchId}`] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/dispatch-batches"] });
      toast({
        title: "Invoice generated!",
        description: `Invoice ${d.invoiceNumber} — ${d.totalBales} bales — ${data?.batch.currency} ${fmt(d.grandTotal)}`,
      });
      setGenerateOpen(false);
      setPreviewOpen(false);
      refetch();
    },
    onError: (err: ClientErrorLike) =>
      toast({ title: "Generation failed", description: err.message, variant: "destructive" }),
  });

  const reopenRideMutation = useMutation({
    mutationFn: async ({ rideId, reason }: { rideId: number; reason: string }) => {
      const res = await apiRequest("POST", `/api/factory/dispatch-truck-rides/${rideId}/reopen`, { reason });
      if (!res.ok) throw new Error((await res.json()).message);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/factory/dispatch-batches/${batchId}`] });
      toast({ title: "Ride reopened", description: "The truck ride is now back to LOADING status." });
      setReopenRideId(null);
      setReopenReason("");
    },
    onError: (err: ClientErrorLike) =>
      toast({ title: "Update failed", description: err.message, variant: "destructive" }),
  });
  return {
    addRideMutation,
    addRideOpen,
    auditScans,
    batchId,
    cancelMutation,
    cancelOpen,
    data,
    error,
    formatDisplayDate,
    generateMutation,
    generateOpen,
    invoiceDate,
    isDeveloper,
    isError,
    isLoading,
    me,
    navigate,
    preview,
    previewLoading,
    previewOpen,
    recordChanges,
    reopenReason,
    reopenRideId,
    reopenRideMutation,
    rideForm,
    setAddRideOpen,
    setCancelOpen,
    setGenerateOpen,
    setInvoiceDate,
    setPreviewOpen,
    setReopenReason,
    setReopenRideId,
    setRideForm,
    setShowBales,
    showBales,
  };
}

export function FactoryDispatchBatchDetailSection({
  auditScans,
}: Pick<ReturnType<typeof useFactoryDispatchBatchDetailState>, "auditScans">) {
  return (
    <div className="mt-3 border-t pt-3">
      {auditScans.length === 0 ? (
        <p className="text-sm text-muted-foreground py-4 text-center">No active bale scans found.</p>
      ) : (
        <div className="overflow-x-auto">
          <Table mobileLayout="cards">
            <TableHeader>
              <TableRow>
                <TableHead className="text-xs">Ride #</TableHead>
                <TableHead className="text-xs">Reference</TableHead>
                <TableHead className="text-xs">Article</TableHead>
                <TableHead className="text-xs">Product</TableHead>
                <TableHead className="text-xs text-right">Weight (kg)</TableHead>
                <TableHead className="text-xs text-right">Amount</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {auditScans
                .filter((s) => !s.removedAt)
                .map((s) => (
                  <TableRow key={s.id} data-testid={`row-scan-${s.id}`}>
                    <TableCell className="text-xs font-mono">#{s.rideNumber}</TableCell>
                    <TableCell className="text-xs font-mono font-medium">{s.baleReference}</TableCell>
                    <TableCell className="text-xs">{s.articleCode || "—"}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{s.productName || "—"}</TableCell>
                    <TableCell className="text-xs text-right font-mono">{fmt(s.weightKg, 3)}</TableCell>
                    <TableCell className="text-xs text-right font-mono">{fmt(s.amount)}</TableCell>
                  </TableRow>
                ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

export function FactoryDispatchBatchDetailDialogSection({
  addRideMutation,
  addRideOpen,
  rideForm,
  setAddRideOpen,
  setRideForm,
}: Pick<
  ReturnType<typeof useFactoryDispatchBatchDetailState>,
  "addRideMutation" | "addRideOpen" | "rideForm" | "setAddRideOpen" | "setRideForm"
>) {
  return (
    <Dialog open={addRideOpen} onOpenChange={setAddRideOpen}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add Truck Ride</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>Truck Plate</Label>
            <Input
              placeholder="e.g. LEB-1234"
              value={rideForm.truckPlate}
              onChange={(e) => setRideForm((f) => ({ ...f, truckPlate: e.target.value }))}
              data-testid="input-truck-plate"
            />
          </div>
          <div className="space-y-1.5">
            <Label>Driver Name</Label>
            <Input
              placeholder="Driver name"
              value={rideForm.driverName}
              onChange={(e) => setRideForm((f) => ({ ...f, driverName: e.target.value }))}
              data-testid="input-driver-name"
            />
          </div>
          <div className="space-y-1.5">
            <Label>Destination</Label>
            <Input
              placeholder="Destination"
              value={rideForm.destination}
              onChange={(e) => setRideForm((f) => ({ ...f, destination: e.target.value }))}
              data-testid="input-ride-destination"
            />
          </div>
          <div className="space-y-1.5">
            <Label>Notes</Label>
            <Textarea
              rows={2}
              value={rideForm.notes}
              onChange={(e) => setRideForm((f) => ({ ...f, notes: e.target.value }))}
              data-testid="textarea-ride-notes"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setAddRideOpen(false)}>
            Cancel
          </Button>
          <Button
            onClick={() => addRideMutation.mutate()}
            disabled={addRideMutation.isPending}
            data-testid="button-add-ride-submit"
          >
            {addRideMutation.isPending ? "Adding..." : "Add & Open Scanner"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function FactoryDispatchBatchDetailDialogSection2({
  reopenReason,
  reopenRideId,
  reopenRideMutation,
  setReopenReason,
  setReopenRideId,
}: Pick<
  ReturnType<typeof useFactoryDispatchBatchDetailState>,
  "reopenReason" | "reopenRideId" | "reopenRideMutation" | "setReopenReason" | "setReopenRideId"
>) {
  return (
    <Dialog
      open={!!reopenRideId}
      onOpenChange={(o) => {
        if (!o) {
          setReopenRideId(null);
          setReopenReason("");
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Reopen Truck Ride</DialogTitle>
          <DialogDescription>Admin action. Provide a reason to reopen this dispatched ride.</DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label>
            Reason <span className="text-destructive">*</span>
          </Label>
          <Textarea
            rows={3}
            placeholder="Reason for reopening..."
            value={reopenReason}
            onChange={(e) => setReopenReason(e.target.value)}
            data-testid="textarea-reopen-reason"
          />
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => {
              setReopenRideId(null);
              setReopenReason("");
            }}
          >
            Cancel
          </Button>
          <Button
            onClick={() => reopenRideId && reopenRideMutation.mutate({ rideId: reopenRideId, reason: reopenReason })}
            disabled={!reopenReason.trim() || reopenRideMutation.isPending}
            data-testid="button-confirm-reopen-ride"
          >
            {reopenRideMutation.isPending ? "Reopening..." : "Reopen Ride"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
