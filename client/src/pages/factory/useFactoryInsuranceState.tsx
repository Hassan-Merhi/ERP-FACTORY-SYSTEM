// Extracted from ./FactoryInsurance.tsx to keep that module under the source-size cap.
import { searchAny } from "@shared/searchNormalization";
import { useExistingRecordChangeAccess } from "@/hooks/useExistingRecordChangeAccess";
import type { ClientErrorLike } from "@/lib/clientError";
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useDateFormat } from "@/contexts/DateFormatContext";
import { useCompany } from "@/contexts/CompanyContext";
import type { InsuranceMember } from "./factoryinsurance/types";
import { formatUsd } from "@/lib/moneyDisplay";

interface LedgerAccountOption {
  id: number;
  name: string;
  code?: string | null;
}

export function useFactoryInsuranceState() {
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
            {data.membersCount} member(s) · Total {formatUsd(parseFloat(data.totalAmount), 2)}{" "}
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
  return {
    canClearInsurance,
    deleteMember,
    deleteMutation,
    ecAmount,
    ecCrId,
    ecCrOpen,
    ecCrRef,
    ecCrSearch,
    ecDate,
    ecDrId,
    ecDrOpen,
    ecDrRef,
    ecDrSearch,
    ecNotes,
    editMember,
    extraChargesMutation,
    filteredMembers,
    formatDisplayDate,
    genMonth,
    genYear,
    generateMutation,
    includeInactive,
    insExpenseBalance,
    insuranceExpenseAccount,
    isError,
    isLoading,
    ledgerAccounts,
    members,
    membersError,
    recordChanges,
    search,
    selectedCompany,
    setDeleteMember,
    setEcAmount,
    setEcCrId,
    setEcCrOpen,
    setEcCrSearch,
    setEcDate,
    setEcDrId,
    setEcDrOpen,
    setEcDrSearch,
    setEcNotes,
    setEditMember,
    setGenMonth,
    setGenYear,
    setIncludeInactive,
    setSearch,
    setShowAddDialog,
    setShowClearDialog,
    setShowExtraCharges,
    setShowGenDialog,
    setShowImportDialog,
    setStatementMember,
    showAddDialog,
    showClearDialog,
    showExtraCharges,
    showGenDialog,
    showImportDialog,
    statementMember,
    stats,
    toggleMutation,
  };
}
