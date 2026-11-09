import { searchAny } from "@shared/searchNormalization";
import { useExistingRecordChangeAccess } from "@/hooks/useExistingRecordChangeAccess";
import type { ClientErrorLike } from "@/lib/clientError";
import { useState, useMemo, useRef, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useLocation } from "wouter";
import {
  Shield,
  Plus,
  Edit,
  ToggleLeft,
  ToggleRight,
  Trash2,
  DollarSign,
  Users,
  UserCheck,
  Loader2,
  Receipt,
  Search,
  BookOpen,
  FileSpreadsheet,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { useDateFormat } from "@/contexts/DateFormatContext";
import { useCompany } from "@/contexts/CompanyContext";

import type { InsuranceMember } from "./factoryinsurance/types";

interface LedgerAccountOption {
  id: number;
  name: string;
  code?: string | null;
}
import { MONTHS, YEARS } from "./factoryinsurance/utils";
import { MemberFormDialog } from "./factoryinsurance/components/MemberFormDialog";
import { MemberStatementDrawer } from "./factoryinsurance/components/MemberStatementDrawer";
import { InsuranceImportDialog } from "./factoryinsurance/components/InsuranceImportDialog";
import { InsuranceClearDialog } from "./factoryinsurance/components/InsuranceClearDialog";
export default function FactoryInsurance() {
  const { toast } = useToast();
  const recordChanges = useExistingRecordChangeAccess();
  const { formatDisplayDate } = useDateFormat();
  const { selectedCompany } = useCompany();
  const [, navigate] = useLocation();

  const [includeInactive, setIncludeInactive] = useState(false);
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [editMember, setEditMember] = useState<InsuranceMember | null>(null);
  const [statementMember, setStatementMember] = useState<InsuranceMember | null>(null);
  const [deleteMember, setDeleteMember] = useState<InsuranceMember | null>(null);
  const [search, setSearch] = useState("");
  const [showImportDialog, setShowImportDialog] = useState(false);
  const [showClearDialog, setShowClearDialog] = useState(false);

  const [showGenDialog, setShowGenDialog] = useState(false);
  const [genMonth, setGenMonth] = useState(new Date().getMonth() + 1);
  const [genYear, setGenYear] = useState(new Date().getFullYear());

  // ── Extra Charges ───────────────────────────────────────────────────────────
  const [showExtraCharges, setShowExtraCharges] = useState(false);
  const [ecDate, setEcDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [ecAmount, setEcAmount] = useState("");
  const [ecDrId, setEcDrId] = useState<number | null>(null);
  const [ecCrId, setEcCrId] = useState<number | null>(null);
  const [ecDrSearch, setEcDrSearch] = useState("");
  const [ecCrSearch, setEcCrSearch] = useState("");
  const [ecDrOpen, setEcDrOpen] = useState(false);
  const [ecCrOpen, setEcCrOpen] = useState(false);
  const [ecNotes, setEcNotes] = useState("");
  const ecDrRef = useRef<HTMLDivElement>(null);
  const ecCrRef = useRef<HTMLDivElement>(null);
  // Reuse the request ID when retrying an unchanged form after a network error.
  const extraChargeRequestRef = useRef<{ fingerprint: string; id: string } | null>(null);

  const { data: ledgerAccounts = [] } = useQuery<LedgerAccountOption[]>({
    queryKey: ["/api/ledger-accounts?includeHidden=true&profile=picker"],
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

  // Find the Insurance Expense account dynamically from the fetched accounts list
  const insuranceExpenseAccount = useMemo(
    () => ledgerAccounts.find((a) => a.name === "Insurance Expense"),
    [ledgerAccounts]
  );
  const { data: insExpenseBalance } = useQuery<{ balance: number }>({
    queryKey: ["/api/accounts/ledger", insuranceExpenseAccount?.id, "balance"],
    queryFn: async () => {
      const res = await fetch(`/api/accounts/ledger/${insuranceExpenseAccount!.id}/balance`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to fetch balance");
      return res.json();
    },
    enabled: !!insuranceExpenseAccount?.id,
    staleTime: 30_000,
  });

  const extraChargesMutation = useMutation({
    mutationFn: async () => {
      if (!recordChanges.allowed) throw new Error(recordChanges.reason ?? "");
      const amt = parseFloat(ecAmount);
      if (!ecDrId || !ecCrId || isNaN(amt) || amt <= 0) throw new Error("Fill in all fields with a valid amount.");
      if (ecDrId === ecCrId) throw new Error("Debit and credit accounts must be different.");
      const fingerprint = JSON.stringify([ecDate, amt.toFixed(2), ecDrId, ecCrId, ecNotes]);
      if (extraChargeRequestRef.current?.fingerprint !== fingerprint) {
        extraChargeRequestRef.current = { fingerprint, id: crypto.randomUUID() };
      }
      return apiRequest("POST", "/api/insurance/extra-charges", {
        voucherDate: ecDate,
        amount: amt.toFixed(2),
        debitAccountId: ecDrId,
        creditAccountId: ecCrId,
        notes: ecNotes,
        clientRequestId: extraChargeRequestRef.current.id,
      });
    },
    onSuccess: () => {
      extraChargeRequestRef.current = null;
      queryClient.invalidateQueries({ queryKey: ["/api/accounts/ledger"] });
      queryClient.invalidateQueries({ queryKey: ["/api/vouchers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/daybook"] });
      setShowExtraCharges(false);
      setEcAmount("");
      setEcDrId(null);
      setEcCrId(null);
      setEcDrSearch("");
      setEcCrSearch("");
      setEcNotes("");
      setEcDate(new Date().toISOString().slice(0, 10));
      toast({ title: "Extra charge posted", description: "Voucher created and visible in Daybook & Accounts." });
    },
    onError: (e: ClientErrorLike) => toast({ title: "Failed", description: e.message, variant: "destructive" }),
  });

  // Close account dropdowns on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ecDrRef.current && !ecDrRef.current.contains(e.target as Node)) setEcDrOpen(false);
      if (ecCrRef.current && !ecCrRef.current.contains(e.target as Node)) setEcCrOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const {
    data: members = [],
    isLoading,
    isError,
    error: membersError,
  } = useQuery<InsuranceMember[]>({
    queryKey: ["/api/insurance/members", selectedCompany?.id, includeInactive],
    queryFn: async () => {
      const params = new URLSearchParams({ includeInactive: String(includeInactive) });
      const res = await fetch(`/api/insurance/members?${params}`, { credentials: "include" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.message || `Failed to load members (${res.status})`);
      }
      return res.json();
    },
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
  });

  const toggleMutation = useMutation({
    mutationFn: async (member: InsuranceMember) => {
      if (!recordChanges.allowed) throw new Error(recordChanges.reason ?? "");
      return apiRequest("PATCH", `/api/insurance/members/${member.id}/toggle`, {});
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/insurance/members"] });
      toast({ title: "Status updated" });
    },
    onError: (e: ClientErrorLike) => {
      toast({ title: "Failed", description: e.message, variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: number) => {
      if (!recordChanges.allowed) throw new Error(recordChanges.reason ?? "");
      return apiRequest("DELETE", `/api/insurance/members/${id}`, undefined);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/insurance/members"] });
      toast({ title: "Member deleted" });
      setDeleteMember(null);
    },
    onError: (e: ClientErrorLike) => {
      toast({ title: "Failed to delete", description: e.message, variant: "destructive" });
    },
  });

  const generateMutation = useMutation({
    mutationFn: async () => {
      if (!recordChanges.allowed) throw new Error(recordChanges.reason ?? "");
      const res = await apiRequest("POST", "/api/insurance/generate", {
        month: genMonth,
        year: genYear,
      });
      return res.json();
    },
    onSuccess: (data) => {
      setShowGenDialog(false);
      toast({
        title: `Insurance entries posted — ${data.period}`,
        description: (
          <span>
            {data.membersCount} member(s) · Total ${parseFloat(data.totalAmount).toFixed(2)}{" "}
            <button className="underline font-medium ml-1" onClick={() => navigate("/factory/daybook")}>
              View in Daybook
            </button>
          </span>
        ),
      });
    },
    onError: (e: ClientErrorLike) => {
      toast({ title: "Generation failed", description: e.message, variant: "destructive" });
    },
  });

  const filteredMembers = useMemo(() => {
    if (!search.trim()) return members;
    return members.filter((m) => searchAny(search, m.name, m.nationality, m.positionWorking));
  }, [members, search]);

  const stats = useMemo(() => {
    const active = members.filter((m) => m.active);
    const inactive = members.filter((m) => !m.active);
    const totalAmount = active.reduce((s, m) => s + parseFloat(m.amount || "0"), 0);
    return { total: members.length, active: active.length, inactive: inactive.length, totalAmount };
  }, [members]);
  const canClearInsurance = selectedCompany?.role === "Admin" || selectedCompany?.role === "Developer";

  return (
    <div className="space-y-5 px-3 pb-6 pt-3 sm:px-6 sm:pt-5">
      <section className="relative overflow-hidden rounded-[26px] border border-blue-200/70 bg-gradient-to-br from-white via-blue-50/80 to-slate-50 shadow-sm dark:border-blue-500/25 dark:from-[#101f39] dark:via-[#10264a] dark:to-[#071427]">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -right-24 -top-32 h-80 w-96 rounded-full bg-blue-400/15 blur-3xl dark:bg-blue-500/25"
        />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute bottom-0 right-0 h-px w-3/4 bg-gradient-to-l from-sky-400/70 via-blue-400/20 to-transparent"
        />
        <div className="relative space-y-5 p-4 sm:p-6">
          <div className="flex items-center gap-4">
            <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl border border-blue-400/30 bg-gradient-to-br from-sky-400 to-blue-700 text-white shadow-lg shadow-blue-600/20">
              <Shield className="h-7 w-7" aria-hidden="true" />
            </div>
            <div className="min-w-0">
              <h2 className="text-2xl font-bold tracking-tight text-slate-950 dark:text-white sm:text-3xl">
                Insurance
              </h2>
              <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
                Manage insurance members and generate monthly entries
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {recordChanges.allowed && canClearInsurance && (
              <Button
                variant="destructive"
                className="rounded-xl border border-red-400/30 bg-red-600 text-white shadow-sm shadow-red-700/15 hover:bg-red-700"
                onClick={() => setShowClearDialog(true)}
                data-testid="button-clear-all-insurance"
              >
                <Trash2 className="h-4 w-4 mr-1" />
                Clear All
              </Button>
            )}
            {recordChanges.allowed && (
              <>
                <Button
                  variant="outline"
                  className="rounded-xl border-slate-300/80 bg-white/75 text-slate-800 shadow-sm hover:bg-blue-50 dark:border-slate-600/80 dark:bg-slate-900/70 dark:text-slate-100 dark:hover:bg-blue-950/80"
                  onClick={() => setShowImportDialog(true)}
                  data-testid="button-import-insurance"
                >
                  <FileSpreadsheet className="h-4 w-4 mr-1" />
                  Import Excel
                </Button>
                <Button
                  variant="outline"
                  className="rounded-xl border-slate-300/80 bg-white/75 text-slate-800 shadow-sm hover:bg-blue-50 dark:border-slate-600/80 dark:bg-slate-900/70 dark:text-slate-100 dark:hover:bg-blue-950/80"
                  onClick={() => setShowExtraCharges(true)}
                  data-testid="button-extra-charges"
                >
                  <Receipt className="h-4 w-4 mr-1" />
                  Add Extra Charges
                </Button>
                <Button
                  className="rounded-xl bg-gradient-to-r from-blue-700 to-blue-500 text-white shadow-md shadow-blue-700/20 hover:from-blue-800 hover:to-blue-600"
                  onClick={() => setShowGenDialog(true)}
                  data-testid="button-generate-entries"
                >
                  <DollarSign className="h-4 w-4 mr-1" />
                  Generate Entries
                </Button>
              </>
            )}
            {recordChanges.canCreate("POST", "/api/insurance/members") && (
              <Button
                variant="outline"
                className="rounded-xl border-blue-300 bg-blue-50 text-blue-900 shadow-sm hover:bg-blue-100 dark:border-blue-500/40 dark:bg-blue-500/15 dark:text-blue-100 dark:hover:bg-blue-500/25"
                onClick={() => setShowAddDialog(true)}
                data-testid="button-add-member"
              >
                <Plus className="h-4 w-4 mr-1" />
                Add Member
              </Button>
            )}
          </div>
        </div>
      </section>

      {/* Stats */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Card className="relative overflow-hidden rounded-2xl border-blue-200 bg-gradient-to-br from-blue-50 via-white to-blue-100/70 shadow-sm dark:border-blue-500/40 dark:from-[#133861] dark:via-[#0e2b4e] dark:to-[#0b1e38]">
          <CardContent className="p-5">
            <div className="flex items-center gap-3">
              <Users className="h-10 w-10 shrink-0 rounded-xl bg-blue-500/15 p-2 text-blue-600 dark:bg-blue-400/20 dark:text-sky-300" />
              <span className="text-sm font-medium text-slate-600 dark:text-slate-200">Total Members</span>
            </div>
            <div
              className="mt-2 text-3xl font-bold tracking-tight text-blue-900 dark:text-sky-100"
              data-testid="stat-total"
            >
              {stats.total}
            </div>
          </CardContent>
        </Card>
        <Card className="relative overflow-hidden rounded-2xl border-emerald-200 bg-gradient-to-br from-emerald-50 via-white to-emerald-100/70 shadow-sm dark:border-emerald-500/40 dark:from-[#0e443f] dark:via-[#0c3335] dark:to-[#0b242f]">
          <CardContent className="p-5">
            <div className="flex items-center gap-3">
              <UserCheck className="h-10 w-10 shrink-0 rounded-xl bg-emerald-500/15 p-2 text-emerald-600 dark:bg-emerald-400/20 dark:text-emerald-300" />
              <span className="text-sm font-medium text-slate-600 dark:text-slate-200">Active</span>
            </div>
            <div
              className="mt-2 text-3xl font-bold tracking-tight text-emerald-700 dark:text-emerald-300"
              data-testid="stat-active"
            >
              {stats.active}
            </div>
          </CardContent>
        </Card>
        <Card className="relative overflow-hidden rounded-2xl border-violet-200 bg-gradient-to-br from-violet-50 via-white to-violet-100/70 shadow-sm dark:border-violet-500/40 dark:from-[#3b265e] dark:via-[#2b204c] dark:to-[#171d3b]">
          <CardContent className="p-5">
            <div className="flex items-center gap-3">
              <DollarSign className="h-10 w-10 shrink-0 rounded-xl bg-violet-500/15 p-2 text-violet-600 dark:bg-violet-400/20 dark:text-violet-300" />
              <span className="text-sm font-medium text-slate-600 dark:text-slate-200">Monthly Total</span>
            </div>
            <div
              className="mt-2 text-3xl font-bold tracking-tight text-violet-900 dark:text-violet-100"
              data-testid="stat-amount"
            >
              ${stats.totalAmount % 1 === 0 ? stats.totalAmount.toFixed(0) : stats.totalAmount.toFixed(2)}
            </div>
          </CardContent>
        </Card>
        <Card
          className={`relative overflow-hidden rounded-2xl border-amber-200 bg-gradient-to-br from-amber-50 via-white to-amber-100/70 shadow-sm dark:border-amber-500/40 dark:from-[#573b1d] dark:via-[#3a2b24] dark:to-[#222433] ${insuranceExpenseAccount ? "cursor-pointer transition-all hover:ring-2 hover:ring-amber-500/30" : ""}`}
          onClick={() =>
            insuranceExpenseAccount &&
            window.open(`/factory/accounts?accountId=${insuranceExpenseAccount.id}&accountType=ledger`, "_blank")
          }
        >
          <CardContent className="p-5">
            <div className="flex items-center gap-3">
              <BookOpen className="h-10 w-10 shrink-0 rounded-xl bg-amber-500/15 p-2 text-amber-600 dark:bg-amber-400/20 dark:text-amber-300" />
              <span className="text-sm font-medium text-slate-600 dark:text-slate-200">Insurance Expense</span>
            </div>
            <div
              className="mt-2 font-mono text-3xl font-bold tracking-tight text-amber-900 dark:text-amber-100"
              data-testid="stat-expense-balance"
            >
              {insExpenseBalance != null
                ? (() => {
                    const v = Math.abs(insExpenseBalance.balance);
                    return `${v % 1 === 0 ? v.toFixed(0) : v.toFixed(2)}`;
                  })()
                : "—"}
            </div>
            {insExpenseBalance != null && (
              <div className="text-xs text-muted-foreground mt-0.5">
                {insExpenseBalance.balance <= 0 ? "Cr balance" : "Dr balance"}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-slate-200 bg-white/80 p-3 shadow-sm dark:border-slate-700/70 dark:bg-[#0e1c31]/85">
        <div className="relative min-w-[220px] flex-1">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400"
            aria-hidden="true"
          />
          <Input
            placeholder="Search by name, nationality, position..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-11 w-full rounded-xl border-slate-200 bg-slate-50 pl-10 dark:border-slate-600 dark:bg-slate-900/80"
            data-testid="input-search"
          />
        </div>
        <div className="flex items-center gap-2 rounded-xl px-2 py-1">
          <Switch
            id="show-inactive"
            checked={includeInactive}
            onCheckedChange={setIncludeInactive}
            data-testid="switch-show-inactive"
          />
          <Label htmlFor="show-inactive" className="text-sm cursor-pointer">
            Show inactive
          </Label>
        </div>
      </div>

      {/* Members Table — cosmetic treatment only; all member actions and data sources are unchanged. */}
      <Card className="overflow-hidden rounded-2xl border-slate-200 bg-white shadow-sm dark:border-slate-700/70 dark:bg-[#0b1729] dark:shadow-lg dark:shadow-blue-950/20">
        <CardContent className="overflow-x-auto p-0">
          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : isError ? (
            <div className="flex flex-col items-center justify-center py-12 text-destructive gap-2">
              <Shield className="h-10 w-10 mb-2 opacity-30" />
              <p className="text-sm font-medium">Failed to load insurance members</p>
              <p className="text-xs text-muted-foreground max-w-xs text-center">
                {(membersError as Error)?.message || "Unknown error"}
              </p>
              <Button
                size="sm"
                variant="outline"
                className="mt-1"
                onClick={() => queryClient.invalidateQueries({ queryKey: ["/api/insurance/members"] })}
              >
                Retry
              </Button>
            </div>
          ) : filteredMembers.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
              <Shield className="h-10 w-10 mb-2 opacity-30" />
              <p className="text-sm">
                {members.length === 0
                  ? "No insurance members yet. Add one to get started."
                  : "No members match your search."}
              </p>
            </div>
          ) : (
            <Table className="min-w-[1140px]">
              <TableHeader className="bg-slate-100/90 dark:bg-[#1c2e49]">
                <TableRow className="border-slate-200 hover:bg-transparent dark:border-slate-700/70 dark:hover:bg-transparent">
                  <TableHead className="h-12 whitespace-nowrap text-[11px] font-bold uppercase tracking-wide text-slate-600 dark:text-slate-200">
                    Name
                  </TableHead>
                  <TableHead className="h-12 whitespace-nowrap text-[11px] font-bold uppercase tracking-wide text-slate-600 dark:text-slate-200">
                    Insurance No.
                  </TableHead>
                  <TableHead className="h-12 whitespace-nowrap text-[11px] font-bold uppercase tracking-wide text-slate-600 dark:text-slate-200">
                    Nationality
                  </TableHead>
                  <TableHead className="h-12 whitespace-nowrap text-[11px] font-bold uppercase tracking-wide text-slate-600 dark:text-slate-200">
                    Position
                  </TableHead>
                  <TableHead className="h-12 whitespace-nowrap text-[11px] font-bold uppercase tracking-wide text-slate-600 dark:text-slate-200">
                    Start Date
                  </TableHead>
                  <TableHead className="h-12 whitespace-nowrap text-[11px] font-bold uppercase tracking-wide text-slate-600 dark:text-slate-200">
                    Date of Birth
                  </TableHead>
                  <TableHead className="h-12 whitespace-nowrap text-right text-[11px] font-bold uppercase tracking-wide text-slate-600 dark:text-slate-200">
                    Monthly Amount
                  </TableHead>
                  <TableHead className="h-12 whitespace-nowrap text-[11px] font-bold uppercase tracking-wide text-slate-600 dark:text-slate-200">
                    Status
                  </TableHead>
                  <TableHead className="h-12 whitespace-nowrap text-right text-[11px] font-bold uppercase tracking-wide text-slate-600 dark:text-slate-200">
                    Actions
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredMembers.map((m) => (
                  <TableRow
                    key={m.id}
                    className="cursor-pointer border-slate-100 transition-colors even:bg-slate-50/80 hover:bg-blue-50/80 dark:border-slate-700/60 dark:even:bg-[#17263d]/55 dark:hover:bg-blue-900/25"
                    onClick={() => setStatementMember(m)}
                    data-testid={`row-member-${m.id}`}
                  >
                    <TableCell className="whitespace-nowrap font-semibold text-slate-900 dark:text-slate-100">
                      {m.name}
                    </TableCell>
                    <TableCell className="font-mono text-sm text-slate-700 dark:text-slate-200">
                      {m.insuranceNumber || "—"}
                    </TableCell>
                    <TableCell>
                      <span
                        className={
                          m.nationality
                            ? `inline-flex rounded-lg px-2.5 py-1 text-xs font-semibold ${m.nationality.toLowerCase() === "lebanese" ? "bg-violet-100 text-violet-800 dark:bg-violet-500/20 dark:text-violet-200" : "bg-blue-100 text-blue-800 dark:bg-blue-500/20 dark:text-blue-200"}`
                            : "text-muted-foreground"
                        }
                      >
                        {m.nationality || "—"}
                      </span>
                    </TableCell>
                    <TableCell className="text-muted-foreground">{m.positionWorking || "—"}</TableCell>
                    <TableCell>{formatDisplayDate(m.startDate)}</TableCell>
                    <TableCell>{m.dob ? formatDisplayDate(m.dob) : "—"}</TableCell>
                    <TableCell className="text-right font-mono font-semibold text-slate-900 dark:text-slate-100">
                      ${parseFloat(m.amount).toFixed(2)}
                    </TableCell>
                    <TableCell>
                      {m.active ? (
                        <Badge
                          variant="secondary"
                          className="gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-emerald-700 dark:border-emerald-500/25 dark:bg-emerald-500/15 dark:text-emerald-300"
                          data-testid={`badge-status-${m.id}`}
                        >
                          <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-emerald-500" /> Active
                        </Badge>
                      ) : (
                        <Badge
                          variant="outline"
                          className="rounded-full text-muted-foreground"
                          data-testid={`badge-status-${m.id}`}
                        >
                          Inactive
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      {recordChanges.allowed && (
                        <div className="flex items-center justify-end gap-1" onClick={(e) => e.stopPropagation()}>
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-8 w-8 rounded-lg border border-slate-200 bg-slate-50/70 hover:bg-blue-100 dark:border-slate-600/70 dark:bg-slate-800/60 dark:hover:bg-slate-700"
                            onClick={() => setEditMember(m)}
                            title="Edit member"
                            data-testid={`button-edit-${m.id}`}
                          >
                            <Edit className="h-4 w-4" />
                          </Button>
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-8 w-8 rounded-lg border border-slate-200 bg-slate-50/70 hover:bg-blue-100 dark:border-slate-600/70 dark:bg-slate-800/60 dark:hover:bg-slate-700"
                            onClick={() => toggleMutation.mutate(m)}
                            title={m.active ? "Deactivate" : "Activate"}
                            data-testid={`button-toggle-${m.id}`}
                          >
                            {m.active ? (
                              <ToggleRight className="h-4 w-4 text-green-600" />
                            ) : (
                              <ToggleLeft className="h-4 w-4 text-muted-foreground" />
                            )}
                          </Button>
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-8 w-8 rounded-lg border border-slate-200 bg-slate-50/70 hover:bg-blue-100 dark:border-slate-600/70 dark:bg-slate-800/60 dark:hover:bg-slate-700"
                            onClick={() => setDeleteMember(m)}
                            title="Delete member"
                            data-testid={`button-delete-${m.id}`}
                          >
                            <Trash2 className="h-4 w-4 text-destructive" />
                          </Button>
                        </div>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Member Statement Drawer */}
      {statementMember && <MemberStatementDrawer member={statementMember} onClose={() => setStatementMember(null)} />}

      <InsuranceImportDialog open={showImportDialog} onClose={() => setShowImportDialog(false)} />
      <InsuranceClearDialog
        open={showClearDialog}
        companyName={selectedCompany?.name}
        onClose={() => setShowClearDialog(false)}
      />

      {/* Add / Edit Member Dialog */}
      {(showAddDialog || editMember) && (
        <MemberFormDialog
          open={showAddDialog || !!editMember}
          onClose={() => {
            setShowAddDialog(false);
            setEditMember(null);
          }}
          existing={editMember}
        />
      )}

      {/* Delete Confirmation Dialog */}
      <Dialog open={!!deleteMember} onOpenChange={(v) => !v && setDeleteMember(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete Member</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Permanently delete <span className="font-semibold text-foreground">{deleteMember?.name}</span>? This cannot
            be undone.
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteMember(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => deleteMember && deleteMutation.mutate(deleteMember.id)}
              disabled={deleteMutation.isPending}
              data-testid="button-confirm-delete"
            >
              {deleteMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Extra Charges Dialog */}
      <Dialog
        open={showExtraCharges}
        onOpenChange={(v) => {
          if (!v) setShowExtraCharges(false);
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Add Extra Charges</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-1">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label>Date</Label>
                <Input type="date" value={ecDate} onChange={(e) => setEcDate(e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label>Amount</Label>
                <Input
                  type="number"
                  min="0"
                  step="0.01"
                  placeholder="0.00"
                  value={ecAmount}
                  onChange={(e) => setEcAmount(e.target.value)}
                />
              </div>
            </div>
            {/* DR Account */}
            <div className="space-y-1" ref={ecDrRef}>
              <Label>Debit Account (Dr)</Label>
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
                <Input
                  className="pl-8"
                  placeholder="Search account name…"
                  value={ecDrSearch}
                  onFocus={() => setEcDrOpen(true)}
                  onChange={(e) => {
                    setEcDrSearch(e.target.value);
                    setEcDrId(null);
                    setEcDrOpen(true);
                  }}
                />
                {ecDrOpen && (
                  <div className="absolute z-50 mt-1 w-full max-h-48 overflow-y-auto rounded-md border bg-popover shadow-md text-sm">
                    {ledgerAccounts
                      .filter((a) => a.name.toLowerCase().includes(ecDrSearch.toLowerCase()))
                      .slice(0, 60)
                      .map((a) => (
                        <div
                          key={a.id}
                          className="px-3 py-2 cursor-pointer hover:bg-muted"
                          onMouseDown={() => {
                            setEcDrId(a.id);
                            setEcDrSearch(a.name);
                            setEcDrOpen(false);
                          }}
                        >
                          {a.name}
                        </div>
                      ))}
                    {ledgerAccounts.filter((a) => searchAny(ecDrSearch, a.name, a.code)).length === 0 && (
                      <div className="px-3 py-2 text-muted-foreground italic">No accounts found</div>
                    )}
                  </div>
                )}
              </div>
            </div>
            {/* CR Account */}
            <div className="space-y-1" ref={ecCrRef}>
              <Label>Credit Account (Cr)</Label>
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
                <Input
                  className="pl-8"
                  placeholder="Search account name…"
                  value={ecCrSearch}
                  onFocus={() => setEcCrOpen(true)}
                  onChange={(e) => {
                    setEcCrSearch(e.target.value);
                    setEcCrId(null);
                    setEcCrOpen(true);
                  }}
                />
                {ecCrOpen && (
                  <div className="absolute z-50 mt-1 w-full max-h-48 overflow-y-auto rounded-md border bg-popover shadow-md text-sm">
                    {ledgerAccounts
                      .filter((a) => a.name.toLowerCase().includes(ecCrSearch.toLowerCase()))
                      .slice(0, 60)
                      .map((a) => (
                        <div
                          key={a.id}
                          className="px-3 py-2 cursor-pointer hover:bg-muted"
                          onMouseDown={() => {
                            setEcCrId(a.id);
                            setEcCrSearch(a.name);
                            setEcCrOpen(false);
                          }}
                        >
                          {a.name}
                        </div>
                      ))}
                    {ledgerAccounts.filter((a) => searchAny(ecCrSearch, a.name, a.code)).length === 0 && (
                      <div className="px-3 py-2 text-muted-foreground italic">No accounts found</div>
                    )}
                  </div>
                )}
              </div>
            </div>
            {/* Notes */}
            <div className="space-y-1">
              <Label>
                Notes <span className="text-xs text-muted-foreground">(saved as voucher description)</span>
              </Label>
              <Textarea
                placeholder="e.g. Extra insurance charge — July 2026"
                value={ecNotes}
                onChange={(e) => setEcNotes(e.target.value)}
                rows={2}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowExtraCharges(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => extraChargesMutation.mutate()}
              disabled={extraChargesMutation.isPending || !ecDrId || !ecCrId || !ecAmount || ecDrId === ecCrId}
              data-testid="button-extra-charges-submit"
            >
              {extraChargesMutation.isPending && <Loader2 className="h-4 w-4 animate-spin mr-1" />}
              Post Voucher
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Generate Entries Dialog */}
      <Dialog open={showGenDialog} onOpenChange={(v) => !v && setShowGenDialog(false)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Generate Insurance Entries</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Posts a journal voucher for all active members: Dr Insurance Expense / Cr each member's personal account.
              Members whose start date falls within the month are prorated.
            </p>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label>Month</Label>
                <Select value={String(genMonth)} onValueChange={(v) => setGenMonth(parseInt(v))}>
                  <SelectTrigger data-testid="select-gen-month">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {MONTHS.map((m, i) => (
                      <SelectItem key={i + 1} value={String(i + 1)}>
                        {m}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label>Year</Label>
                <Select value={String(genYear)} onValueChange={(v) => setGenYear(parseInt(v))}>
                  <SelectTrigger data-testid="select-gen-year">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {YEARS.map((y) => (
                      <SelectItem key={y} value={String(y)}>
                        {y}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowGenDialog(false)} data-testid="button-cancel-gen">
              Cancel
            </Button>
            <Button
              onClick={() => generateMutation.mutate()}
              disabled={generateMutation.isPending}
              data-testid="button-confirm-gen"
            >
              {generateMutation.isPending && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
              Generate
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
