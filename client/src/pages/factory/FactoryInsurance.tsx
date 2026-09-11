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
import { PageHeader } from "@/components/PageHeader";
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
}
import { MONTHS, YEARS } from "./factoryinsurance/utils";
import { MemberFormDialog } from "./factoryinsurance/components/MemberFormDialog";
import { MemberStatementDrawer } from "./factoryinsurance/components/MemberStatementDrawer";
import { InsuranceImportDialog } from "./factoryinsurance/components/InsuranceImportDialog";
import { InsuranceClearDialog } from "./factoryinsurance/components/InsuranceClearDialog";
export default function FactoryInsurance() {
  const { toast } = useToast();
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

  const { data: ledgerAccounts = [] } = useQuery<LedgerAccountOption[]>({
    queryKey: ["/api/ledger-accounts?includeHidden=true"],
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
      const amt = parseFloat(ecAmount);
      if (!ecDrId || !ecCrId || isNaN(amt) || amt <= 0) throw new Error("Fill in all fields with a valid amount.");
      if (ecDrId === ecCrId) throw new Error("Debit and credit accounts must be different.");
      return apiRequest("POST", "/api/vouchers/with-entries", {
        voucher: {
          voucherType: "Journal",
          voucherDate: ecDate,
          voucherNumber: `INS-CHARGE-${Date.now()}`,
          description: ecNotes || "Insurance extra charge",
          optional: false,
        },
        entries: [
          { ledgerAccountId: ecDrId, debitAmount: amt.toFixed(2), creditAmount: "0", narration: ecNotes || null },
          { ledgerAccountId: ecCrId, debitAmount: "0", creditAmount: amt.toFixed(2), narration: ecNotes || null },
        ],
      });
    },
    onSuccess: () => {
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
    const q = search.toLowerCase();
    return members.filter(
      (m) =>
        m.name.toLowerCase().includes(q) ||
        (m.nationality || "").toLowerCase().includes(q) ||
        (m.positionWorking || "").toLowerCase().includes(q)
    );
  }, [members, search]);

  const stats = useMemo(() => {
    const active = members.filter((m) => m.active);
    const inactive = members.filter((m) => !m.active);
    const totalAmount = active.reduce((s, m) => s + parseFloat(m.amount || "0"), 0);
    return { total: members.length, active: active.length, inactive: inactive.length, totalAmount };
  }, [members]);
  const canClearInsurance = selectedCompany?.role === "Admin" || selectedCompany?.role === "Developer";

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <PageHeader title="Insurance" subtitle="Manage insurance members and generate monthly entries" />
        <div className="flex items-center gap-2 flex-wrap">
          {canClearInsurance && (
            <Button
              variant="destructive"
              onClick={() => setShowClearDialog(true)}
              data-testid="button-clear-all-insurance"
            >
              <Trash2 className="h-4 w-4 mr-1" />
              Clear All
            </Button>
          )}
          <Button variant="outline" onClick={() => setShowImportDialog(true)} data-testid="button-import-insurance">
            <FileSpreadsheet className="h-4 w-4 mr-1" />
            Import Excel
          </Button>
          <Button variant="outline" onClick={() => setShowExtraCharges(true)} data-testid="button-extra-charges">
            <Receipt className="h-4 w-4 mr-1" />
            Add Extra Charges
          </Button>
          <Button onClick={() => setShowGenDialog(true)} data-testid="button-generate-entries">
            <DollarSign className="h-4 w-4 mr-1" />
            Generate Entries
          </Button>
          <Button variant="outline" onClick={() => setShowAddDialog(true)} data-testid="button-add-member">
            <Plus className="h-4 w-4 mr-1" />
            Add Member
          </Button>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Card>
          <CardContent className="pt-4 pb-4">
            <div className="flex items-center gap-2">
              <Users className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm text-muted-foreground">Total Members</span>
            </div>
            <div className="text-2xl font-bold mt-1" data-testid="stat-total">
              {stats.total}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-4">
            <div className="flex items-center gap-2">
              <UserCheck className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm text-muted-foreground">Active</span>
            </div>
            <div className="text-2xl font-bold mt-1 text-green-600 dark:text-green-400" data-testid="stat-active">
              {stats.active}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-4">
            <div className="flex items-center gap-2">
              <DollarSign className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm text-muted-foreground">Monthly Total</span>
            </div>
            <div className="text-2xl font-bold mt-1" data-testid="stat-amount">
              ${stats.totalAmount % 1 === 0 ? stats.totalAmount.toFixed(0) : stats.totalAmount.toFixed(2)}
            </div>
          </CardContent>
        </Card>
        <Card
          className={insuranceExpenseAccount ? "cursor-pointer hover:ring-1 hover:ring-primary/40 transition-all" : ""}
          onClick={() =>
            insuranceExpenseAccount &&
            window.open(`/factory/accounts?accountId=${insuranceExpenseAccount.id}&accountType=ledger`, "_blank")
          }
        >
          <CardContent className="pt-4 pb-4">
            <div className="flex items-center gap-2">
              <BookOpen className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm text-muted-foreground">Insurance Expense</span>
            </div>
            <div className="text-2xl font-bold mt-1 font-mono" data-testid="stat-expense-balance">
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
      <div className="flex items-center gap-3 flex-wrap">
        <Input
          placeholder="Search by name, nationality, position..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="max-w-xs"
          data-testid="input-search"
        />
        <div className="flex items-center gap-2">
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

      {/* Members Table */}
      <Card>
        <CardContent className="p-0">
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
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Insurance No.</TableHead>
                  <TableHead>Nationality</TableHead>
                  <TableHead>Position</TableHead>
                  <TableHead>Start Date</TableHead>
                  <TableHead>Date of Birth</TableHead>
                  <TableHead className="text-right">Monthly Amount</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredMembers.map((m) => (
                  <TableRow
                    key={m.id}
                    className="cursor-pointer"
                    onClick={() => setStatementMember(m)}
                    data-testid={`row-member-${m.id}`}
                  >
                    <TableCell className="font-medium">{m.name}</TableCell>
                    <TableCell className="font-mono text-sm">{m.insuranceNumber || "—"}</TableCell>
                    <TableCell className="text-muted-foreground">{m.nationality || "—"}</TableCell>
                    <TableCell className="text-muted-foreground">{m.positionWorking || "—"}</TableCell>
                    <TableCell>{formatDisplayDate(m.startDate)}</TableCell>
                    <TableCell>{m.dob ? formatDisplayDate(m.dob) : "—"}</TableCell>
                    <TableCell className="text-right font-mono">${parseFloat(m.amount).toFixed(2)}</TableCell>
                    <TableCell>
                      {m.active ? (
                        <Badge
                          variant="secondary"
                          className="bg-green-50 text-green-700 dark:bg-green-900/30 dark:text-green-400"
                          data-testid={`badge-status-${m.id}`}
                        >
                          Active
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="text-muted-foreground" data-testid={`badge-status-${m.id}`}>
                          Inactive
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-1" onClick={(e) => e.stopPropagation()}>
                        <Button
                          size="icon"
                          variant="ghost"
                          onClick={() => setEditMember(m)}
                          title="Edit member"
                          data-testid={`button-edit-${m.id}`}
                        >
                          <Edit className="h-4 w-4" />
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
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
                          onClick={() => setDeleteMember(m)}
                          title="Delete member"
                          data-testid={`button-delete-${m.id}`}
                        >
                          <Trash2 className="h-4 w-4 text-destructive" />
                        </Button>
                      </div>
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
                    {ledgerAccounts.filter((a) => a.name.toLowerCase().includes(ecDrSearch.toLowerCase())).length ===
                      0 && <div className="px-3 py-2 text-muted-foreground italic">No accounts found</div>}
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
                    {ledgerAccounts.filter((a) => a.name.toLowerCase().includes(ecCrSearch.toLowerCase())).length ===
                      0 && <div className="px-3 py-2 text-muted-foreground italic">No accounts found</div>}
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
