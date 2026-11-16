// Extracted from ./FactoryWorkerBonusesTab.tsx to keep that module under the source-size cap.
import type { ClientErrorLike } from "@/lib/clientError";
import { useExistingRecordChangeAccess } from "@/hooks/useExistingRecordChangeAccess";
import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useAdminOverride } from "@/hooks/use-admin-override";
import { queryClient } from "@/lib/queryClient";
import { useCompany } from "@/contexts/CompanyContext";
import { companyQueryKey } from "@/lib/companyQueryScope";
import { Loader2 } from "lucide-react";
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";

interface Worker {
  id: number;
  fullName: string;
  employeeCode: string | null;
}

interface BonusRecord {
  id: number;
  workerId: number;
  bonusDate: string;
  amount: string;
  notes: string | null;
  status: "pending" | "paid" | "reversed";
  source?: "worker" | "production_manual" | "production_weekly" | "production_daily";
  voucherId?: number;
  cashAccountId: number | null;
  cashAccountName: string | null;
  paidDate: string | null;
  workerName: string;
  employeeCode: string;
}

interface CashAccount {
  id: number;
  name: string;
  code: string;
}

export const today = () => new Date().toLocaleDateString("en-CA");

export function useFactoryWorkerBonusesTabState() {
  const { wrapAdminAction, AdminDialog } = useAdminOverride();
  const { toast } = useToast();
  const { selectedCompany } = useCompany();
  const recordChanges = useExistingRecordChangeAccess();
  const [workerFilter, setWorkerFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState<"all" | "pending" | "paid">("all");
  const [addOpen, setAddOpen] = useState(false);
  const [payOpen, setPayOpen] = useState<BonusRecord | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<BonusRecord | null>(null);
  const [addForm, setAddForm] = useState({ workerId: "", bonusDate: today(), amount: "", notes: "" });
  const [payForm, setPayForm] = useState({ cashAccountId: "", paidDate: today() });

  const { data: workers = [] } = useQuery<Worker[]>({
    queryKey: companyQueryKey("/api/factory/workers?profile=picker", selectedCompany?.id),
    enabled: Boolean(selectedCompany?.id),
    queryFn: async () => {
      const res = await fetch("/api/factory/workers?profile=picker", { credentials: "include" });
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

  const { data: cashAccounts = [] } = useQuery<CashAccount[]>({
    queryKey: companyQueryKey("/api/factory/cash-accounts", selectedCompany?.id),
    enabled: Boolean(selectedCompany?.id),
    queryFn: async () => {
      const res = await fetch("/api/factory/cash-accounts", { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

  const qKey = useMemo(
    () => companyQueryKey("/api/factory/worker-bonuses", selectedCompany?.id, workerFilter, statusFilter),
    [selectedCompany?.id, workerFilter, statusFilter]
  );

  const { data: bonuses = [], isLoading } = useQuery<BonusRecord[]>({
    queryKey: qKey,
    enabled: Boolean(selectedCompany?.id),
    queryFn: async () => {
      const params = new URLSearchParams();
      if (workerFilter !== "all") params.set("workerId", workerFilter);
      if (statusFilter !== "all") params.set("status", statusFilter);
      const res = await fetch(`/api/factory/worker-bonuses?${params}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
  });

  const pendingTotal = useMemo(
    () => bonuses.filter((b) => b.status === "pending").reduce((s, b) => s + parseFloat(b.amount || "0"), 0),
    [bonuses]
  );

  const addMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/factory/worker-bonuses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          workerId: parseInt(addForm.workerId),
          bonusDate: addForm.bonusDate,
          amount: addForm.amount,
          notes: addForm.notes || null,
        }),
      });
      if (!res.ok) {
        const e = await res.json();
        throw new Error(e.message);
      }
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Bonus recorded as pending" });
      setAddOpen(false);
      setAddForm({ workerId: "", bonusDate: today(), amount: "", notes: "" });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/worker-bonuses"] });
    },
    onError: (e: ClientErrorLike) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const payMutation = useMutation({
    mutationFn: async () => {
      if (!recordChanges.allowed) throw new Error(recordChanges.reason ?? "");
      if (!payOpen) return;
      const res = await fetch(`/api/factory/worker-bonuses/${payOpen.id}/pay`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ cashAccountId: parseInt(payForm.cashAccountId), paidDate: payForm.paidDate }),
      });
      if (!res.ok) {
        const e = await res.json();
        throw new Error(e.message);
      }
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Bonus marked as paid" });
      setPayOpen(null);
      setPayForm({ cashAccountId: "", paidDate: today() });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/worker-bonuses"] });
    },
    onError: (e: ClientErrorLike) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: number) => {
      if (!recordChanges.allowed) throw new Error(recordChanges.reason ?? "");
      const res = await fetch(`/api/factory/worker-bonuses/${id}`, { method: "DELETE", credentials: "include" });
      if (!res.ok) {
        const e = await res.json();
        throw new Error(e.message);
      }
    },
    onSuccess: () => {
      toast({ title: "Bonus deleted" });
      setDeleteConfirm(null);
      queryClient.invalidateQueries({ queryKey: ["/api/factory/worker-bonuses"] });
    },
    onError: (e: ClientErrorLike) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });
  return {
    AdminDialog,
    addForm,
    addMutation,
    addOpen,
    bonuses,
    cashAccounts,
    deleteConfirm,
    deleteMutation,
    isLoading,
    payForm,
    payMutation,
    payOpen,
    pendingTotal,
    recordChanges,
    setAddForm,
    setAddOpen,
    setDeleteConfirm,
    setPayForm,
    setPayOpen,
    setStatusFilter,
    setWorkerFilter,
    statusFilter,
    workerFilter,
    workers,
    wrapAdminAction,
  };
}

export function FactoryWorkerBonusesTabDialogSection({
  addForm,
  addMutation,
  addOpen,
  setAddForm,
  setAddOpen,
  workers,
  wrapAdminAction,
}: Pick<
  ReturnType<typeof useFactoryWorkerBonusesTabState>,
  "addForm" | "addMutation" | "addOpen" | "setAddForm" | "setAddOpen" | "workers" | "wrapAdminAction"
>) {
  return (
    <Dialog open={addOpen} onOpenChange={setAddOpen}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add Worker Bonus</DialogTitle>
          <DialogDescription>
            Record a bonus for a worker. It will remain pending until you mark it as paid.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label>Worker</Label>
            <Select value={addForm.workerId} onValueChange={(v) => setAddForm((f) => ({ ...f, workerId: v }))}>
              <SelectTrigger data-testid="select-add-worker">
                <SelectValue placeholder="Select worker" />
              </SelectTrigger>
              <SelectContent>
                {workers.map((w) => (
                  <SelectItem key={w.id} value={String(w.id)}>
                    {w.fullName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Date</Label>
              <Input
                type="date"
                value={addForm.bonusDate}
                onChange={(e) => setAddForm((f) => ({ ...f, bonusDate: e.target.value }))}
                data-testid="input-worker-bonus-date"
              />
            </div>
            <div>
              <Label>Amount</Label>
              <Input
                type="number"
                placeholder="0.00"
                value={addForm.amount}
                onChange={(e) => setAddForm((f) => ({ ...f, amount: e.target.value }))}
                data-testid="input-worker-bonus-amount"
              />
            </div>
          </div>
          <div>
            <Label>Notes (optional)</Label>
            <Textarea
              placeholder="e.g. Production bonus..."
              value={addForm.notes}
              onChange={(e) => setAddForm((f) => ({ ...f, notes: e.target.value }))}
              rows={2}
              data-testid="input-worker-bonus-notes"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setAddOpen(false)}>
            Cancel
          </Button>
          <Button
            onClick={() => wrapAdminAction(() => addMutation.mutate(), "Credit Bonus")}
            disabled={addMutation.isPending || !addForm.workerId || !addForm.amount}
            data-testid="button-confirm-add-worker-bonus"
          >
            {addMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
            Save Bonus
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
