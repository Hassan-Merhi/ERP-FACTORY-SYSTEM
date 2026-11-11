import { useState, useEffect } from "react";
import { useLocation, useParams } from "wouter";
import { useEscapeToParent } from "@/hooks/use-escape-to-parent";
import { useQuery, useMutation } from "@tanstack/react-query";
import { ArrowLeft, Save, Trash2, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/PageHeader";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { queryClient } from "@/lib/queryClient";
import { useCompany } from "@/contexts/CompanyContext";
import { companyQueryKey } from "@/lib/companyQueryScope";
import { factoryApiRequest } from "@/lib/factoryApi";
import { formatNumber } from "@/lib/formatNumber";

interface OBRecord {
  id: number;
  containerId: number;
  receivedKg: string;
  usedKg: string;
  remainingKg: string;
  costPerKg: string;
  costPerKgUsd: string;
  containerNumber: string;
  currencyCode: string | null;
  fxRateToUsd: string | null;
  notes: string | null;
  supplierId: number | null;
  supplierName: string | null;
}

interface FactorySupplier {
  id: number;
  name: string;
  parentId: number | null;
}

const CURRENCIES = ["USD", "EUR", "GBP", "AED", "KWD", "SAR", "OMR", "BHD", "QAR", "JOD"];

export default function FactoryOpeningBalanceEdit() {
  const { selectedCompany } = useCompany();
  const { id } = useParams<{ id: string }>();
  const [, navigate] = useLocation();
  useEscapeToParent("/factory/raw-materials");
  const { toast } = useToast();

  const [form, setForm] = useState({
    supplierId: "",
    supplierName: "",
    receivedKg: "",
    costPerKg: "",
    currencyCode: "USD",
    fxRateToUsd: "1",
    notes: "",
  });
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);

  const { data: record, isLoading } = useQuery<OBRecord>({
    queryKey: companyQueryKey("/api/factory/raw-stock/opening-balance", selectedCompany?.id, id),
    queryFn: async () => {
      const res = await factoryApiRequest("GET", `/api/factory/raw-stock/opening-balance/${id}`);
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message || "Failed to load record");
      }
      return res.json();
    },
    enabled: Boolean(selectedCompany?.id) && !!id,
  });

  const { data: suppliers } = useQuery<FactorySupplier[]>({
    queryKey: companyQueryKey("/api/factory/suppliers", selectedCompany?.id),
    enabled: Boolean(selectedCompany?.id),
  });

  useEffect(() => {
    if (record) {
      setForm({
        supplierId: record.supplierId ? String(record.supplierId) : "",
        supplierName: record.supplierName || "",
        receivedKg: record.receivedKg,
        costPerKg: record.costPerKg,
        currencyCode: record.currencyCode || "USD",
        fxRateToUsd: record.fxRateToUsd || "1",
        notes: record.notes || "",
      });
    }
  }, [record]);

  const updateMutation = useMutation({
    mutationFn: async () => {
      const body: Record<string, unknown> = {
        receivedKg: form.receivedKg,
        costPerKg: form.costPerKg,
        currencyCode: form.currencyCode,
        fxRateToUsd: form.fxRateToUsd,
        notes: form.notes,
      };
      if (form.supplierId) {
        body.supplierId = parseInt(form.supplierId);
      } else if (form.supplierName) {
        body.supplierName = form.supplierName;
      }
      const res = await factoryApiRequest("PATCH", `/api/factory/raw-stock/opening-balance/${id}`, body);
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message || "Failed to update");
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/raw-stock"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/raw-stock/by-container"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/raw-stock/opening-balance", id] });
      toast({ title: "Saved", description: "Opening balance updated successfully." });
    },
    onError: (err: Error) => {
      if (err?._handledGlobally) return;
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async () => {
      const res = await factoryApiRequest("DELETE", `/api/factory/raw-stock/opening-balance/${id}`);
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message || "Failed to delete");
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/raw-stock"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/raw-stock/by-container"] });
      toast({ title: "Deleted", description: "Opening balance removed. Bales remain intact." });
      navigate("/factory/raw-materials");
    },
    onError: (err: Error) => {
      if (err?._handledGlobally) return;
      toast({ title: "Error", description: err.message, variant: "destructive" });
      setDeleteDialogOpen(false);
    },
  });

  const handleFieldChange = (field: string, value: string) => {
    setForm((prev) => ({ ...prev, [field]: value }));
  };

  if (isLoading) {
    return (
      <div className="space-y-4 max-w-2xl mx-auto">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (!record) {
    return (
      <div className="max-w-2xl mx-auto text-center py-12">
        <AlertTriangle className="mx-auto h-10 w-10 text-muted-foreground mb-4" />
        <p className="text-lg font-semibold">Record not found</p>
        <Button className="mt-4" variant="outline" onClick={() => navigate("/factory/raw-materials")}>
          <ArrowLeft className="h-4 w-4 mr-2" />
          Back to Raw Materials
        </Button>
      </div>
    );
  }

  const usedKg = parseFloat(record.usedKg) || 0;
  const receivedKg = parseFloat(form.receivedKg) || 0;
  const remainingKg = receivedKg - usedKg;

  return (
    <div className="space-y-6 max-w-2xl mx-auto">
      <div className="flex items-center gap-3">
        <Button
          variant="ghost"
          size="icon"
          onClick={() => navigate("/factory/raw-materials")}
          data-testid="button-back"
        >
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div>
          <PageHeader title="Factory Opening Balance" />
          <p className="text-sm text-muted-foreground">{record.containerNumber}</p>
        </div>
        <Badge variant="secondary" className="ml-auto">
          Opening Balance
        </Badge>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Edit Record</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label>Supplier</Label>
            <Select
              value={form.supplierId}
              onValueChange={(val) => {
                if (val === "__manual__") {
                  handleFieldChange("supplierId", "");
                } else {
                  const sup = suppliers?.find((s) => s.id.toString() === val);
                  handleFieldChange("supplierId", val);
                  if (sup) handleFieldChange("supplierName", sup.name);
                }
              }}
            >
              <SelectTrigger data-testid="select-supplier">
                <SelectValue placeholder="Select supplier" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__manual__">Enter manually below</SelectItem>
                {suppliers?.map((s) => (
                  <SelectItem key={s.id} value={s.id.toString()}>
                    {s.name}
                    {s.parentId ? " (sub)" : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {!form.supplierId && (
              <Input
                placeholder="Custom supplier name (e.g. Cyprus)"
                value={form.supplierName}
                onChange={(e) => handleFieldChange("supplierName", e.target.value)}
                data-testid="input-supplier-name"
              />
            )}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Received (kg)</Label>
              <Input
                type="number"
                step="0.001"
                value={form.receivedKg}
                onChange={(e) => handleFieldChange("receivedKg", e.target.value)}
                data-testid="input-received-kg"
              />
            </div>
            <div className="space-y-2">
              <Label>Used (kg)</Label>
              <Input
                value={formatNumber(parseFloat(record.usedKg))}
                readOnly
                className="bg-muted"
                data-testid="text-used-kg"
              />
            </div>
          </div>

          <div className="p-3 rounded-md bg-muted">
            <p className="text-sm text-muted-foreground">Remaining (kg)</p>
            <p className="text-lg font-bold font-mono" data-testid="text-remaining-kg">
              {formatNumber(remainingKg < 0 ? 0 : remainingKg)}
            </p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="space-y-2">
              <Label>Currency</Label>
              <Select value={form.currencyCode} onValueChange={(v) => handleFieldChange("currencyCode", v)}>
                <SelectTrigger data-testid="select-currency">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CURRENCIES.map((c) => (
                    <SelectItem key={c} value={c}>
                      {c}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Cost / kg ({form.currencyCode})</Label>
              <Input
                type="number"
                step="0.0001"
                value={form.costPerKg}
                onChange={(e) => handleFieldChange("costPerKg", e.target.value)}
                data-testid="input-cost-per-kg"
              />
            </div>
            <div className="space-y-2">
              <Label>FX Rate to USD</Label>
              <Input
                type="number"
                step="0.0001"
                value={form.fxRateToUsd}
                onChange={(e) => handleFieldChange("fxRateToUsd", e.target.value)}
                disabled={form.currencyCode === "USD"}
                data-testid="input-fx-rate"
              />
            </div>
          </div>

          {form.currencyCode !== "USD" && (
            <p className="text-sm text-muted-foreground">
              Cost in USD:{" "}
              <span className="font-mono">
                ${(parseFloat(form.costPerKg || "0") * parseFloat(form.fxRateToUsd || "1")).toFixed(4)}/kg
              </span>
            </p>
          )}

          <div className="space-y-2">
            <Label>Notes</Label>
            <Textarea
              value={form.notes}
              onChange={(e) => handleFieldChange("notes", e.target.value)}
              placeholder="Optional notes..."
              data-testid="input-notes"
            />
          </div>
        </CardContent>
      </Card>

      <div className="flex items-center justify-between gap-2">
        <Button variant="destructive" onClick={() => setDeleteDialogOpen(true)} data-testid="button-delete">
          <Trash2 className="h-4 w-4 mr-2" />
          Delete
        </Button>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => navigate("/factory/raw-materials")} data-testid="button-cancel">
            Cancel
          </Button>
          <Button onClick={() => updateMutation.mutate()} disabled={updateMutation.isPending} data-testid="button-save">
            <Save className="h-4 w-4 mr-2" />
            {updateMutation.isPending ? "Saving..." : "Save Changes"}
          </Button>
        </div>
      </div>

      <Dialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-destructive" />
              Delete Opening Balance?
            </DialogTitle>
            <DialogDescription>
              This will permanently remove the opening balance record{" "}
              <span className="font-semibold">{record.containerNumber}</span>.
            </DialogDescription>
          </DialogHeader>
          <div className="rounded-md bg-muted p-3 text-sm space-y-1">
            <p className="font-medium">What happens:</p>
            <p>The opening balance entry will be removed from raw stock.</p>
            <p>Any bales linked through this entry will remain fully intact.</p>
            <p>Raw stock linkage will be safely detached without data loss.</p>
          </div>
          <DialogFooter className="gap-2 flex-wrap">
            <Button variant="outline" onClick={() => setDeleteDialogOpen(false)} data-testid="button-delete-cancel">
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => deleteMutation.mutate()}
              disabled={deleteMutation.isPending}
              data-testid="button-delete-confirm"
            >
              {deleteMutation.isPending ? "Deleting..." : "Yes, Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
