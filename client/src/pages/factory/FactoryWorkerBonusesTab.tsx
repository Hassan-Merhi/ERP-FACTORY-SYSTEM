import type { ClientErrorLike } from "@/lib/clientError";
import { useState, useMemo } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useAdminOverride } from "@/hooks/use-admin-override";
import { queryClient } from "@/lib/queryClient";
import { Plus, Trash2, Gift, Loader2, Banknote } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
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
} from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
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
  status: "pending" | "paid";
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

function fmt(val: string | number | null | undefined) {
  const n = parseFloat(String(val || 0));
  return isNaN(n) ? "0.00" : n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

const today = () => new Date().toLocaleDateString("en-CA");

export default function FactoryWorkerBonusesTab() {
  const { wrapAdminAction, AdminDialog } = useAdminOverride();
  const { toast } = useToast();
  const [workerFilter, setWorkerFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState<"all" | "pending" | "paid">("all");
  const [addOpen, setAddOpen] = useState(false);
  const [payOpen, setPayOpen] = useState<BonusRecord | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<BonusRecord | null>(null);
  const [addForm, setAddForm] = useState({ workerId: "", bonusDate: today(), amount: "", notes: "" });
  const [payForm, setPayForm] = useState({ cashAccountId: "", paidDate: today() });

  const { data: workers = [] } = useQuery<Worker[]>({
    queryKey: ["/api/factory/workers?profile=picker"],
    queryFn: async () => {
      const res = await fetch("/api/factory/workers?profile=picker", { credentials: "include" });
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

  const { data: cashAccounts = [] } = useQuery<CashAccount[]>({
    queryKey: ["/api/factory/cash-accounts"],
    queryFn: async () => {
      const res = await fetch("/api/factory/cash-accounts", { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

  const qKey = useMemo(() => ["/api/factory/worker-bonuses", workerFilter, statusFilter], [workerFilter, statusFilter]);

  const { data: bonuses = [], isLoading } = useQuery<BonusRecord[]>({
    queryKey: qKey,
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

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-3 items-end justify-between">
        <div className="flex flex-wrap gap-3 items-end">
          <div>
            <Label className="text-xs text-muted-foreground mb-1 block">Worker</Label>
            <Select value={workerFilter} onValueChange={setWorkerFilter}>
              <SelectTrigger className="w-44" data-testid="select-worker-filter">
                <SelectValue placeholder="All workers" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Workers</SelectItem>
                {workers.map((w) => (
                  <SelectItem key={w.id} value={String(w.id)}>
                    {w.fullName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="text-xs text-muted-foreground mb-1 block">Status</Label>
            <Select
              value={statusFilter}
              onValueChange={(v) => setStatusFilter(v as React.SetStateAction<"all" | "pending" | "paid">)}
            >
              <SelectTrigger className="w-32" data-testid="select-bonus-status-filter">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All</SelectItem>
                <SelectItem value="pending">Pending</SelectItem>
                <SelectItem value="paid">Paid</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        <Button onClick={() => setAddOpen(true)} data-testid="button-add-worker-bonus">
          <Plus className="h-4 w-4 mr-2" /> Add Bonus
        </Button>
      </div>

      {!isLoading && pendingTotal > 0 && (
        <div className="flex items-center gap-2 p-3 rounded-md bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800">
          <Gift className="h-4 w-4 text-amber-600 shrink-0" />
          <span className="text-sm text-amber-800 dark:text-amber-200">
            Pending bonuses (unpaid): <strong>{fmt(pendingTotal)}</strong>
          </span>
        </div>
      )}

      {isLoading ? (
        <div className="space-y-2">
          {[...Array(4)].map((_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : bonuses.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            <Gift className="h-10 w-10 mx-auto mb-3 opacity-40" />
            <p>No bonuses recorded.</p>
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="hidden sm:block rounded-md border">
            <Table>
              <TableHeader className="sticky top-0 z-30 bg-background">
                <TableRow>
                  <TableHead>Worker</TableHead>
                  <TableHead>Date</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Notes</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {bonuses.map((b) => (
                  <TableRow key={b.id} data-testid={`row-worker-bonus-${b.id}`}>
                    <TableCell className="font-medium">{b.workerName}</TableCell>
                    <TableCell className="text-sm">{b.bonusDate}</TableCell>
                    <TableCell className="text-right font-mono">{fmt(b.amount)}</TableCell>
                    <TableCell>
                      <Badge variant={b.status === "paid" ? "outline" : "secondary"}>
                        {b.status === "paid" ? "Paid" : "Pending"}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground max-w-32 truncate">{b.notes || "—"}</TableCell>
                    <TableCell>
                      <div className="flex gap-1 justify-end">
                        {b.status === "pending" && (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => {
                              setPayOpen(b);
                              setPayForm({ cashAccountId: "", paidDate: today() });
                            }}
                            data-testid={`button-pay-bonus-${b.id}`}
                          >
                            <Banknote className="h-3 w-3 mr-1" /> Pay
                          </Button>
                        )}
                        <Button
                          size="icon"
                          variant="ghost"
                          onClick={() => setDeleteConfirm(b)}
                          data-testid={`button-delete-worker-bonus-${b.id}`}
                        >
                          <Trash2 className="h-4 w-4 text-destructive" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          <div className="sm:hidden space-y-2">
            {bonuses.map((b) => (
              <Card key={b.id} data-testid={`card-worker-bonus-${b.id}`}>
                <CardContent className="p-3 space-y-2">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <p className="font-medium text-sm">{b.workerName}</p>
                      <p className="text-xs text-muted-foreground">{b.bonusDate}</p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <span className="font-mono text-sm font-medium">{fmt(b.amount)}</span>
                      <Badge variant={b.status === "paid" ? "outline" : "secondary"}>
                        {b.status === "paid" ? "Paid" : "Pending"}
                      </Badge>
                    </div>
                  </div>
                  {b.notes && <p className="text-xs text-muted-foreground">{b.notes}</p>}
                  <div className="flex gap-2 pt-1">
                    {b.status === "pending" && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="flex-1"
                        onClick={() => {
                          setPayOpen(b);
                          setPayForm({ cashAccountId: "", paidDate: today() });
                        }}
                      >
                        <Banknote className="h-3 w-3 mr-1" /> Mark Paid
                      </Button>
                    )}
                    <Button size="icon" variant="ghost" onClick={() => setDeleteConfirm(b)}>
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </>
      )}

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

      <Dialog open={!!payOpen} onOpenChange={(o) => !o && setPayOpen(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Mark Bonus as Paid</DialogTitle>
            <DialogDescription>
              {payOpen && `Paying bonus of ${fmt(payOpen.amount)} to ${payOpen.workerName}.`}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Payment Date</Label>
              <Input
                type="date"
                value={payForm.paidDate}
                onChange={(e) => setPayForm((f) => ({ ...f, paidDate: e.target.value }))}
                data-testid="input-pay-date"
              />
            </div>
            <div>
              <Label>Cash Account</Label>
              <Select
                value={payForm.cashAccountId}
                onValueChange={(v) => setPayForm((f) => ({ ...f, cashAccountId: v }))}
              >
                <SelectTrigger data-testid="select-pay-account">
                  <SelectValue placeholder="Select account" />
                </SelectTrigger>
                <SelectContent>
                  {cashAccounts.map((a) => (
                    <SelectItem key={a.id} value={String(a.id)}>
                      {a.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPayOpen(null)}>
              Cancel
            </Button>
            <Button
              onClick={() => wrapAdminAction(() => payMutation.mutate(), "Pay Bonus")}
              disabled={payMutation.isPending || !payForm.cashAccountId}
              data-testid="button-confirm-pay-bonus"
            >
              {payMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
              Mark Paid
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!deleteConfirm} onOpenChange={(o) => !o && setDeleteConfirm(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Bonus</DialogTitle>
            <DialogDescription>
              Delete bonus of {deleteConfirm && fmt(deleteConfirm.amount)} for {deleteConfirm?.workerName}?
              {deleteConfirm?.status === "paid"
                ? " This bonus was paid — its accounting voucher and entries will be removed as well."
                : ""}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteConfirm(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() =>
                wrapAdminAction(() => deleteConfirm && deleteMutation.mutate(deleteConfirm.id), "Reverse Bonus")
              }
              disabled={deleteMutation.isPending}
              data-testid="button-confirm-delete-worker-bonus"
            >
              {deleteMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {AdminDialog}
    </div>
  );
}
