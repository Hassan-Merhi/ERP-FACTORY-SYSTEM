import type { ClientErrorLike } from "@/lib/clientError";
import { useState, useMemo } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useAdminOverride } from "@/hooks/use-admin-override";
import { queryClient } from "@/lib/queryClient";
import { Banknote, Users, Loader2, ArrowDownCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import { Separator } from "@/components/ui/separator";
import { useToast } from "@/hooks/use-toast";

interface Employee {
  id: number;
  code: string | null;
  firstName: string;
  lastName: string;
  currentBalance: string;
}

interface CashAccount {
  id: number;
  name: string;
  code: string;
}

function fmt(v: string | number | null | undefined) {
  const n = parseFloat(String(v || 0));
  return isNaN(n) ? "0.00" : n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

const today = () => new Date().toLocaleDateString("en-CA");

export default function FactoryEmployeeWithdrawalsTab() {
  const { wrapAdminAction, AdminDialog } = useAdminOverride();
  const { toast } = useToast();
  const [_mode, _setMode] = useState<"single" | "bulk">("single");
  const [singleOpen, setSingleOpen] = useState(false);
  const [bulkOpen, setBulkOpen] = useState(false);

  const [singleForm, setSingleForm] = useState({
    employeeId: "",
    amount: "",
    date: today(),
    cashAccountId: "",
    notes: "",
  });

  const [bulkForm, setBulkForm] = useState({
    date: today(),
    cashAccountId: "",
    notes: "",
  });
  const [bulkAmounts, setBulkAmounts] = useState<Record<number, string>>({});

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

  const singleMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/factory/employees/${singleForm.employeeId}/withdraw`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          amount: singleForm.amount,
          date: singleForm.date,
          cashAccountId: singleForm.cashAccountId,
          notes: singleForm.notes || undefined,
        }),
      });
      if (!res.ok) {
        const e = await res.json();
        throw new Error(e.message);
      }
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Withdrawal recorded" });
      setSingleOpen(false);
      setSingleForm({ employeeId: "", amount: "", date: today(), cashAccountId: "", notes: "" });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/employees"] });
    },
    onError: (e: ClientErrorLike) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const bulkMutation = useMutation({
    mutationFn: async () => {
      const withdrawals = employees
        .filter((e) => bulkAmounts[e.id] && parseFloat(bulkAmounts[e.id]) > 0)
        .map((e) => ({ employeeId: e.id, amount: bulkAmounts[e.id] }));
      if (withdrawals.length === 0) throw new Error("Enter at least one withdrawal amount");
      const res = await fetch("/api/factory/employees/bulk-withdraw", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          withdrawals,
          date: bulkForm.date,
          cashAccountId: bulkForm.cashAccountId,
          notes: bulkForm.notes || undefined,
        }),
      });
      if (!res.ok) {
        const e = await res.json();
        throw new Error(e.message);
      }
      return res.json();
    },
    onSuccess: (data) => {
      toast({
        title: "Bulk withdrawal recorded",
        description: `${data.results?.length ?? 0} employees — Total: ${fmt(data.totalAmount)}`,
      });
      setBulkOpen(false);
      setBulkAmounts({});
      setBulkForm({ date: today(), cashAccountId: "", notes: "" });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/employees"] });
    },
    onError: (e: ClientErrorLike) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const bulkTotal = useMemo(
    () => Object.values(bulkAmounts).reduce((s, v) => s + (parseFloat(v) || 0), 0),
    [bulkAmounts]
  );

  const selectedEmp = employees.find((e) => String(e.id) === singleForm.employeeId);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-3 items-center justify-between">
        <div>
          <h3 className="font-medium">Employee Withdrawals</h3>
          <p className="text-sm text-muted-foreground">Deduct cash from one or multiple employees.</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => setSingleOpen(true)} data-testid="button-withdraw-single">
            <ArrowDownCircle className="h-4 w-4 mr-2" />
            Withdraw (Single)
          </Button>
          <Button onClick={() => setBulkOpen(true)} data-testid="button-withdraw-bulk">
            <Users className="h-4 w-4 mr-2" />
            Withdraw All (Bulk)
          </Button>
        </div>
      </div>

      {employees.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            <Users className="h-10 w-10 mx-auto mb-3 opacity-40" />
            <p>No active employees found.</p>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm text-muted-foreground font-normal flex items-center gap-2">
              <Banknote className="h-4 w-4" />
              Current Balances
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <div className="hidden sm:block">
              <Table mobileLayout="cards">
                <TableHeader className="sticky top-0 z-30 bg-background">
                  <TableRow>
                    <TableHead>Employee</TableHead>
                    <TableHead>Code</TableHead>
                    <TableHead className="text-right">Balance</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {employees.map((emp) => {
                    const bal = parseFloat(emp.currentBalance || "0");
                    return (
                      <TableRow key={emp.id} data-testid={`row-employee-${emp.id}`}>
                        <TableCell className="font-medium">
                          {emp.firstName} {emp.lastName}
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">{emp.code || "—"}</TableCell>
                        <TableCell
                          className={`text-right font-mono ${bal < 0 ? "text-red-600 dark:text-red-400" : ""}`}
                        >
                          {fmt(emp.currentBalance)}
                        </TableCell>
                        <TableCell>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => {
                              setSingleForm((f) => ({ ...f, employeeId: String(emp.id) }));
                              setSingleOpen(true);
                            }}
                            data-testid={`button-withdraw-${emp.id}`}
                          >
                            <ArrowDownCircle className="h-3 w-3 mr-1" /> Withdraw
                          </Button>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
            <div className="sm:hidden space-y-2 p-3">
              {employees.map((emp) => {
                const bal = parseFloat(emp.currentBalance || "0");
                return (
                  <Card key={emp.id} data-testid={`card-employee-${emp.id}`}>
                    <CardContent className="p-3 flex items-center justify-between gap-3">
                      <div>
                        <p className="font-medium text-sm">
                          {emp.firstName} {emp.lastName}
                        </p>
                        <p
                          className={`text-sm font-mono ${bal < 0 ? "text-red-600 dark:text-red-400" : "text-muted-foreground"}`}
                        >
                          {fmt(emp.currentBalance)}
                        </p>
                      </div>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          setSingleForm((f) => ({ ...f, employeeId: String(emp.id) }));
                          setSingleOpen(true);
                        }}
                      >
                        <ArrowDownCircle className="h-3 w-3 mr-1" /> Withdraw
                      </Button>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Single Withdrawal Dialog */}
      <Dialog
        open={singleOpen}
        onOpenChange={(o) => {
          if (!o) setSingleOpen(false);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Withdraw — Single Employee</DialogTitle>
            <DialogDescription>Record a cash withdrawal deducted from an employee.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Employee</Label>
              <Select
                value={singleForm.employeeId}
                onValueChange={(v) => setSingleForm((f) => ({ ...f, employeeId: v }))}
              >
                <SelectTrigger data-testid="select-single-employee">
                  <SelectValue placeholder="Select employee" />
                </SelectTrigger>
                <SelectContent>
                  {employees.map((e) => (
                    <SelectItem key={e.id} value={String(e.id)}>
                      {e.firstName} {e.lastName}
                      {e.code && ` (${e.code})`}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {selectedEmp && (
                <p className="text-xs text-muted-foreground mt-1">
                  Current balance:{" "}
                  <span className={parseFloat(selectedEmp.currentBalance || "0") < 0 ? "text-red-500" : ""}>
                    {fmt(selectedEmp.currentBalance)}
                  </span>
                </p>
              )}
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Date</Label>
                <Input
                  type="date"
                  value={singleForm.date}
                  onChange={(e) => setSingleForm((f) => ({ ...f, date: e.target.value }))}
                  data-testid="input-withdraw-date"
                />
              </div>
              <div>
                <Label>Amount</Label>
                <Input
                  type="number"
                  placeholder="0.00"
                  min="0"
                  step="0.01"
                  value={singleForm.amount}
                  onChange={(e) => setSingleForm((f) => ({ ...f, amount: e.target.value }))}
                  data-testid="input-withdraw-amount"
                />
              </div>
            </div>
            <div>
              <Label>Cash Account</Label>
              <Select
                value={singleForm.cashAccountId}
                onValueChange={(v) => setSingleForm((f) => ({ ...f, cashAccountId: v }))}
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
              <Label>Notes (optional)</Label>
              <Textarea
                placeholder="Optional notes…"
                rows={2}
                value={singleForm.notes}
                onChange={(e) => setSingleForm((f) => ({ ...f, notes: e.target.value }))}
                data-testid="input-withdraw-notes"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSingleOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => wrapAdminAction(() => singleMutation.mutate(), "Record Withdrawal")}
              disabled={
                singleMutation.isPending || !singleForm.employeeId || !singleForm.amount || !singleForm.cashAccountId
              }
              data-testid="button-confirm-single-withdraw"
            >
              {singleMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
              Record Withdrawal
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Bulk Withdrawal Dialog */}
      <Dialog
        open={bulkOpen}
        onOpenChange={(o) => {
          if (!o) setBulkOpen(false);
        }}
      >
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Bulk Withdrawal — All Employees</DialogTitle>
            <DialogDescription>Enter withdrawal amounts for each employee. Leave blank to skip.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Date</Label>
                <Input
                  type="date"
                  value={bulkForm.date}
                  onChange={(e) => setBulkForm((f) => ({ ...f, date: e.target.value }))}
                  data-testid="input-bulk-date"
                />
              </div>
              <div>
                <Label>Cash Account</Label>
                <Select
                  value={bulkForm.cashAccountId}
                  onValueChange={(v) => setBulkForm((f) => ({ ...f, cashAccountId: v }))}
                >
                  <SelectTrigger data-testid="select-bulk-cash-account">
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
            <div>
              <Label>Notes (optional)</Label>
              <Textarea
                placeholder="Optional notes for all entries…"
                rows={2}
                value={bulkForm.notes}
                onChange={(e) => setBulkForm((f) => ({ ...f, notes: e.target.value }))}
                data-testid="input-bulk-notes"
              />
            </div>
            <Separator />
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <p className="text-sm font-medium">Employee Amounts</p>
                <Badge variant="outline">Total: {fmt(bulkTotal)}</Badge>
              </div>
              {employees.map((emp) => (
                <div key={emp.id} className="flex items-center gap-3">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">
                      {emp.firstName} {emp.lastName}
                    </p>
                    <p className="text-xs text-muted-foreground">Balance: {fmt(emp.currentBalance)}</p>
                  </div>
                  <Input
                    type="number"
                    placeholder="0.00"
                    min="0"
                    step="0.01"
                    className="w-28 text-right"
                    value={bulkAmounts[emp.id] || ""}
                    onChange={(e) => setBulkAmounts((p) => ({ ...p, [emp.id]: e.target.value }))}
                    data-testid={`input-bulk-amount-${emp.id}`}
                  />
                </div>
              ))}
            </div>
          </div>
          <DialogFooter className="mt-4">
            <Button variant="outline" onClick={() => setBulkOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => wrapAdminAction(() => bulkMutation.mutate(), "Record Bulk Withdrawal")}
              disabled={bulkMutation.isPending || !bulkForm.cashAccountId || bulkTotal <= 0}
              data-testid="button-confirm-bulk-withdraw"
            >
              {bulkMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
              Record {fmt(bulkTotal)} Withdrawal
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {AdminDialog}
    </div>
  );
}
