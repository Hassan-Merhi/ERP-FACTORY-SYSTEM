import type { ClientErrorLike } from "@/lib/clientError";
import { useState, useMemo } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
import { Plus, Trash2, RotateCcw, Banknote, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
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

interface Employee {
  id: number;
  code: string;
  firstName: string;
  lastName: string;
}

interface AdvanceRecord {
  id: number;
  employeeId: number;
  advanceDate: string;
  amount: string;
  remainingBalance: string;
  cashAccountId: number | null;
  cashAccountName: string | null;
  notes: string | null;
  fullyPaid: boolean;
  firstName: string;
  lastName: string;
  employeeCode: string;
}

interface RepaymentRecord {
  id: number;
  advanceId: number;
  employeeId: number;
  repaymentDate: string;
  amount: string;
  notes: string | null;
  firstName: string;
  lastName: string;
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

export default function FactoryEmployeeAdvancesTab() {
  const { toast } = useToast();
  const [statusFilter, setStatusFilter] = useState<"all" | "open" | "paid">("open");
  const [empFilter, setEmpFilter] = useState<string>("all");
  const [addOpen, setAddOpen] = useState(false);
  const [repayOpen, setRepayOpen] = useState<AdvanceRecord | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<AdvanceRecord | null>(null);

  const [addForm, setAddForm] = useState({
    employeeId: "",
    advanceDate: today(),
    amount: "",
    cashAccountId: "",
    notes: "",
  });
  const [repayForm, setRepayForm] = useState({ repaymentDate: today(), amount: "", cashAccountId: "", notes: "" });

  const { data: employees = [] } = useQuery<Employee[]>({
    queryKey: ["/api/factory/employees"],
    queryFn: async () => {
      const res = await fetch("/api/factory/employees", { credentials: "include" });
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
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

  const qKey = useMemo(() => ["/api/factory/employee-advances", statusFilter, empFilter], [statusFilter, empFilter]);

  const { data: advances = [], isLoading } = useQuery<AdvanceRecord[]>({
    queryKey: qKey,
    queryFn: async () => {
      const params = new URLSearchParams();
      if (statusFilter !== "all") params.set("status", statusFilter);
      if (empFilter !== "all") params.set("employeeId", empFilter);
      const res = await fetch(`/api/factory/employee-advances?${params}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
  });

  const { data: _repayments = [] } = useQuery<RepaymentRecord[]>({
    queryKey: ["/api/factory/employee-advance-repayments"],
    queryFn: async () => {
      const res = await fetch("/api/factory/employee-advance-repayments", { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
  });

  const addMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/factory/employee-advances", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          employeeId: parseInt(addForm.employeeId),
          advanceDate: addForm.advanceDate,
          amount: addForm.amount,
          cashAccountId: addForm.cashAccountId || null,
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
      toast({ title: "Advance recorded" });
      setAddOpen(false);
      setAddForm({ employeeId: "", advanceDate: today(), amount: "", cashAccountId: "", notes: "" });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/employee-advances"] });
    },
    onError: (e: ClientErrorLike) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const repayMutation = useMutation({
    mutationFn: async () => {
      if (!repayOpen) return;
      const res = await fetch(`/api/factory/employee-advances/${repayOpen.id}/repay`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          repaymentDate: repayForm.repaymentDate,
          amount: repayForm.amount,
          cashAccountId: repayForm.cashAccountId || null,
          notes: repayForm.notes || null,
        }),
      });
      if (!res.ok) {
        const e = await res.json();
        throw new Error(e.message);
      }
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Repayment recorded" });
      setRepayOpen(null);
      setRepayForm({ repaymentDate: today(), amount: "", cashAccountId: "", notes: "" });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/employee-advances"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/employee-advance-repayments"] });
    },
    onError: (e: ClientErrorLike) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`/api/factory/employee-advances/${id}`, { method: "DELETE", credentials: "include" });
      if (!res.ok) {
        const e = await res.json();
        throw new Error(e.message);
      }
    },
    onSuccess: () => {
      toast({ title: "Advance deleted" });
      setDeleteConfirm(null);
      queryClient.invalidateQueries({ queryKey: ["/api/factory/employee-advances"] });
    },
    onError: (e: ClientErrorLike) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const totalOutstanding = useMemo(
    () => advances.filter((a) => !a.fullyPaid).reduce((s, a) => s + parseFloat(a.remainingBalance || "0"), 0),
    [advances]
  );

  return (
    <div className="space-y-5">
      {/* Filter + actions row */}
      <div className="flex flex-wrap items-center gap-3">
        <Select value={empFilter} onValueChange={setEmpFilter}>
          <SelectTrigger className="w-44" data-testid="select-emp-filter">
            <SelectValue placeholder="All employees" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Employees</SelectItem>
            {employees.map((e) => (
              <SelectItem key={e.id} value={String(e.id)}>
                {e.firstName} {e.lastName}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={statusFilter}
          onValueChange={(v) => setStatusFilter(v as React.SetStateAction<"open" | "all" | "paid">)}
        >
          <SelectTrigger className="w-36" data-testid="select-status-filter">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All</SelectItem>
            <SelectItem value="open">Open</SelectItem>
            <SelectItem value="paid">Fully Paid</SelectItem>
          </SelectContent>
        </Select>
        {!isLoading && advances.some((a) => !a.fullyPaid) && (
          <div className="flex items-center gap-2 rounded-lg border bg-amber-50 dark:bg-amber-950/30 border-amber-200 dark:border-amber-800 px-3 py-1.5 text-sm">
            <Banknote className="h-4 w-4 text-amber-500 shrink-0" />
            <span className="text-muted-foreground">Outstanding</span>
            <span className="font-semibold font-mono text-amber-700 dark:text-amber-300">${fmt(totalOutstanding)}</span>
          </div>
        )}
        <Button onClick={() => setAddOpen(true)} className="ml-auto" data-testid="button-add-advance">
          <Plus className="h-4 w-4 mr-2" /> Add Advance
        </Button>
      </div>

      {/* Table */}
      <div className="border rounded-xl overflow-x-auto">
        <Table mobileLayout="cards">
          <TableHeader>
            <TableRow className="bg-muted/40 hover:bg-muted/40">
              <TableHead className="text-xs h-9 font-semibold">Employee</TableHead>
              <TableHead className="text-xs h-9 font-semibold">Date</TableHead>
              <TableHead className="text-xs h-9 font-semibold text-right">Amount</TableHead>
              <TableHead className="text-xs h-9 font-semibold text-right">Remaining</TableHead>
              <TableHead className="text-xs h-9 font-semibold">Status</TableHead>
              <TableHead className="text-xs h-9 font-semibold">Notes</TableHead>
              <TableHead className="text-xs h-9 w-24"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              [...Array(4)].map((_, i) => (
                <TableRow key={i}>
                  <TableCell>
                    <Skeleton className="h-4 w-28" />
                  </TableCell>
                  <TableCell>
                    <Skeleton className="h-4 w-20" />
                  </TableCell>
                  <TableCell>
                    <Skeleton className="h-4 w-16 ml-auto" />
                  </TableCell>
                  <TableCell>
                    <Skeleton className="h-4 w-16 ml-auto" />
                  </TableCell>
                  <TableCell>
                    <Skeleton className="h-5 w-16 rounded-full" />
                  </TableCell>
                  <TableCell>
                    <Skeleton className="h-4 w-24" />
                  </TableCell>
                  <TableCell></TableCell>
                </TableRow>
              ))
            ) : advances.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7}>
                  <div className="flex flex-col items-center gap-2 py-10 text-center">
                    <div className="w-10 h-10 rounded-full bg-muted flex items-center justify-center">
                      <Banknote className="h-5 w-5 text-muted-foreground" />
                    </div>
                    <p className="text-sm font-medium">No advances found</p>
                    <p className="text-xs text-muted-foreground">
                      {statusFilter !== "all" || empFilter !== "all"
                        ? "Try adjusting your filters"
                        : "Add an advance to get started"}
                    </p>
                  </div>
                </TableCell>
              </TableRow>
            ) : (
              advances.map((adv) => (
                <TableRow key={adv.id} className="hover:bg-muted/40" data-testid={`row-advance-${adv.id}`}>
                  <TableCell className="font-medium py-3">
                    {adv.firstName} {adv.lastName}
                  </TableCell>
                  <TableCell className="py-3 text-sm text-muted-foreground">{adv.advanceDate}</TableCell>
                  <TableCell className="py-3 text-right font-mono text-sm">${fmt(adv.amount)}</TableCell>
                  <TableCell className="py-3 text-right font-mono text-sm">
                    {adv.fullyPaid ? (
                      <span className="text-muted-foreground/40">—</span>
                    ) : (
                      <span className="text-amber-600 dark:text-amber-400">${fmt(adv.remainingBalance)}</span>
                    )}
                  </TableCell>
                  <TableCell className="py-3">
                    <Badge
                      variant="secondary"
                      className={`text-xs no-default-active-elevate ${
                        adv.fullyPaid
                          ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300"
                          : "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300"
                      }`}
                    >
                      {adv.fullyPaid ? "Paid" : "Open"}
                    </Badge>
                  </TableCell>
                  <TableCell className="py-3 text-sm text-muted-foreground max-w-32 truncate">
                    {adv.notes || "—"}
                  </TableCell>
                  <TableCell className="py-3">
                    <div className="flex gap-1 justify-end">
                      {!adv.fullyPaid && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            setRepayOpen(adv);
                            setRepayForm({
                              repaymentDate: today(),
                              amount: adv.remainingBalance,
                              cashAccountId: "",
                              notes: "",
                            });
                          }}
                          data-testid={`button-repay-${adv.id}`}
                        >
                          <RotateCcw className="h-3 w-3 mr-1" /> Repay
                        </Button>
                      )}
                      <Button
                        size="icon"
                        variant="ghost"
                        onClick={() => setDeleteConfirm(adv)}
                        data-testid={`button-delete-advance-${adv.id}`}
                      >
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add Employee Advance</DialogTitle>
            <DialogDescription>Record an advance paid to an employee.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Employee</Label>
              <Select value={addForm.employeeId} onValueChange={(v) => setAddForm((f) => ({ ...f, employeeId: v }))}>
                <SelectTrigger data-testid="select-add-employee">
                  <SelectValue placeholder="Select employee" />
                </SelectTrigger>
                <SelectContent>
                  {employees.map((e) => (
                    <SelectItem key={e.id} value={String(e.id)}>
                      {e.firstName} {e.lastName}
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
                  value={addForm.advanceDate}
                  onChange={(e) => setAddForm((f) => ({ ...f, advanceDate: e.target.value }))}
                  data-testid="input-advance-date"
                />
              </div>
              <div>
                <Label>Amount</Label>
                <Input
                  type="number"
                  placeholder="0.00"
                  value={addForm.amount}
                  onChange={(e) => setAddForm((f) => ({ ...f, amount: e.target.value }))}
                  data-testid="input-advance-amount"
                />
              </div>
            </div>
            <div>
              <Label>Cash Account (optional)</Label>
              <Select
                value={addForm.cashAccountId}
                onValueChange={(v) => setAddForm((f) => ({ ...f, cashAccountId: v }))}
              >
                <SelectTrigger data-testid="select-cash-account">
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
            <div>
              <Label>Notes</Label>
              <Textarea
                placeholder="Optional notes..."
                value={addForm.notes}
                onChange={(e) => setAddForm((f) => ({ ...f, notes: e.target.value }))}
                rows={2}
                data-testid="input-advance-notes"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => addMutation.mutate()}
              disabled={addMutation.isPending || !addForm.employeeId || !addForm.amount}
              data-testid="button-confirm-add-advance"
            >
              {addMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
              Save Advance
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!repayOpen} onOpenChange={(o) => !o && setRepayOpen(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Record Repayment</DialogTitle>
            <DialogDescription>
              {repayOpen && `Advance of ${fmt(repayOpen.amount)} — Remaining: ${fmt(repayOpen.remainingBalance)}`}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Date</Label>
                <Input
                  type="date"
                  value={repayForm.repaymentDate}
                  onChange={(e) => setRepayForm((f) => ({ ...f, repaymentDate: e.target.value }))}
                  data-testid="input-repay-date"
                />
              </div>
              <div>
                <Label>Amount</Label>
                <Input
                  type="number"
                  placeholder="0.00"
                  value={repayForm.amount}
                  onChange={(e) => setRepayForm((f) => ({ ...f, amount: e.target.value }))}
                  data-testid="input-repay-amount"
                />
              </div>
            </div>
            <div>
              <Label>Cash Account (optional)</Label>
              <Select
                value={repayForm.cashAccountId}
                onValueChange={(v) => setRepayForm((f) => ({ ...f, cashAccountId: v }))}
              >
                <SelectTrigger>
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
            <div>
              <Label>Notes</Label>
              <Textarea
                placeholder="Optional notes..."
                value={repayForm.notes}
                onChange={(e) => setRepayForm((f) => ({ ...f, notes: e.target.value }))}
                rows={2}
                data-testid="input-repay-notes"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRepayOpen(null)}>
              Cancel
            </Button>
            <Button
              onClick={() => repayMutation.mutate()}
              disabled={repayMutation.isPending || !repayForm.amount}
              data-testid="button-confirm-repay"
            >
              {repayMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
              Record Repayment
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!deleteConfirm} onOpenChange={(o) => !o && setDeleteConfirm(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Advance</DialogTitle>
            <DialogDescription>
              This will permanently delete the advance of {deleteConfirm && fmt(deleteConfirm.amount)} for{" "}
              {deleteConfirm?.firstName} {deleteConfirm?.lastName} along with all repayments. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteConfirm(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => deleteConfirm && deleteMutation.mutate(deleteConfirm.id)}
              disabled={deleteMutation.isPending}
              data-testid="button-confirm-delete-advance"
            >
              {deleteMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
