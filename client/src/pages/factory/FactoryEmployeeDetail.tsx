import type { ClientErrorLike } from "@/lib/clientError";
import { useExistingRecordChangeAccess } from "@/hooks/useExistingRecordChangeAccess";
import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useAdminOverride } from "@/hooks/use-admin-override";
import { useRoute, useLocation } from "wouter";
import { useEscapeToParent } from "@/hooks/use-escape-to-parent";
import {
  ArrowLeft,
  Building,
  CreditCard,
  DollarSign,
  Calendar,
  Phone,
  Loader2,
  Pencil,
  TrendingUp,
  TrendingDown,
  RefreshCw,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useHubQueryState } from "@/hooks/use-hub-query-state";
import type { FactoryMyAccess } from "@shared/apiTypes";
import { ReportExportMenu } from "@/components/export/ReportExportMenu";
import { getAvatarColor, getInitials } from "@/pages/factory/factoryworkers/utils";
import { PersonStatusBadge } from "@/pages/factory/people/PeopleRoster";
import { PersonInfoCard, PersonInfoRow } from "@/pages/factory/people/PersonDetailParts";
import { PersonAttendancePanel } from "@/pages/factory/people/PersonAttendancePanel";
import { EmployeeAdvancesCard } from "@/pages/factory/people/EmployeeAdvancesCard";
import { PersonFormDialog } from "@/pages/factory/people/PersonFormDialog";
import { EmployeeFormFields } from "@/pages/factory/people/EmployeeFormFields";
import {
  exportPeopleTableExcel,
  exportPeopleTablePdf,
  printPeopleTable,
  type PeopleExportSpec,
} from "@/pages/factory/people/peopleExport";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { queryClient } from "@/lib/queryClient";
import { useCompany } from "@/contexts/CompanyContext";
import { companyQueryKey } from "@/lib/companyQueryScope";
import { factoryApiRequest } from "@/lib/factoryApi";
import { useDateFormat } from "@/contexts/DateFormatContext";
import { EmptyState, ErrorState } from "@/components/ui/page-state";

interface Employee {
  id: number;
  code: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  department: string | null;
  monthlySalary: string;
  currentBalance: string;
  totalDeposits: string;
  totalWithdrawals: string;
  active: boolean;
  joinDate: string;
  employeeType: string;
}

interface StatementRow {
  id: number;
  voucherId: number;
  voucherNumber: string;
  voucherDate: string;
  voucherType: string;
  description: string;
  narration: string;
  credit: number;
  debit: number;
  balance: number;
}

interface LedgerAccount {
  id: number;
  name: string;
  code: string;
  accountType: string;
}

function fmt(val: string | number | null | undefined) {
  const n = parseFloat(String(val || 0));
  return isNaN(n) ? "$0.00" : `$${n.toFixed(2)}`;
}

const EMPLOYEE_DETAIL_TABS = ["profile", "statement", "advances", "attendance"] as const;
type EmployeeDetailTab = (typeof EMPLOYEE_DETAIL_TABS)[number];

