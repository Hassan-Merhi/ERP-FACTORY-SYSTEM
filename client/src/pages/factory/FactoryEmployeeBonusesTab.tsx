import type { ClientErrorLike } from "@/lib/clientError";
import { useState, useMemo } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useAdminOverride } from "@/hooks/use-admin-override";
import { queryClient } from "@/lib/queryClient";
import { Plus, Trash2, Gift, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
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

interface BonusRecord {
  id: number;
  employeeId: number;
  bonusDate: string;
  amount: string;
  notes: string | null;
  firstName: string;
  lastName: string;
  employeeCode: string;
}

function fmt(val: string | number | null | undefined) {
  const n = parseFloat(String(val || 0));
  return isNaN(n) ? "0.00" : n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

const today = () => new Date().toLocaleDateString("en-CA");

export default function FactoryEmployeeBonusesTab() {
  const { wrapAdminAction, AdminDialog } = useAdminOverride();
  const { toast } = useToast();
  const [empFilter, setEmpFilter] = useState("all");
  const [addOpen, setAddOpen] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState<BonusRecord | null>(null);
  const [addForm, setAddForm] = useState({ employeeId: "", bonusDate: today(), amount: "", notes: "" });

  const { data: employees = [] } = useQuery<Employee[]>({
    queryKey: ["/api/factory/employees"],
    queryFn: async () => {
      const res = await fetch("/api/factory/employees", { credentials: "include" });
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
  });

  const qKey = useMemo(() => ["/api/factory/employee-bonuses", empFilter], [empFilter]);

  const { data: bonuses = [], isLoading } = useQuery<BonusRecord[]>({
    queryKey: qKey,
    queryFn: async () => {
      const params = new URLSearchParams();
      if (empFilter !== "all") params.set("employeeId", empFilter);
      const res = await fetch(`/api/factory/employee-bonuses?${params}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
  });

  const totalBonuses = useMemo(() => bonuses.reduce((s, b) => s + parseFloat(b.amount || "0"), 0), [bonuses]);

  const addMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/factory/employee-bonuses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          employeeId: parseInt(addForm.employeeId),
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
      toast({ title: "Bonus credited to employee account" });
      setAddOpen(false);
      setAddForm({ employeeId: "", bonusDate: today(), amount: "", notes: "" });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/employee-bonuses"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/employees"] });
    },
    onError: (e: ClientErrorLike) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`/api/factory/employee-bonuses/${id}`, { method: "DELETE", credentials: "include" });
      if (!res.ok) {
        const e = await res.json();
        throw new Error(e.message);
      }
    },
    onSuccess: () => {
      toast({ title: "Bonus reversed and deleted" });
      setDeleteConfirm(null);
      queryClient.invalidateQueries({ queryKey: ["/api/factory/employee-bonuses"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/employees"] });
    },
    onError: (e: ClientErrorLike) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-3 items-end justify-between">
        <div>
          <Label className="text-xs text-muted-foreground mb-1 block">Employee</Label>
          <Select value={empFilter} onValueChange={setEmpFilter}>
            <SelectTrigger className="w-48" data-testid="select-bonus-emp-filter">
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
        </div>
        <Button onClick={() => setAddOpen(true)} data-testid="button-add-bonus">
          <Plus className="h-4 w-4 mr-2" /> Add Bonus
        </Button>
      </div>

      {!isLoading && bonuses.length > 0 && (
        <div className="flex items-center gap-2 p-3 rounded-md bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-800">
          <Gift className="h-4 w-4 text-emerald-600 shrink-0" />
          <span className="text-sm text-emerald-800 dark:text-emerald-200">
            Total bonuses shown: <strong>{fmt(totalBonuses)}</strong>
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
            <p>No bonuses recorded yet.</p>
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="hidden sm:block rounded-md border">
            <Table mobileLayout="cards">
              <TableHeader className="sticky top-0 z-30 bg-background">
                <TableRow>
                  <TableHead>Employee</TableHead>
                  <TableHead>Date</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead>Notes</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {bonuses.map((b) => (
                  <TableRow key={b.id} data-testid={`row-bonus-${b.id}`}>
                    <TableCell className="font-medium">
                      {b.firstName} {b.lastName}
                    </TableCell>
                    <TableCell className="text-sm">{b.bonusDate}</TableCell>
                    <TableCell className="text-right font-mono text-emerald-600 dark:text-emerald-400">
                      {fmt(b.amount)}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground max-w-48 truncate">{b.notes || "—"}</TableCell>
                    <TableCell>
                      <Button
                        size="icon"
                        variant="ghost"
                        onClick={() => setDeleteConfirm(b)}
                        data-testid={`button-delete-bonus-${b.id}`}
                      >
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          <div className="sm:hidden space-y-2">
            {bonuses.map((b) => (
              <Card key={b.id} data-testid={`card-bonus-${b.id}`}>
                <CardContent className="p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <p className="font-medium text-sm">
                        {b.firstName} {b.lastName}
                      </p>
                      <p className="text-xs text-muted-foreground">{b.bonusDate}</p>
                      {b.notes && <p className="text-xs text-muted-foreground mt-0.5">{b.notes}</p>}
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <span className="font-mono text-emerald-600 dark:text-emerald-400 text-sm font-medium">
                        {fmt(b.amount)}
                      </span>
                      <Button size="icon" variant="ghost" onClick={() => setDeleteConfirm(b)}>
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    </div>
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
            <DialogTitle>Add Employee Bonus</DialogTitle>
            <DialogDescription>
              The bonus amount will be immediately credited to the employee's account balance.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Employee</Label>
              <Select value={addForm.employeeId} onValueChange={(v) => setAddForm((f) => ({ ...f, employeeId: v }))}>
                <SelectTrigger data-testid="select-bonus-employee">
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
                  value={addForm.bonusDate}
                  onChange={(e) => setAddForm((f) => ({ ...f, bonusDate: e.target.value }))}
                  data-testid="input-bonus-date"
                />
              </div>
              <div>
                <Label>Amount</Label>
                <Input
                  type="number"
                  placeholder="0.00"
                  value={addForm.amount}
                  onChange={(e) => setAddForm((f) => ({ ...f, amount: e.target.value }))}
                  data-testid="input-bonus-amount"
                />
              </div>
            </div>
            <div>
              <Label>Notes (optional)</Label>
              <Textarea
                placeholder="e.g. Performance bonus Q1..."
                value={addForm.notes}
                onChange={(e) => setAddForm((f) => ({ ...f, notes: e.target.value }))}
                rows={2}
                data-testid="input-bonus-notes"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => wrapAdminAction(() => addMutation.mutate(), "Credit Bonus")}
              disabled={addMutation.isPending || !addForm.employeeId || !addForm.amount}
              data-testid="button-confirm-add-bonus"
            >
              {addMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
              Credit Bonus
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!deleteConfirm} onOpenChange={(o) => !o && setDeleteConfirm(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reverse Bonus</DialogTitle>
            <DialogDescription>
              This will reverse and delete the bonus of <strong>{deleteConfirm && fmt(deleteConfirm.amount)}</strong>{" "}
              for {deleteConfirm?.firstName} {deleteConfirm?.lastName}. The amount will be deducted from their account
              balance. This cannot be undone.
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
              data-testid="button-confirm-delete-bonus"
            >
              {deleteMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
              Reverse Bonus
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {AdminDialog}
    </div>
  );
}
