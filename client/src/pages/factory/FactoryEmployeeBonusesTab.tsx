import type { ClientErrorLike } from "@/lib/clientError";
import { useExistingRecordChangeAccess } from "@/hooks/useExistingRecordChangeAccess";
import { useState, useMemo } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useAdminOverride } from "@/hooks/use-admin-override";
import { queryClient } from "@/lib/queryClient";
import { useCompany } from "@/contexts/CompanyContext";
import { companyQueryKey } from "@/lib/companyQueryScope";
import { Plus, Trash2, Gift, Loader2, Columns3, Filter, Download, CalendarDays, UserRound, Search } from "lucide-react";
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
import {
  DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuLabel, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
  // Accept legacy read fields during the API rollout.
  employee_id?: number;
  bonus_date?: string;
  first_name?: string | null;
  last_name?: string | null;
  employee_code?: string | null;
}

function fmt(val: string | number | null | undefined) {
  const n = parseFloat(String(val || 0));
  return isNaN(n) ? "0.00" : n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

const today = () => new Date().toLocaleDateString("en-CA");

// Use the original record values, not guessed dates or names.
function bonusName(b: BonusRecord) {
  return [b.firstName || b.first_name, b.lastName || b.last_name].filter(Boolean).join(" ").trim() ||
    b.employeeCode || b.employee_code || ("Employee #" + (b.employeeId || b.employee_id || b.id));
}
function bonusDate(b: BonusRecord) {
  return b.bonusDate || b.bonus_date || "";
}
function dateLabel(date: string) {
  if (!date) return "Date unavailable";
  const iso = date.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return date;
  const [year, month, day] = iso.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== iso) return date;
  return parsed.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "2-digit", timeZone: "UTC" });
}
function csvCell(value: string | number) {
  const escaped = String(value).replace(/^[=+\-@\t\r]/, (match) => "'" + match);
  return '"' + escaped.replace(/"/g, '""') + '"';
}

export default function FactoryEmployeeBonusesTab() {
  const { wrapAdminAction, AdminDialog } = useAdminOverride();
  const { toast } = useToast();
  const { selectedCompany } = useCompany();
  const recordChanges = useExistingRecordChangeAccess();
  const [empFilter, setEmpFilter] = useState("all");
  const [showFilters, setShowFilters] = useState(false);
  const [search, setSearch] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [visibleColumns, setVisibleColumns] = useState({ amount: true, notes: true });
  const [addOpen, setAddOpen] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState<BonusRecord | null>(null);
  const [addForm, setAddForm] = useState({ employeeId: "", bonusDate: today(), amount: "", notes: "" });

  const { data: employees = [] } = useQuery<Employee[]>({
    queryKey: companyQueryKey("/api/factory/employees", selectedCompany?.id),
    enabled: Boolean(selectedCompany?.id),
    queryFn: async () => {
      const res = await fetch("/api/factory/employees", { credentials: "include" });
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
  });

  const qKey = useMemo(() => companyQueryKey("/api/factory/employee-bonuses", selectedCompany?.id, empFilter), [selectedCompany?.id, empFilter]);

  const { data: bonuses = [], isLoading } = useQuery<BonusRecord[]>({
    queryKey: qKey,
    enabled: Boolean(selectedCompany?.id),
    queryFn: async () => {
      const params = new URLSearchParams();
      if (empFilter !== "all") params.set("employeeId", empFilter);
      const res = await fetch(`/api/factory/employee-bonuses?${params}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
  });

  const shownBonuses = useMemo(() => bonuses.filter((b) => {
    const day = bonusDate(b).slice(0, 10);
    if (startDate && (!day || day < startDate)) return false;
    if (endDate && (!day || day > endDate)) return false;
    const needle = search.trim().toLowerCase();
    return !needle || [bonusName(b), b.employeeCode || b.employee_code || "", b.notes || ""]
      .some((value) => value.toLowerCase().includes(needle));
  }), [bonuses, startDate, endDate, search]);
  const totalBonuses = useMemo(
    () => shownBonuses.reduce((sum, b) => sum + parseFloat(b.amount || "0"), 0),
    [shownBonuses]
  );

  function exportBonusesCsv() {
    const rows = [
      ["Employee Name", "Date", "Amount", "Notes"],
      ...shownBonuses.map((b) => [bonusName(b), bonusDate(b).slice(0, 10), b.amount, b.notes || ""]),
    ];
    const csv = "\uFEFF" + rows.map((row) => row.map(csvCell).join(",")).join("\r\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "Employee_Bonuses.csv";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  }

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
      queryClient.invalidateQueries({ queryKey: companyQueryKey("/api/factory/employee-bonuses", selectedCompany?.id) });
      queryClient.invalidateQueries({ queryKey: companyQueryKey("/api/factory/employees", selectedCompany?.id) });
    },
    onError: (e: ClientErrorLike) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: number) => {
      if (!recordChanges.allowed) throw new Error(recordChanges.reason ?? "");
      const res = await fetch(`/api/factory/employee-bonuses/${id}`, { method: "DELETE", credentials: "include" });
      if (!res.ok) {
        const e = await res.json();
        throw new Error(e.message);
      }
    },
    onSuccess: () => {
      toast({ title: "Bonus reversed and deleted" });
      setDeleteConfirm(null);
      queryClient.invalidateQueries({ queryKey: companyQueryKey("/api/factory/employee-bonuses", selectedCompany?.id) });
      queryClient.invalidateQueries({ queryKey: companyQueryKey("/api/factory/employees", selectedCompany?.id) });
    },
    onError: (e: ClientErrorLike) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  return (
    <div className="space-y-5">
      <section className="overflow-hidden rounded-2xl border border-border/70 bg-card shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-emerald-200/60 bg-gradient-to-r from-emerald-50 via-teal-50/60 to-background px-4 py-4 dark:border-emerald-900/60 dark:from-emerald-950/60 dark:via-teal-950/30 dark:to-card sm:px-5">
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-600 text-white shadow-sm">
              <Gift className="h-5 w-5" />
            </span>
            <div>
              <h2 className="text-base font-semibold tracking-tight sm:text-lg">Employee Bonuses</h2>
              <p className="text-xs text-muted-foreground">Employee history, names and recorded bonus dates</p>
            </div>
          </div>
          <span className="rounded-full border border-emerald-200 bg-background/80 px-3 py-1 text-xs font-medium text-emerald-700 dark:border-emerald-800 dark:text-emerald-300">
            {isLoading ? "Loading bonuses" : shownBonuses.length + " records"}
          </span>
        </div>
        <div className="space-y-4 p-4 sm:p-5">
      <div className="flex flex-wrap gap-3 items-end justify-between">
        <div>
          <Label className="text-xs text-muted-foreground mb-1 block">Employee</Label>
          <Select value={empFilter} onValueChange={setEmpFilter}>
            <SelectTrigger className="w-48 bg-background" data-testid="select-bonus-emp-filter">
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
        <div className="flex flex-wrap items-center gap-2">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" className="bg-background" data-testid="button-bonus-columns"><Columns3 className="mr-2 h-4 w-4" />Columns</Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel>Visible columns</DropdownMenuLabel>
              <DropdownMenuCheckboxItem checked disabled>Employee Name</DropdownMenuCheckboxItem>
              <DropdownMenuCheckboxItem checked disabled>Date</DropdownMenuCheckboxItem>
              <DropdownMenuCheckboxItem checked={visibleColumns.amount} onCheckedChange={(value) => setVisibleColumns((c) => ({ ...c, amount: value === true }))}>Amount</DropdownMenuCheckboxItem>
              <DropdownMenuCheckboxItem checked={visibleColumns.notes} onCheckedChange={(value) => setVisibleColumns((c) => ({ ...c, notes: value === true }))}>Notes</DropdownMenuCheckboxItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button variant="outline" className={showFilters ? "border-emerald-500 bg-emerald-50 dark:bg-emerald-950/40" : "bg-background"} onClick={() => setShowFilters((open) => !open)} aria-expanded={showFilters} data-testid="button-bonus-filters"><Filter className="mr-2 h-4 w-4" />Filters</Button>
          <Button variant="outline" className="bg-background" onClick={exportBonusesCsv} disabled={isLoading || shownBonuses.length === 0} data-testid="button-bonus-export"><Download className="mr-2 h-4 w-4" />Export</Button>
          {recordChanges.canCreate("POST", "/api/factory/employee-bonuses") && (
            <Button onClick={() => setAddOpen(true)} className="bg-emerald-600 text-white hover:bg-emerald-700 dark:bg-emerald-600 dark:hover:bg-emerald-500" data-testid="button-add-bonus">
              <Plus className="h-4 w-4 mr-2" /> Add Bonus
            </Button>
          )}
        </div>
      </div>
      {showFilters && (
        <div className="grid gap-3 rounded-xl border border-border/70 bg-muted/30 p-3 sm:grid-cols-[minmax(180px,1fr)_160px_160px_auto] sm:items-end">
          <div>
            <Label htmlFor="bonus-search" className="mb-1.5 block text-xs text-muted-foreground">Name or notes</Label>
            <div className="relative"><Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" /><Input id="bonus-search" className="pl-9" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search bonuses..." data-testid="input-bonus-search" /></div>
          </div>
          <div><Label htmlFor="bonus-start-date" className="mb-1.5 block text-xs text-muted-foreground">From date</Label><Input id="bonus-start-date" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} data-testid="input-bonus-start-date" /></div>
          <div><Label htmlFor="bonus-end-date" className="mb-1.5 block text-xs text-muted-foreground">To date</Label><Input id="bonus-end-date" type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} data-testid="input-bonus-end-date" /></div>
          <Button variant="ghost" onClick={() => { setSearch(""); setStartDate(""); setEndDate(""); }}>Clear</Button>
        </div>
      )}

      {!isLoading && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-emerald-200 bg-emerald-50/90 px-4 py-3 dark:border-emerald-800/80 dark:bg-emerald-950/35" data-testid="bonus-total-banner">
          <Gift className="h-4 w-4 text-emerald-600 shrink-0" />
          <span className="text-sm font-medium text-emerald-800 dark:text-emerald-200">Total bonuses shown</span>
          <strong className="text-lg font-bold tabular-nums text-emerald-700 dark:text-emerald-300">{fmt(totalBonuses)}</strong>
        </div>
      )}

      {isLoading ? (
        <div className="space-y-2">
          {[...Array(4)].map((_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : shownBonuses.length === 0 ? (
        <Card className="border-dashed bg-muted/20">
          <CardContent className="py-12 text-center text-muted-foreground">
            <Gift className="h-10 w-10 mx-auto mb-3 opacity-40" />
            <p>{bonuses.length > 0 ? "No bonuses match these filters." : "No bonuses recorded yet."}</p>
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="hidden overflow-x-auto rounded-xl border border-border/80 shadow-sm sm:block">
            <Table mobileLayout="cards">
              <TableHeader className="sticky top-0 z-30 bg-slate-100/90 dark:bg-slate-900/90">
                <TableRow>
                  <TableHead className="min-w-40 py-3 text-xs font-semibold uppercase tracking-wide"><span className="flex items-center gap-2"><UserRound className="h-4 w-4 text-emerald-600" />Employee Name</span></TableHead>
                  <TableHead className="min-w-36 py-3 text-xs font-semibold uppercase tracking-wide"><span className="flex items-center gap-2"><CalendarDays className="h-4 w-4 text-emerald-600" />Date</span></TableHead>
                  {visibleColumns.amount && <TableHead className="text-right text-xs font-semibold uppercase tracking-wide">Amount</TableHead>}
                  {visibleColumns.notes && <TableHead className="text-xs font-semibold uppercase tracking-wide">Notes</TableHead>}
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {shownBonuses.map((b) => (
                  <TableRow key={b.id} className="even:bg-muted/20 hover:bg-emerald-50/50 dark:hover:bg-emerald-950/15" data-testid={`row-bonus-${b.id}`}>
                    <TableCell className="py-3.5 font-semibold" data-testid={`bonus-name-${b.id}`}>{bonusName(b)}</TableCell>
                    <TableCell className="py-3.5 text-sm text-muted-foreground" data-testid={`bonus-date-${b.id}`}>{dateLabel(bonusDate(b))}</TableCell>
                    {visibleColumns.amount && <TableCell className="py-3.5 text-right font-mono font-semibold tabular-nums text-emerald-600 dark:text-emerald-400">{fmt(b.amount)}</TableCell>}
                    {visibleColumns.notes && <TableCell className="max-w-72 truncate py-3.5 text-sm text-muted-foreground" title={b.notes || undefined}>{b.notes || "—"}</TableCell>}
                    <TableCell>
                      {recordChanges.allowed && (
                        <Button
                          size="icon"
                          variant="ghost"
                          className="hover:bg-destructive/10"
                          aria-label={"Reverse bonus for " + bonusName(b)}
                          onClick={() => setDeleteConfirm(b)}
                          data-testid={`button-delete-bonus-${b.id}`}
                        >
                          <Trash2 className="h-4 w-4 text-destructive" />
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          <div className="sm:hidden space-y-2">
            {shownBonuses.map((b) => (
              <Card key={b.id} className="rounded-xl border-border/70 shadow-sm" data-testid={`card-bonus-${b.id}`}>
                <CardContent className="p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <p className="font-semibold text-sm break-words">{bonusName(b)}</p>
                      <p className="flex items-center gap-1.5 text-xs text-muted-foreground"><CalendarDays className="h-3.5 w-3.5" />{dateLabel(bonusDate(b))}</p>
                      {visibleColumns.notes && b.notes ? (
                        <p className="text-xs text-muted-foreground mt-1 break-words">{b.notes}</p>
                      ) : null}
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      {visibleColumns.amount && <span className="font-mono text-emerald-600 dark:text-emerald-400 text-sm font-semibold tabular-nums">{fmt(b.amount)}</span>}
                      {recordChanges.allowed && (
                        <Button size="icon" variant="ghost" onClick={() => setDeleteConfirm(b)}>
                          <Trash2 className="h-4 w-4 text-destructive" />
                        </Button>
                      )}
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </>
      )}

        </div>
      </section>

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