export default function FactoryEmployeeDetail() {
  const { wrapAdminAction, AdminDialog } = useAdminOverride();
  const { data: currentUser } = useQuery<{ role?: string }>({ queryKey: ["/api/auth/me"] });
  const isDeveloper = currentUser?.role === "Developer";
  const [, navigate] = useLocation();
  useEscapeToParent("/factory/payroll-hub?section=employees");
  const [, params] = useRoute("/factory/employees/:id");
  const employeeId = params?.id ? parseInt(params.id) : null;
  const { toast } = useToast();
  const { selectedCompany } = useCompany();
  const recordChanges = useExistingRecordChangeAccess();
  const { formatDisplayDate } = useDateFormat();

  const formatDate = (val: string | Date | null | undefined) => {
    if (!val) return "—";
    try {
      return formatDisplayDate(val instanceof Date ? val : new Date(val));
    } catch {
      return "—";
    }
  };

  // State for dialogs
  const [editOpen, setEditOpen] = useState(false);
  const [editForm, setEditForm] = useState({
    firstName: "",
    lastName: "",
    department: "",
    phone: "",
    monthlySalary: "",
  });

  // Deposit form
  const [depositOpen, setDepositOpen] = useState(false);
  const [depositAmount, setDepositAmount] = useState("");
  const [depositDate, setDepositDate] = useState(new Date().toLocaleDateString("en-CA"));
  const [depositNotes, setDepositNotes] = useState("");
  const [depositEffectiveDate, setDepositEffectiveDate] = useState("");

  // Withdrawal form
  const [withdrawOpen, setWithdrawOpen] = useState(false);
  const [withdrawAmount, setWithdrawAmount] = useState("");
  const [withdrawDate, setWithdrawDate] = useState(new Date().toLocaleDateString("en-CA"));
  const [withdrawNotes, setWithdrawNotes] = useState("");
  const [withdrawCashAccountId, setWithdrawCashAccountId] = useState("");

  // Queries
  const {
    data: employee,
    isLoading: empLoading,
    error: empError,
  } = useQuery<Employee>({
    queryKey: companyQueryKey("/api/factory/employees", selectedCompany?.id, employeeId),
    queryFn: async () => {
      const res = await factoryApiRequest("GET", `/api/factory/employees/${employeeId}`);
      if (!res.ok) throw new Error("Employee not found");
      return res.json();
    },
    enabled: Boolean(selectedCompany?.id) && !!employeeId,
  });

  const {
    data: statement,
    isLoading: stmtLoading,
    isError: stmtError,
    refetch: refetchStatement,
  } = useQuery<{ employee: Employee; rows: StatementRow[] }>({
    queryKey: companyQueryKey("/api/factory/employees", selectedCompany?.id, employeeId, "statement"),
    queryFn: async () => {
      const res = await factoryApiRequest("GET", `/api/factory/employees/${employeeId}/statement`);
      if (!res.ok) throw new Error("Failed to fetch statement");
      return res.json();
    },
    enabled: Boolean(selectedCompany?.id) && !!employeeId,
  });

  const { data: cashAccounts = [] } = useQuery<LedgerAccount[]>({
    queryKey: companyQueryKey("/api/ledger-accounts?includeHidden=true&profile=picker", selectedCompany?.id),
    enabled: Boolean(selectedCompany?.id),
    queryFn: async () => {
      const res = await fetch("/api/ledger-accounts?includeHidden=true&profile=picker", { credentials: "include" });
      if (!res.ok) return [];
      const data = await res.json();
      return (data || []).filter(
        (a: LedgerAccount) => a.accountType === "Cash" || a.accountType?.toLowerCase().includes("cash")
      );
    },
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

  // Tabs reuse the Employees hub access keys for Advances and Attendance.
  const { data: myAccess } = useQuery<FactoryMyAccess>({
    queryKey: companyQueryKey("/api/factory/my-access", selectedCompany?.id),
    enabled: Boolean(selectedCompany?.id),
    staleTime: 5 * 60000,
  });
  const accessReady = myAccess?.companyId === selectedCompany?.id;
  const hiddenTabs = accessReady && myAccess?.hasFactoryAccess === true ? myAccess.hiddenCostFields : null;
  const showAdvancesTab = hiddenTabs !== null && !hiddenTabs.includes("hide_tab_employees_advances");
  const showAttendanceTab = hiddenTabs !== null && !hiddenTabs.includes("hide_tab_employees_attendance");
  const visibleDetailTabs: EmployeeDetailTab[] = [
    "profile",
    "statement",
    ...(showAdvancesTab ? (["advances"] as const) : []),
    ...(showAttendanceTab ? (["attendance"] as const) : []),
  ];
  const [requestedTab, setRequestedTab] = useHubQueryState<EmployeeDetailTab>({
    key: "tab",
    // Until access loads, keep a deep-linked tab instead of stripping it.
    allowedValues: accessReady ? visibleDetailTabs : EMPLOYEE_DETAIL_TABS,
    knownValues: EMPLOYEE_DETAIL_TABS,
    defaultValue: "statement",
    omitDefault: true,
  });
  const activeTab = visibleDetailTabs.includes(requestedTab) ? requestedTab : "statement";
  const [exportBusy, setExportBusy] = useState(false);

  // Mutations
  const updateMutation = useMutation({
    mutationFn: async (data: typeof editForm) => {
      if (!recordChanges.allowed) throw new Error(recordChanges.reason ?? "");
      const res = await factoryApiRequest("PATCH", `/api/factory/employees/${employeeId}`, data);
      if (!res.ok) {
        const e = await res.json();
        throw new Error(e.message);
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: companyQueryKey("/api/factory/employees", selectedCompany?.id, employeeId),
      });
      queryClient.invalidateQueries({ queryKey: companyQueryKey("/api/factory/employees", selectedCompany?.id) });
      toast({ title: "Employee updated" });
      setEditOpen(false);
    },
    onError: (e: ClientErrorLike) => {
      if (e?._handledGlobally) return;
      toast({ variant: "destructive", title: e.message });
    },
  });

  const recalcMutation = useMutation({
    mutationFn: async () => {
      if (!recordChanges.allowed) throw new Error(recordChanges.reason ?? "");
      const res = await factoryApiRequest("POST", `/api/factory/employees/${employeeId}/recalculate-balance`);
      if (!res.ok) {
        const e = await res.json();
        throw new Error(e.message);
      }
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({
        queryKey: companyQueryKey("/api/factory/employees", selectedCompany?.id, employeeId),
      });
      queryClient.invalidateQueries({ queryKey: companyQueryKey("/api/factory/employees", selectedCompany?.id) });
      toast({ title: "Balance recalculated", description: `New balance: $${data.newBalance?.toFixed(2)}` });
    },
    onError: (e: ClientErrorLike) => {
      if (e?._handledGlobally) return;
      toast({ variant: "destructive", title: e.message });
    },
  });

  const depositMutation = useMutation({
    mutationFn: async () => {
      if (!recordChanges.allowed) throw new Error(recordChanges.reason ?? "");
      const res = await factoryApiRequest("POST", `/api/factory/employees/${employeeId}/deposit`, {
        amount: depositAmount,
        date: depositDate,
        notes: depositNotes,
        effectiveDate: depositEffectiveDate || null,
      });
      if (!res.ok) {
        const e = await res.json();
        throw new Error(e.message);
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: companyQueryKey("/api/factory/employees", selectedCompany?.id, employeeId),
      });
      queryClient.invalidateQueries({
        queryKey: companyQueryKey("/api/factory/employees", selectedCompany?.id, employeeId, "statement"),
      });
      queryClient.invalidateQueries({ queryKey: companyQueryKey("/api/factory/employees", selectedCompany?.id) });
      toast({ title: "Deposit recorded" });
      setDepositOpen(false);
      setDepositAmount("");
      setDepositNotes("");
      setDepositEffectiveDate("");
    },
    onError: (e: ClientErrorLike) => {
      if (e?._handledGlobally) return;
      toast({ variant: "destructive", title: e.message });
    },
  });

  const withdrawMutation = useMutation({
    mutationFn: async () => {
      if (!recordChanges.allowed) throw new Error(recordChanges.reason ?? "");
      const res = await factoryApiRequest("POST", `/api/factory/employees/${employeeId}/withdraw`, {
        amount: withdrawAmount,
        date: withdrawDate,
        notes: withdrawNotes,
        cashAccountId: withdrawCashAccountId,
      });
      if (!res.ok) {
        const e = await res.json();
        throw new Error(e.message);
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: companyQueryKey("/api/factory/employees", selectedCompany?.id, employeeId),
      });
      queryClient.invalidateQueries({
        queryKey: companyQueryKey("/api/factory/employees", selectedCompany?.id, employeeId, "statement"),
      });
      queryClient.invalidateQueries({ queryKey: companyQueryKey("/api/factory/employees", selectedCompany?.id) });
      toast({ title: "Withdrawal recorded" });
      setWithdrawOpen(false);
      setWithdrawAmount("");
      setWithdrawNotes("");
      setWithdrawCashAccountId("");
    },
    onError: (e: ClientErrorLike) => {
      if (e?._handledGlobally) return;
      toast({ variant: "destructive", title: e.message });
    },
  });

  if (!employeeId) return <div className="p-8 text-muted-foreground">Invalid employee ID</div>;

  if (empLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-32" />
        <div className="flex gap-6">
          <Skeleton className="w-64 h-80 shrink-0 rounded-md" />
          <Skeleton className="flex-1 h-80 rounded-md" />
        </div>
      </div>
    );
  }

  if (empError || !employee) {
    return (
      <div className="space-y-4">
        <Button variant="ghost" size="icon" onClick={() => navigate("/factory/payroll-hub?section=employees")}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div className="flex items-center justify-center py-20 text-muted-foreground">Employee not found</div>
      </div>
    );
  }

  const fullName = `${employee.firstName} ${employee.lastName}`;
  const avatarColor = getAvatarColor(fullName);
  const balance = parseFloat(employee.currentBalance || "0");

  const statementRows = statement?.rows ?? [];
  const exportStatement = async (format: "excel" | "pdf" | "print") => {
    const spec: PeopleExportSpec<StatementRow> = {
      title: "Employee Statement",
      fileStem: `${fullName} statement`,
      subtitle: [employee.code, fullName].filter(Boolean).join(" · "),
      columns: [
        { header: "Date", width: 14, value: (row) => formatDate(row.voucherDate) },
        { header: "Voucher", width: 16, value: (row) => row.voucherNumber },
        { header: "Description", width: 40, value: (row) => row.narration || row.description || "" },
        { header: "Deposit", type: "money", value: (row) => (row.credit > 0 ? row.credit : null) },
        { header: "Withdrawal", type: "money", value: (row) => (row.debit > 0 ? row.debit : null) },
        { header: "Balance", type: "money", value: (row) => row.balance },
      ],
      rows: statementRows,
      footer: [
        "TOTAL",
        "",
        "",
        statementRows.reduce((sum, row) => sum + (row.credit > 0 ? row.credit : 0), 0),
        statementRows.reduce((sum, row) => sum + (row.debit > 0 ? row.debit : 0), 0),
        statementRows.length ? statementRows[statementRows.length - 1].balance : null,
      ],
    };
    if (format === "print") {
      if (!printPeopleTable(spec)) {
        toast({ title: "Print failed", description: "Allow pop-ups to print.", variant: "destructive" });
      }
      return;
    }
    setExportBusy(true);
    try {
      if (format === "excel") await exportPeopleTableExcel(spec);
      else await exportPeopleTablePdf(spec);
    } catch (error) {
      toast({
        title: "Export failed",
        description: error instanceof Error ? error.message : "Please try again.",
        variant: "destructive",
      });
    } finally {
      setExportBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <Button
        variant="ghost"
        size="icon"
        onClick={() => navigate("/factory/payroll-hub?section=employees")}
        data-testid="button-back"
        aria-label="Back to Employees"
      >
        <ArrowLeft className="h-4 w-4" />
      </Button>

      <div className="flex flex-col lg:flex-row gap-6 items-stretch lg:items-start">
        {/* Left Summary Card */}
        <div className="w-full lg:w-72 shrink-0 space-y-4">
          <Card>
            <CardContent className="p-5 space-y-4">
              <div className="flex flex-col items-center text-center gap-3">
                <Avatar className={`h-20 w-20 text-lg font-bold ${avatarColor}`}>
                  <AvatarFallback className={`text-lg font-bold ${avatarColor}`} data-testid="text-employee-avatar">
                    {getInitials(fullName)}
                  </AvatarFallback>
                </Avatar>
                <div>
                  <h2 className="font-bold text-lg leading-tight" data-testid="text-employee-name">
                    {fullName}
                  </h2>
                  {employee.department && <p className="text-sm text-muted-foreground mt-0.5">{employee.department}</p>}
                </div>
                <PersonStatusBadge active={employee.active} data-testid="badge-employee-status" />
              </div>

              <div className="border-t pt-3 space-y-2">
                <div className="flex items-center gap-2 text-sm">
                  <span className="text-muted-foreground text-xs">Code</span>
                  <span className="font-mono text-xs ml-auto" data-testid="text-employee-code">
                    {employee.code}
                  </span>
                </div>
                {employee.phone && (
                  <div className="flex items-center gap-2 text-sm">
                    <Phone className="h-3 w-3 text-muted-foreground shrink-0" />
                    <span className="text-xs ml-auto" data-testid="text-employee-phone">
                      {employee.phone}
                    </span>
                  </div>
                )}
                {employee.joinDate && (
                  <div className="flex items-center gap-2 text-sm">
                    <Calendar className="h-3 w-3 text-muted-foreground shrink-0" />
                    <span className="text-xs ml-auto">Joined {formatDate(employee.joinDate)}</span>
                  </div>
                )}
                <div className="flex items-center gap-2 text-sm">
                  <DollarSign className="h-3 w-3 text-muted-foreground shrink-0" />
                  <span className="text-xs font-mono ml-auto">{fmt(employee.monthlySalary)} / mo</span>
                </div>
              </div>

              <div className="border-t pt-3 space-y-2">
                <div className="text-center">
                  <div className="text-xs text-muted-foreground mb-1">Current Balance</div>
                  <div
                    className={`text-xl font-bold font-mono ${balance < 0 ? "text-red-600 dark:text-red-400" : balance > 0 ? "text-green-600 dark:text-green-400" : ""}`}
                    data-testid="text-employee-balance"
                  >
                    {fmt(employee.currentBalance)}
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-2 text-xs text-center">
                  <div>
                    <div className="text-muted-foreground">Deposits</div>
                    <div className="font-mono font-medium text-green-600 dark:text-green-400">
                      {fmt(employee.totalDeposits)}
                    </div>
                  </div>
                  <div>
                    <div className="text-muted-foreground">Withdrawn</div>
                    <div className="font-mono font-medium text-red-600 dark:text-red-400">
                      {fmt(employee.totalWithdrawals)}
                    </div>
                  </div>
                </div>
              </div>

              {recordChanges.allowed && (
                <div className="border-t pt-3 space-y-2">
                  <Button
                    variant="outline"
                    className="w-full"
                    onClick={() => {
                      setEditForm({
                        firstName: employee.firstName,
                        lastName: employee.lastName,
                        department: employee.department || "",
                        phone: employee.phone || "",
                        monthlySalary: employee.monthlySalary || "",
                      });
                      setEditOpen(true);
                    }}
                    data-testid="button-edit-employee"
                  >
                    <Pencil className="h-3.5 w-3.5 mr-2" />
                    Edit
                  </Button>
                  {isDeveloper && (
                    <Button
                      variant="outline"
                      className="w-full"
                      onClick={() => wrapAdminAction(() => recalcMutation.mutate(), "Recalculate Balance")}
                      disabled={recalcMutation.isPending}
                      data-testid="button-recalculate-balance"
                    >
                      {recalcMutation.isPending ? (
                        <Loader2 className="h-3.5 w-3.5 mr-2 animate-spin" />
                      ) : (
                        <RefreshCw className="h-3.5 w-3.5 mr-2" />
                      )}
                      Recalculate
                    </Button>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        <div className="flex-1 min-w-0">
          <Tabs value={activeTab} onValueChange={(value) => setRequestedTab(value as EmployeeDetailTab)}>
            <div className="erp-mobile-scroll-tabs mb-4 pb-1">
              <TabsList className="w-max min-w-full sm:min-w-0 sm:w-fit" aria-label="Factory employee details">
                <TabsTrigger value="profile" data-testid="tab-profile">
                  Profile
                </TabsTrigger>
                <TabsTrigger value="statement" data-testid="tab-statement">
                  Statement
                </TabsTrigger>
                {showAdvancesTab && (
                  <TabsTrigger value="advances" data-testid="tab-advances">
                    Advances
                  </TabsTrigger>
                )}
                {showAttendanceTab && (
                  <TabsTrigger value="attendance" data-testid="tab-attendance">
                    Attendance
                  </TabsTrigger>
                )}
              </TabsList>
            </div>

            <TabsContent value="profile" className="space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <PersonInfoCard title="Personal">
                  <PersonInfoRow label="First Name" value={employee.firstName} testId="text-detail-first-name" />
                  <PersonInfoRow label="Last Name" value={employee.lastName} testId="text-detail-last-name" />
                </PersonInfoCard>
                <PersonInfoCard title="Contact" icon={Phone}>
                  <PersonInfoRow label="Phone" value={employee.phone} testId="text-detail-phone" />
                </PersonInfoCard>
                <PersonInfoCard title="Employment" icon={Building}>
                  <PersonInfoRow label="Employee Code" value={employee.code} testId="text-detail-code" />
                  <PersonInfoRow label="Department" value={employee.department} testId="text-detail-department" />
                  <PersonInfoRow
                    label="Date Joined"
                    value={formatDate(employee.joinDate)}
                    testId="text-detail-joined"
                  />
                </PersonInfoCard>
                <PersonInfoCard title="Compensation" icon={CreditCard}>
                  <PersonInfoRow
                    label="Monthly Salary"
                    value={fmt(employee.monthlySalary)}
                    testId="text-detail-salary"
                  />
                  <PersonInfoRow label="Current Balance" value={fmt(employee.currentBalance)} />
                  <PersonInfoRow label="Total Deposits" value={fmt(employee.totalDeposits)} />
                  <PersonInfoRow label="Total Withdrawals" value={fmt(employee.totalWithdrawals)} />
                </PersonInfoCard>
              </div>
            </TabsContent>

            <TabsContent value="statement" className="space-y-4">
              <div className="flex justify-end">
                <ReportExportMenu
                  busy={exportBusy}
                  disabled={!statementRows.length}
                  data-testid="button-statement-export"
                  options={[
                    { id: "excel", label: "Excel", kind: "excel", onSelect: () => exportStatement("excel") },
                    { id: "pdf", label: "PDF", kind: "pdf", onSelect: () => exportStatement("pdf") },
                    { id: "print", label: "Print", kind: "print", onSelect: () => exportStatement("print") },
                  ]}
                />
              </div>
              <Card>
                <CardHeader className="pb-2 pt-4 px-5">
                  <CardTitle className="text-sm text-muted-foreground">Running Statement</CardTitle>
                </CardHeader>
                <CardContent className="px-5 pb-4 overflow-x-auto">
                  {stmtLoading ? (
                    <div className="space-y-2">
                      {[...Array(5)].map((_, i) => (
                        <Skeleton key={i} className="h-10 w-full" />
                      ))}
                    </div>
                  ) : stmtError && !statement ? (
                    <ErrorState onAction={() => void refetchStatement()} actionLabel="Try again" />
                  ) : statementRows.length === 0 ? (
                    <EmptyState title="No transactions yet" />
                  ) : (
                    <Table mobileLayout="cards">
                      <TableHeader className="sticky top-0 z-30 bg-background">
                        <TableRow>
                          <TableHead>Date</TableHead>
                          <TableHead>Voucher</TableHead>
                          <TableHead>Description</TableHead>
                          <TableHead className="text-right">Deposit</TableHead>
                          <TableHead className="text-right">Withdrawal</TableHead>
                          <TableHead className="text-right">Balance</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {statementRows.map((row) => (
                          <TableRow key={row.id} data-testid={`row-stmt-${row.id}`}>
                            <TableCell className="text-sm">{formatDate(row.voucherDate)}</TableCell>
                            <TableCell className="font-mono text-xs text-muted-foreground">
                              {row.voucherNumber}
                            </TableCell>
                            <TableCell className="text-sm" dir="ltr">
                              {row.narration || row.description || "—"}
                            </TableCell>
                            <TableCell className="text-right font-mono text-sm tabular-nums">
                              {row.credit > 0 ? (
                                <span className="text-green-600 dark:text-green-400">{fmt(row.credit)}</span>
                              ) : (
                                "—"
                              )}
                            </TableCell>
                            <TableCell className="text-right font-mono text-sm tabular-nums">
                              {row.debit > 0 ? (
                                <span className="text-red-600 dark:text-red-400">{fmt(row.debit)}</span>
                              ) : (
                                "—"
                              )}
                            </TableCell>
                            <TableCell
                              className={`text-right font-mono text-sm font-semibold tabular-nums ${row.balance < 0 ? "text-red-600 dark:text-red-400" : ""}`}
                            >
                              {fmt(row.balance)}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  )}
                </CardContent>
              </Card>
            </TabsContent>

            {showAdvancesTab && (
              <TabsContent value="advances" className="space-y-4">
                <EmployeeAdvancesCard employeeId={employee.id} formatDate={formatDate} formatAmount={fmt} />
              </TabsContent>
            )}

            {showAttendanceTab && (
              <TabsContent value="attendance" className="space-y-4">
                <PersonAttendancePanel
                  endpoint={`/api/factory/employee-attendance/employee/${employee.id}`}
                  personName={fullName}
                  kind="employee"
                  formatDate={formatDate}
                />
              </TabsContent>
            )}
          </Tabs>
        </div>
      </div>

      <PersonFormDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        title="Edit Employee"
        description="Update employee details"
        onSave={() => wrapAdminAction(() => updateMutation.mutate(editForm), "Save Employee")}
        saving={updateMutation.isPending}
        testIds={{ dialog: "dialog-edit-employee", cancel: "button-cancel-edit", save: "button-save-edit" }}
      >
        <EmployeeFormFields
          values={editForm}
          onChange={(key, value) => setEditForm((form) => ({ ...form, [key]: value }))}
          testIdPrefix="input-edit"
        />
      </PersonFormDialog>

      {/* Deposit Dialog */}
      <Dialog open={depositOpen} onOpenChange={setDepositOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>New Deposit for {fullName}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1">
              <Label>Amount *</Label>
              <Input
                type="number"
                min="0.01"
                step="0.01"
                value={depositAmount}
                onChange={(e) => setDepositAmount(e.target.value)}
                placeholder="0.00"
                data-testid="input-deposit-amount"
              />
            </div>
            <div className="space-y-1">
              <Label>Entry Date *</Label>
              <Input
                type="date"
                value={depositDate}
                onChange={(e) => setDepositDate(e.target.value)}
                data-testid="input-deposit-date"
              />
            </div>
            <div className="space-y-1">
              <Label>
                Effective Date <span className="text-muted-foreground">(optional — period it belongs to)</span>
              </Label>
              <Input
                type="date"
                value={depositEffectiveDate}
                onChange={(e) => setDepositEffectiveDate(e.target.value)}
                data-testid="input-deposit-effective-date"
              />
            </div>
            <div className="space-y-1">
              <Label>Notes</Label>
              <Input
                value={depositNotes}
                onChange={(e) => setDepositNotes(e.target.value)}
                placeholder="Optional notes"
                data-testid="input-deposit-notes"
              />
            </div>
            <div className="bg-muted/50 rounded-md p-3 text-sm space-y-1">
              <div className="font-medium text-xs text-muted-foreground mb-1">Accounting Entry</div>
              <div className="flex justify-between">
                <span>DR: Payroll Expense</span>
                <span className="font-mono">{fmt(depositAmount || 0)}</span>
              </div>
              <div className="flex justify-between">
                <span>CR: Employee Account ({employee.code})</span>
                <span className="font-mono">{fmt(depositAmount || 0)}</span>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDepositOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => wrapAdminAction(() => depositMutation.mutate(), "Post Deposit")}
              disabled={depositMutation.isPending || !depositAmount}
              data-testid="button-confirm-deposit"
            >
              {depositMutation.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Posting...
                </>
              ) : (
                <>
                  <TrendingUp className="h-4 w-4 mr-2" />
                  Post Deposit
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Withdrawal Dialog */}
      <Dialog open={withdrawOpen} onOpenChange={setWithdrawOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>New Withdrawal for {fullName}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1">
              <Label>Amount *</Label>
              <Input
                type="number"
                min="0.01"
                step="0.01"
                value={withdrawAmount}
                onChange={(e) => setWithdrawAmount(e.target.value)}
                placeholder="0.00"
                data-testid="input-withdraw-amount"
              />
            </div>
            <div className="space-y-1">
              <Label>Date *</Label>
              <Input
                type="date"
                value={withdrawDate}
                onChange={(e) => setWithdrawDate(e.target.value)}
                data-testid="input-withdraw-date"
              />
            </div>
            <div className="space-y-1">
              <Label>Cash Account *</Label>
              <Select value={withdrawCashAccountId} onValueChange={setWithdrawCashAccountId}>
                <SelectTrigger data-testid="select-cash-account">
                  <SelectValue placeholder="Select cash account" />
                </SelectTrigger>
                <SelectContent>
                  {cashAccounts.map((a) => (
                    <SelectItem key={a.id} value={String(a.id)} data-testid={`option-cash-${a.id}`}>
                      {a.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>Notes</Label>
              <Input
                value={withdrawNotes}
                onChange={(e) => setWithdrawNotes(e.target.value)}
                placeholder="Optional notes"
                data-testid="input-withdraw-notes"
              />
            </div>
            <div className="bg-muted/50 rounded-md p-3 text-sm space-y-1">
              <div className="font-medium text-xs text-muted-foreground mb-1">Accounting Entry</div>
              <div className="flex justify-between">
                <span>DR: Employee Account ({employee.code})</span>
                <span className="font-mono">{fmt(withdrawAmount || 0)}</span>
              </div>
              <div className="flex justify-between">
                <span>CR: Cash</span>
                <span className="font-mono">{fmt(withdrawAmount || 0)}</span>
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              Note: Withdrawals are allowed even if they result in a negative balance.
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setWithdrawOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => wrapAdminAction(() => withdrawMutation.mutate(), "Post Withdrawal")}
              disabled={withdrawMutation.isPending || !withdrawAmount || !withdrawCashAccountId}
              data-testid="button-confirm-withdraw"
            >
              {withdrawMutation.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Posting...
                </>
              ) : (
                <>
                  <TrendingDown className="h-4 w-4 mr-2" />
                  Post Withdrawal
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {AdminDialog}
    </div>
  );
}
