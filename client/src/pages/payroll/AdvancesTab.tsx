import { useState, useMemo } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Plus,
  Trash2,
  ArrowDownCircle,
  Loader2,
  ChevronDown,
  ChevronUp,
  Banknote,
  TrendingDown,
  Activity,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useCompany } from "@/contexts/CompanyContext";
import { useCurrencyContext } from "@/contexts/CurrencyContext";
import { useForm } from "react-hook-form";
import { zodResolver } from "@/lib/form-resolver";
import { format } from "date-fns";
import { useDateFormat } from "@/contexts/DateFormatContext";
import { queryClient } from "@/lib/queryClient";
import { getApiRequest } from "@/lib/factoryApi";
import { useAppMode } from "@/contexts/AppModeContext";
import type { Employee } from "@shared/schema";
import type { AccountOption } from "./payrollTypes";
import { Checkbox } from "@/components/ui/checkbox";
import {
  salaryAdvanceSchema,
  deductionSchema,
  type SalaryAdvanceFormData,
  type DeductionFormData,
  type SalaryAdvance,
} from "./payrollSchemas";
import { calculateAdvanceStats } from "./advanceStats";

interface AdvancesTabProps {
  cashAccounts?: AccountOption[];
}

export function AdvancesTab({ cashAccounts = [] }: AdvancesTabProps) {
  const appMode = useAppMode();
  const modeApiRequest = getApiRequest(appMode);
  const { selectedCompany } = useCompany();
  const { toast } = useToast();
  const { formatDisplayDate } = useDateFormat();
  const { formatAmount } = useCurrencyContext();

  const [advanceDialogOpen, setAdvanceDialogOpen] = useState(false);
  const [deductionDialogOpen, setDeductionDialogOpen] = useState(false);
  const [selectedAdvance, setSelectedAdvance] = useState<SalaryAdvance | null>(null);
  const [showPaid, setShowPaid] = useState(false);
  const [workerFilter, setWorkerFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [addWorkerDeductionDialogOpen, setAddWorkerDeductionDialogOpen] = useState(false);

  const { data: workerStaff = [] } = useQuery<Employee[]>({
    queryKey: ["/api/payroll/employees-with-balances", selectedCompany?.id],
    enabled: !!selectedCompany,
    select: (data) => data.filter((e) => e.employeeType === "Worker"),
  });

  const { data: salaryAdvances = [], isLoading: advancesLoading } = useQuery<SalaryAdvance[]>({
    queryKey: ["/api/salary-advances", selectedCompany?.id],
    enabled: !!selectedCompany,
  });

  const { data: repayments = [], isLoading: repaymentsLoading } = useQuery<
    {
      id: number;
      workerName?: string;
      employeeId?: number;
      payrollMonth?: string;
      deductionAmount?: string;
      advanceRemaining?: string;
      createdAt?: string;
    }[]
  >({
    queryKey: ["/api/salary-advance-deductions", selectedCompany?.id],
    enabled: !!selectedCompany,
  });

  const workerDeductionsBase =
    appMode === "factory" ? "/api/factory/worker-deductions" : "/api/payroll/worker-deductions";
  const { data: workerDeductions = [], isLoading: deductionsLoading } = useQuery<
    {
      id: number;
      workerId: number;
      workerName?: string;
      deductionDate?: string;
      reason?: string | null;
      amount?: string;
      applied?: boolean;
    }[]
  >({
    queryKey: [workerDeductionsBase, selectedCompany?.id],
    queryFn: async () => {
      if (!selectedCompany?.id) return [];
      const res = await fetch(`${workerDeductionsBase}?companyId=${selectedCompany.id}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch worker deductions");
      return res.json();
    },
    enabled: !!selectedCompany,
  });

  const advanceForm = useForm<SalaryAdvanceFormData>({
    resolver: zodResolver(salaryAdvanceSchema),
    defaultValues: {
      employeeId: "",
      amount: "",
      advanceDate: new Date(),
      notes: "",
      isOpeningBalance: false,
    },
  });

  const deductionForm = useForm<DeductionFormData>({
    resolver: zodResolver(deductionSchema),
    defaultValues: {
      deductionAmount: "",
      payrollMonth: format(new Date(), "yyyy-MM"),
    },
  });

  const addWorkerDeductionForm = useForm({
    defaultValues: {
      workerId: "",
      amount: "",
      reason: "",
      deductionDate: new Date().toLocaleDateString("en-CA"),
    },
  });

  const advanceMutation = useMutation({
    mutationFn: async (data: SalaryAdvanceFormData) => {
      return await modeApiRequest("POST", "/api/salary-advances", {
        employeeId: parseInt(data.employeeId),
        amount: data.amount,
        advanceDate: format(data.advanceDate, "yyyy-MM-dd"),
        cashAccountId: data.isOpeningBalance ? undefined : parseInt(data.cashAccountId || "0"),
        notes: data.notes,
        isOpeningBalance: data.isOpeningBalance,
      });
    },
    onSuccess: () => {
      toast({ title: "Success", description: "Salary advance created successfully" });
      queryClient.invalidateQueries({ queryKey: ["/api/salary-advances", selectedCompany?.id] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats/net-profit"] });
      setAdvanceDialogOpen(false);
      advanceForm.reset();
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const deleteAdvanceMutation = useMutation({
    mutationFn: async (advanceId: number) => {
      return await modeApiRequest("DELETE", `/api/salary-advances/${advanceId}`, undefined);
    },
    onSuccess: () => {
      toast({ title: "Deleted", description: "Salary advance deleted" });
      queryClient.invalidateQueries({ queryKey: ["/api/salary-advances", selectedCompany?.id] });
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const deductionMutation = useMutation({
    mutationFn: async (data: DeductionFormData) => {
      if (!selectedAdvance) throw new Error("No advance selected");
      return await modeApiRequest("POST", `/api/salary-advances/${selectedAdvance.id}/deduction`, data);
    },
    onSuccess: () => {
      toast({ title: "Success", description: "Deduction recorded successfully" });
      queryClient.invalidateQueries({ queryKey: ["/api/salary-advances", selectedCompany?.id] });
      queryClient.invalidateQueries({ queryKey: ["/api/salary-advance-deductions", selectedCompany?.id] });
      setDeductionDialogOpen(false);
      deductionForm.reset();
      setSelectedAdvance(null);
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const workerDeductionsWorkerBase = appMode === "factory" ? "/api/factory/workers" : "/api/payroll/workers";

  const addWorkerDeductionMutation = useMutation({
    mutationFn: async (data: { workerId: string; amount: string; reason: string; deductionDate: string }) => {
      return await modeApiRequest("POST", `${workerDeductionsWorkerBase}/${data.workerId}/deductions`, {
        amount: data.amount,
        reason: data.reason || null,
        deductionDate: data.deductionDate,
      });
    },
    onSuccess: () => {
      toast({ title: "Deduction added", description: "Worker deduction recorded successfully." });
      queryClient.invalidateQueries({ queryKey: [workerDeductionsBase, selectedCompany?.id] });
      queryClient.invalidateQueries({ queryKey: ["/api/payroll/employees-with-balances", selectedCompany?.id] });
      setAddWorkerDeductionDialogOpen(false);
      addWorkerDeductionForm.reset({
        workerId: "",
        amount: "",
        reason: "",
        deductionDate: new Date().toLocaleDateString("en-CA"),
      });
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const deleteWorkerDeductionMutation = useMutation({
    mutationFn: async ({ workerId, deductionId }: { workerId: number; deductionId: number }) => {
      return await modeApiRequest(
        "DELETE",
        `${workerDeductionsWorkerBase}/${workerId}/deductions/${deductionId}`,
        undefined
      );
    },
    onSuccess: () => {
      toast({ title: "Deleted", description: "Worker deduction deleted." });
      queryClient.invalidateQueries({ queryKey: [workerDeductionsBase, selectedCompany?.id] });
      queryClient.invalidateQueries({ queryKey: ["/api/payroll/employees-with-balances", selectedCompany?.id] });
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const stats = useMemo(() => calculateAdvanceStats(salaryAdvances), [salaryAdvances]);

  // Filtered list
  const filteredAdvances = useMemo(() => {
    return salaryAdvances.filter((a) => {
      const matchWorker = workerFilter === "all" || String(a.employeeId) === workerFilter;
      const matchStatus =
        statusFilter === "all" ||
        (statusFilter === "outstanding" && !a.fullyPaid) ||
        (statusFilter === "paid" && a.fullyPaid);
      return matchWorker && matchStatus;
    });
  }, [salaryAdvances, workerFilter, statusFilter]);

  const outstanding = filteredAdvances.filter((a) => !a.fullyPaid);
  const paid = filteredAdvances.filter((a) => a.fullyPaid);

  if (advancesLoading) {
    return (
      <div className="flex items-center justify-center p-12">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const renderAdvanceRows = (rows: SalaryAdvance[]) =>
    rows.map((advance) => (
      <TableRow key={advance.id}>
        <TableCell>
          <span className="font-medium">{advance.employeeName}</span>
        </TableCell>
        <TableCell>{formatDisplayDate(advance.advanceDate)}</TableCell>
        <TableCell className="text-right font-mono">{formatAmount(parseFloat(advance.amount))}</TableCell>
        <TableCell className="text-right font-mono font-bold text-amber-600 dark:text-amber-400">
          {formatAmount(parseFloat(advance.remainingBalance))}
        </TableCell>
        <TableCell>
          <Badge variant="outline" className="text-[10px]">
            {advance.isOpeningBalance ? "Opening Balance" : "Advance"}
          </Badge>
        </TableCell>
        <TableCell>
          {advance.fullyPaid ? (
            <Badge variant="default" className="bg-green-500">
              Fully Paid
            </Badge>
          ) : (
            <Badge variant="outline" className="border-amber-500 text-amber-500">
              Outstanding
            </Badge>
          )}
        </TableCell>
        <TableCell className="text-sm text-muted-foreground max-w-[180px] truncate">{advance.notes || "—"}</TableCell>
        <TableCell className="text-right">
          <div className="flex justify-end gap-1">
            {!advance.fullyPaid && (
              <Button
                size="icon"
                variant="ghost"
                onClick={() => {
                  setSelectedAdvance(advance);
                  deductionForm.setValue("deductionAmount", advance.remainingBalance);
                  setDeductionDialogOpen(true);
                }}
                title="Record Repayment"
                data-testid={`button-repay-advance-${advance.id}`}
              >
                <ArrowDownCircle className="h-4 w-4 text-green-600" />
              </Button>
            )}
            <Button
              size="icon"
              variant="ghost"
              className="text-destructive"
              onClick={() => {
                if (confirm("Are you sure you want to delete this advance?")) {
                  deleteAdvanceMutation.mutate(advance.id);
                }
              }}
              data-testid={`button-delete-advance-${advance.id}`}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        </TableCell>
      </TableRow>
    ));

  const advanceTableHeaders = (
    <TableRow>
      <TableHead>Worker</TableHead>
      <TableHead>Date</TableHead>
      <TableHead className="text-right">Amount</TableHead>
      <TableHead className="text-right">Remaining</TableHead>
      <TableHead>Type</TableHead>
      <TableHead>Status</TableHead>
      <TableHead>Notes</TableHead>
      <TableHead className="text-right">Actions</TableHead>
    </TableRow>
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">Advances + Deductions</h2>
          <p className="text-muted-foreground">Manage and track worker salary advances and repayments</p>
        </div>
      </div>

      <Tabs defaultValue="advances">
        <TabsList>
          <TabsTrigger value="advances">Advances</TabsTrigger>
          <TabsTrigger value="repayments">Repayments</TabsTrigger>
          <TabsTrigger value="worker-deductions">Worker Deductions</TabsTrigger>
        </TabsList>

        {/* ── Advances sub-tab ── */}
        <TabsContent value="advances" className="space-y-4 pt-4">
          {/* Stats */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="border rounded-md p-4 flex items-center gap-3">
              <Banknote className="h-8 w-8 text-blue-500 shrink-0" />
              <div>
                <p className="text-xs text-muted-foreground">Total Given</p>
                <p className="text-lg font-bold">{formatAmount(stats.total)}</p>
              </div>
            </div>
            <div className="border rounded-md p-4 flex items-center gap-3">
              <TrendingDown className="h-8 w-8 text-amber-500 shrink-0" />
              <div>
                <p className="text-xs text-muted-foreground">Outstanding</p>
                <p className="text-lg font-bold">{formatAmount(stats.outstanding)}</p>
              </div>
            </div>
            <div className="border rounded-md p-4 flex items-center gap-3">
              <Activity className="h-8 w-8 text-green-500 shrink-0" />
              <div>
                <p className="text-xs text-muted-foreground">Active Advances</p>
                <p className="text-lg font-bold">{stats.active}</p>
              </div>
            </div>
          </div>

          {/* Filters + actions */}
          <div className="flex items-center gap-2 flex-wrap">
            <Select value={workerFilter} onValueChange={setWorkerFilter}>
              <SelectTrigger className="w-44" data-testid="select-worker-filter">
                <SelectValue placeholder="All Workers" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Workers</SelectItem>
                {workerStaff.map((w) => (
                  <SelectItem key={w.id} value={String(w.id)}>
                    {w.firstName} {w.lastName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger className="w-40" data-testid="select-status-filter">
                <SelectValue placeholder="All Status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Status</SelectItem>
                <SelectItem value="outstanding">Outstanding</SelectItem>
                <SelectItem value="paid">Fully Paid</SelectItem>
              </SelectContent>
            </Select>

            <div className="ml-auto flex gap-2">
              <Button variant="outline" onClick={() => setAdvanceDialogOpen(true)} data-testid="button-bulk-advance">
                <Banknote className="mr-2 h-4 w-4" />
                Bulk Advance
              </Button>
              <Button onClick={() => setAdvanceDialogOpen(true)} data-testid="button-create-advance">
                <Plus className="mr-2 h-4 w-4" />
                Add Advance
              </Button>
            </div>
          </div>

          {/* Outstanding table */}
          <div className="border rounded-md">
            <Table>
              <TableHeader>{advanceTableHeaders}</TableHeader>
              <TableBody>
                {outstanding.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={8} className="text-center py-8 text-muted-foreground">
                      No outstanding advances
                    </TableCell>
                  </TableRow>
                ) : (
                  renderAdvanceRows(outstanding)
                )}
              </TableBody>
            </Table>
          </div>

          {/* Collapsible fully-paid section */}
          {paid.length > 0 && (
            <div className="border rounded-md overflow-hidden">
              <button
                className="w-full flex items-center justify-between px-4 py-3 text-sm font-medium hover:bg-muted/40 transition-colors"
                onClick={() => setShowPaid((v) => !v)}
                data-testid="button-toggle-paid-advances"
              >
                <span className="flex items-center gap-2">
                  <Badge variant="default" className="bg-green-500">
                    Fully Paid
                  </Badge>
                  <span className="text-muted-foreground">
                    {paid.length} advance{paid.length !== 1 ? "s" : ""}
                  </span>
                </span>
                {showPaid ? (
                  <ChevronUp className="h-4 w-4 text-muted-foreground" />
                ) : (
                  <ChevronDown className="h-4 w-4 text-muted-foreground" />
                )}
              </button>
              {showPaid && (
                <Table>
                  <TableHeader>{advanceTableHeaders}</TableHeader>
                  <TableBody>{renderAdvanceRows(paid)}</TableBody>
                </Table>
              )}
            </div>
          )}
        </TabsContent>

        {/* ── Repayments sub-tab ── */}
        <TabsContent value="repayments" className="pt-4">
          {repaymentsLoading ? (
            <div className="flex items-center justify-center p-12">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <div className="border rounded-md">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Worker</TableHead>
                    <TableHead>Payroll Month</TableHead>
                    <TableHead className="text-right">Repayment Amount</TableHead>
                    <TableHead className="text-right">Advance Remaining After</TableHead>
                    <TableHead>Date Recorded</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {repayments.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={5} className="text-center py-8 text-muted-foreground">
                        No repayments recorded yet
                      </TableCell>
                    </TableRow>
                  ) : (
                    repayments.map((r) => (
                      <TableRow key={r.id}>
                        <TableCell>
                          <span className="font-medium">{r.workerName || `Employee #${r.employeeId}`}</span>
                        </TableCell>
                        <TableCell>{r.payrollMonth}</TableCell>
                        <TableCell className="text-right font-mono text-green-600 dark:text-green-400 font-bold">
                          {formatAmount(parseFloat(r.deductionAmount || "0"))}
                        </TableCell>
                        <TableCell className="text-right font-mono text-muted-foreground">
                          {formatAmount(parseFloat(r.advanceRemaining || "0"))}
                        </TableCell>
                        <TableCell className="text-muted-foreground text-sm">
                          {r.createdAt ? formatDisplayDate(r.createdAt.split("T")[0]) : "—"}
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </div>
          )}
        </TabsContent>

        {/* ── Worker Deductions sub-tab ── */}
        <TabsContent value="worker-deductions" className="pt-4 space-y-4">
          <div className="flex justify-end">
            <Button onClick={() => setAddWorkerDeductionDialogOpen(true)} data-testid="button-add-worker-deduction">
              <Plus className="mr-2 h-4 w-4" />
              Add Deduction
            </Button>
          </div>
          {deductionsLoading ? (
            <div className="flex items-center justify-center p-12">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <div className="border rounded-md">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Worker</TableHead>
                    <TableHead>Date</TableHead>
                    <TableHead>Reason</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {workerDeductions.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={6} className="text-center py-8 text-muted-foreground">
                        No worker deductions recorded
                      </TableCell>
                    </TableRow>
                  ) : (
                    workerDeductions.map((d) => (
                      <TableRow key={d.id}>
                        <TableCell>
                          <span className="font-medium">{d.workerName || `Worker #${d.workerId}`}</span>
                        </TableCell>
                        <TableCell className="text-muted-foreground text-sm">
                          {d.deductionDate ? formatDisplayDate(d.deductionDate) : "—"}
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground max-w-[200px] truncate">
                          {d.reason || "—"}
                        </TableCell>
                        <TableCell className="text-right font-mono font-bold text-red-600 dark:text-red-400">
                          {formatAmount(parseFloat(d.amount || "0"))}
                        </TableCell>
                        <TableCell>
                          {d.applied ? (
                            <Badge variant="default" className="bg-green-600">
                              Applied
                            </Badge>
                          ) : (
                            <Badge variant="outline" className="border-amber-500 text-amber-500">
                              Pending
                            </Badge>
                          )}
                        </TableCell>
                        <TableCell className="text-right">
                          <Button
                            size="icon"
                            variant="ghost"
                            className="text-destructive"
                            disabled={deleteWorkerDeductionMutation.isPending}
                            onClick={() => {
                              if (
                                confirm(
                                  `Delete this deduction of ${formatAmount(parseFloat(d.amount || "0"))} for ${d.workerName || "this worker"}?`
                                )
                              ) {
                                deleteWorkerDeductionMutation.mutate({ workerId: d.workerId, deductionId: d.id });
                              }
                            }}
                            data-testid={`button-delete-deduction-${d.id}`}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </div>
          )}
        </TabsContent>
      </Tabs>

      {/* ── Add Advance Dialog ── */}
      <Dialog open={advanceDialogOpen} onOpenChange={setAdvanceDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>New Salary Advance</DialogTitle>
            <DialogDescription>Record a cash advance given to a worker.</DialogDescription>
          </DialogHeader>
          <Form {...advanceForm}>
            <form onSubmit={advanceForm.handleSubmit((data) => advanceMutation.mutate(data))} className="space-y-4">
              <FormField
                control={advanceForm.control}
                name="employeeId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Worker</FormLabel>
                    <Select onValueChange={field.onChange} defaultValue={field.value}>
                      <FormControl>
                        <SelectTrigger data-testid="select-advance-worker">
                          <SelectValue placeholder="Select worker" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {workerStaff.map((w) => (
                          <SelectItem key={w.id} value={String(w.id)}>
                            {w.code} - {w.firstName} {w.lastName}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <FormField
                  control={advanceForm.control}
                  name="amount"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Amount</FormLabel>
                      <FormControl>
                        <Input
                          type="number"
                          step="0.01"
                          placeholder="0.00"
                          {...field}
                          data-testid="input-advance-amount"
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={advanceForm.control}
                  name="advanceDate"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Date</FormLabel>
                      <FormControl>
                        <Input
                          type="date"
                          value={field.value ? format(field.value, "yyyy-MM-dd") : ""}
                          onChange={(e) => field.onChange(new Date(e.target.value))}
                          data-testid="input-advance-date"
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
              <FormField
                control={advanceForm.control}
                name="isOpeningBalance"
                render={({ field }) => (
                  <FormItem className="flex flex-row items-start space-x-3 space-y-0 rounded-md border p-4">
                    <FormControl>
                      <Checkbox checked={field.value} onCheckedChange={field.onChange} />
                    </FormControl>
                    <div className="space-y-1 leading-none">
                      <FormLabel>Opening Balance</FormLabel>
                      <p className="text-xs text-muted-foreground">
                        Tick if this is an existing balance from before system startup.
                      </p>
                    </div>
                  </FormItem>
                )}
              />
              {!advanceForm.watch("isOpeningBalance") && (
                <FormField
                  control={advanceForm.control}
                  name="cashAccountId"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Cash Account</FormLabel>
                      <Select onValueChange={field.onChange} defaultValue={field.value}>
                        <FormControl>
                          <SelectTrigger data-testid="select-advance-cash">
                            <SelectValue placeholder="Select account" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {cashAccounts.map((acc) => (
                            <SelectItem key={acc.id} value={String(acc.id)}>
                              {acc.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              )}
              <FormField
                control={advanceForm.control}
                name="notes"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Notes (Optional)</FormLabel>
                    <FormControl>
                      <Textarea {...field} data-testid="textarea-advance-notes" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <Button
                type="submit"
                className="w-full"
                disabled={advanceMutation.isPending}
                data-testid="button-save-advance"
              >
                {advanceMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Save Advance
              </Button>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      {/* ── Add Worker Deduction Dialog ── */}
      <Dialog open={addWorkerDeductionDialogOpen} onOpenChange={setAddWorkerDeductionDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Add Worker Deduction</DialogTitle>
            <DialogDescription>Record a deduction from a worker's salary.</DialogDescription>
          </DialogHeader>
          <Form {...addWorkerDeductionForm}>
            <form
              noValidate
              onSubmit={addWorkerDeductionForm.handleSubmit((data) => addWorkerDeductionMutation.mutate(data))}
              className="space-y-4"
            >
              <FormField
                control={addWorkerDeductionForm.control}
                name="workerId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Worker</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger data-testid="select-deduction-worker">
                          <SelectValue placeholder="Select worker" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {workerStaff.map((w) => (
                          <SelectItem key={w.id} value={String(w.id)}>
                            {w.firstName} {w.lastName}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={addWorkerDeductionForm.control}
                name="amount"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Amount</FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        step="0.01"
                        min="0.01"
                        placeholder="0.00"
                        {...field}
                        data-testid="input-deduction-amount"
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={addWorkerDeductionForm.control}
                name="deductionDate"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Date</FormLabel>
                    <FormControl>
                      <Input type="date" {...field} data-testid="input-deduction-date" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={addWorkerDeductionForm.control}
                name="reason"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Reason (Optional)</FormLabel>
                    <FormControl>
                      <Textarea
                        placeholder="e.g. Damage, absence, etc."
                        {...field}
                        data-testid="textarea-deduction-reason"
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <div className="flex justify-end gap-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setAddWorkerDeductionDialogOpen(false)}
                  data-testid="button-cancel-deduction"
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  disabled={addWorkerDeductionMutation.isPending}
                  data-testid="button-save-deduction"
                >
                  {addWorkerDeductionMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  Save Deduction
                </Button>
              </div>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      {/* ── Record Repayment Dialog ── */}
      <Dialog open={deductionDialogOpen} onOpenChange={setDeductionDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Record Repayment</DialogTitle>
            <DialogDescription>Manually record a repayment for {selectedAdvance?.employeeName}.</DialogDescription>
          </DialogHeader>
          <Form {...deductionForm}>
            <form onSubmit={deductionForm.handleSubmit((data) => deductionMutation.mutate(data))} className="space-y-4">
              <FormField
                control={deductionForm.control}
                name="deductionAmount"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Repayment Amount</FormLabel>
                    <FormControl>
                      <Input type="number" step="0.01" {...field} data-testid="input-repayment-amount" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={deductionForm.control}
                name="payrollMonth"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Reference Month (YYYY-MM)</FormLabel>
                    <FormControl>
                      <Input type="month" {...field} data-testid="input-repayment-month" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <Button
                type="submit"
                className="w-full"
                disabled={deductionMutation.isPending}
                data-testid="button-save-repayment"
              >
                {deductionMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Submit Repayment
              </Button>
            </form>
          </Form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
