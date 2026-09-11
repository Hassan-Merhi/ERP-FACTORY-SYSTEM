import { useState, useEffect } from "react";
import { addDays, format } from "date-fns";
import { useDateFormat } from "@/contexts/DateFormatContext";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
import { factoryApiRequest } from "@/lib/factoryApi";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Loader2, Plus, Trash2, AlertTriangle } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";

interface WasteEntry {
  id: number;
  date: string;
  wasteType: string | null;
  kgWaste: number;
  reason: string | null;
  mixBatchId: number | null;
  supplierId: number | null;
  containerId: number | null;
}

function getDefaultDateRange() {
  const to = new Date();
  const from = new Date();
  from.setDate(from.getDate() - 30);
  return {
    from: from.toLocaleDateString("en-CA"),
    to: to.toLocaleDateString("en-CA"),
  };
}

export default function FactoryWaste() {
  const { formatDisplayDate } = useDateFormat();
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
    queryKey: ["/api/factory/waste", from, to],
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
      queryClient.invalidateQueries({ queryKey: ["/api/factory/waste", from, to] });
      setDialogOpen(false);
      resetForm();
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: number) => {
      await factoryApiRequest("DELETE", `/api/factory/waste/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/waste", from, to] });
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

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const payload: {
      date: string;
      kgWaste: number;
      wasteType?: string;
      reason?: string;
      mixBatchId?: number;
      supplierId?: number;
      containerId?: number;
    } = {
      date: formDate,
      kgWaste: parseFloat(formKg),
    };
    if (formWasteType) payload.wasteType = formWasteType;
    if (formReason.trim()) payload.reason = formReason.trim();
    if (formMixBatchId) payload.mixBatchId = parseInt(formMixBatchId, 10);
    if (formSupplierId) payload.supplierId = parseInt(formSupplierId, 10);
    if (formContainerId) payload.containerId = parseInt(formContainerId, 10);
    createMutation.mutate(payload);
  }

  const totalWasteKg = wasteQuery.data ? wasteQuery.data.reduce((sum, entry) => sum + (entry.kgWaste || 0), 0) : 0;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <PageHeader title="Factory Waste" subtitle="Track and manage waste entries" />
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">From</Label>
            <Input
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              className="w-44"
              data-testid="input-date-from"
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">To</Label>
            <Input
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              className="w-44"
              data-testid="input-date-to"
            />
          </div>
        </div>
      </div>

      <div className="flex items-center justify-between flex-wrap gap-3">
        <Card className="min-w-[200px]">
          <CardHeader className="flex flex-row items-center justify-between gap-1 space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Waste KG</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold font-mono" data-testid="text-total-waste-kg">
              {wasteQuery.isLoading ? "..." : totalWasteKg.toFixed(2)}
            </div>
            <p className="text-xs text-muted-foreground">in selected period</p>
          </CardContent>
        </Card>

        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogTrigger asChild>
            <Button data-testid="button-add-waste">
              <Plus className="mr-2 h-4 w-4" />
              Add Waste Entry
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Add Waste Entry</DialogTitle>
            </DialogHeader>
            <form onSubmit={handleSubmit} className="space-y-4" noValidate>
              <div className="space-y-2">
                <Label htmlFor="waste-date">Date</Label>
                <Input
                  id="waste-date"
                  type="date"
                  value={formDate}
                  onChange={(e) => setFormDate(e.target.value)}
                  data-testid="input-waste-date"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="waste-type">Waste Type</Label>
                <select
                  id="waste-type"
                  value={formWasteType}
                  onChange={(e) => setFormWasteType(e.target.value)}
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  data-testid="select-waste-type"
                >
                  <option value="">— None —</option>
                  <option value="GARBAGE">Garbage</option>
                  <option value="WIPERS">Wipers</option>
                  <option value="OTHER">Other</option>
                </select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="waste-kg">KG Waste *</Label>
                <Input
                  id="waste-kg"
                  type="number"
                  step="0.01"
                  required
                  value={formKg}
                  onChange={(e) => setFormKg(e.target.value)}
                  data-testid="input-waste-kg"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="waste-reason">Reason</Label>
                <Textarea
                  id="waste-reason"
                  value={formReason}
                  onChange={(e) => setFormReason(e.target.value)}
                  data-testid="input-waste-reason"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="waste-mix-batch">Mix Batch ID (optional)</Label>
                <Input
                  id="waste-mix-batch"
                  type="number"
                  value={formMixBatchId}
                  onChange={(e) => setFormMixBatchId(e.target.value)}
                  data-testid="input-waste-mix-batch-id"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="waste-supplier">Supplier ID (optional)</Label>
                <Input
                  id="waste-supplier"
                  type="number"
                  value={formSupplierId}
                  onChange={(e) => setFormSupplierId(e.target.value)}
                  data-testid="input-waste-supplier-id"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="waste-container">Container ID (optional)</Label>
                <Input
                  id="waste-container"
                  type="number"
                  value={formContainerId}
                  onChange={(e) => setFormContainerId(e.target.value)}
                  data-testid="input-waste-container-id"
                />
              </div>
              <Button type="submit" disabled={createMutation.isPending} data-testid="button-submit-waste">
                {createMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Save
              </Button>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Waste Entries</CardTitle>
        </CardHeader>
        <CardContent>
          {wasteQuery.isLoading ? (
            <div className="flex items-center justify-center py-12" data-testid="loading-spinner">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
              <span className="ml-2 text-muted-foreground">Loading waste entries...</span>
            </div>
          ) : !Array.isArray(wasteQuery.data) || wasteQuery.data.length === 0 ? (
            <div className="text-center py-8">
              <p className="text-muted-foreground" data-testid="text-no-data">
                No waste entries for selected range
              </p>
            </div>
          ) : (
            <div className="table-responsive">
              <Table>
                <TableHeader className="sticky top-0 z-30 bg-background">
                  <TableRow>
                    <TableHead>Date</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>KG</TableHead>
                    <TableHead>Reason</TableHead>
                    <TableHead>Mix Batch</TableHead>
                    <TableHead>Supplier</TableHead>
                    <TableHead>Container</TableHead>
                    <TableHead>Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {wasteQuery.data.map((entry, idx) => (
                    <TableRow key={entry.id ?? idx} data-testid={`row-waste-${entry.id}`}>
                      <TableCell className="font-mono text-sm">
                        {entry.date ? formatDisplayDate(entry.date) : "—"}
                      </TableCell>
                      <TableCell className="text-sm">{entry.wasteType || "—"}</TableCell>
                      <TableCell className="font-mono">{entry.kgWaste}</TableCell>
                      <TableCell>{entry.reason || "—"}</TableCell>
                      <TableCell className="font-mono">{entry.mixBatchId ?? "—"}</TableCell>
                      <TableCell className="font-mono">{entry.supplierId ?? "—"}</TableCell>
                      <TableCell className="font-mono">{entry.containerId ?? "—"}</TableCell>
                      <TableCell>
                        <Button
                          size="icon"
                          variant="ghost"
                          onClick={() => setPendingDeleteId(entry.id)}
                          disabled={deleteMutation.isPending}
                          data-testid={`button-delete-waste-${entry.id}`}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Delete Waste Entry Confirmation */}
      <Dialog
        open={pendingDeleteId !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDeleteId(null);
        }}
      >
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-destructive">
              <AlertTriangle className="h-4 w-4" />
              Delete Waste Entry?
            </DialogTitle>
            <DialogDescription>This will permanently remove the waste record. This cannot be undone.</DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setPendingDeleteId(null)} disabled={deleteMutation.isPending}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={deleteMutation.isPending}
              onClick={() => {
                if (pendingDeleteId !== null) deleteMutation.mutate(pendingDeleteId);
              }}
              data-testid="button-confirm-delete-waste"
            >
              {deleteMutation.isPending ? "Deleting..." : "Delete Entry"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
