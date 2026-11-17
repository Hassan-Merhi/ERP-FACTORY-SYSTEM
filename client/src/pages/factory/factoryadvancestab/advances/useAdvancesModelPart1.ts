// Extracted from ./useAdvancesModel.tsx to keep that module under the source-size cap.
import { useState } from "react";
import { useExistingRecordChangeAccess } from "@/hooks/useExistingRecordChangeAccess";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useDateFormat } from "@/contexts/DateFormatContext";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import type { FactoryWorker } from "@shared/schema";
import type { AdvanceRecord, AuditAdvance, CashAccount } from "../types";

export function wasHandledGlobally(error: unknown): boolean {
  return typeof error === "object" && error !== null && "_handledGlobally" in error && error._handledGlobally === true;
}

export function useAdvancesModelPart1() {
  const { formatDisplayDate } = useDateFormat();
  const { toast } = useToast();
  const recordChanges = useExistingRecordChangeAccess();

  const [addOpen, setAddOpen] = useState(false);
  const [postAccountingOpen, setPostAccountingOpen] = useState(false);
  const [postCashAccountId, setPostCashAccountId] = useState("");
  const [filterWorker, setFilterWorker] = useState("all");
  const [filterStatus, setFilterStatus] = useState("all");
  const [deleteTarget, setDeleteTarget] = useState<AdvanceRecord | null>(null);
  const [reverseTarget, setReverseTarget] = useState<AdvanceRecord | null>(null);

  // Bulk selection state
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [bulkCashAccountId, setBulkCashAccountId] = useState("");

  const [form, setForm] = useState({
    workerId: "",
    advanceDate: new Date().toLocaleDateString("en-CA"),
    amount: "",
    cashAccountId: "",
    notes: "",
    repaymentType: "salary_deduction" as string,
  });

  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkForm, setBulkForm] = useState({
    advanceDate: new Date().toLocaleDateString("en-CA"),
    cashAccountId: "",
    repaymentType: "salary_deduction" as string,
    notes: "",
  });
  const [bulkAmounts, setBulkAmounts] = useState<Record<number, string>>({});
  const [bulkSelected, setBulkSelected] = useState<Set<number>>(new Set());

  const { data: advances, isLoading } = useQuery<AdvanceRecord[]>({
    queryKey: ["/api/factory/advances", filterStatus],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (filterStatus !== "all") params.set("status", filterStatus);
      const url = `/api/factory/advances${params.toString() ? `?${params}` : ""}`;
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message || "Failed to load advances");
      }
      return res.json();
    },
  });

  const { data: workers } = useQuery<FactoryWorker[]>({
    queryKey: ["/api/factory/workers?active=true"],
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

  const { data: cashAccounts } = useQuery<CashAccount[]>({
    queryKey: ["/api/factory/cash-accounts"],
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

  const { data: unvouchered, isLoading: unvoucheredLoading } = useQuery<AdvanceRecord[]>({
    queryKey: ["/api/factory/advances/unvouchered"],
    queryFn: async () => {
      const res = await fetch("/api/factory/advances/unvouchered", { credentials: "include" });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message || "Failed");
      }
      return res.json();
    },
    enabled: postAccountingOpen,
  });

  const postAccountingMutation = useMutation({
    mutationFn: async (data: { cashAccountId: number }) => {
      if (!recordChanges.allowed) throw new Error(recordChanges.reason ?? "");
      const res = await apiRequest("POST", "/api/factory/advances/post-accounting", data);
      const json = await res.json();
      if (!res.ok) throw new Error(json.message || "Failed");
      return json;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/advances"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/advances/unvouchered"] });
      toast({ title: "Accounting posted", description: `${data.posted} advance(s) posted successfully` });
      setPostAccountingOpen(false);
      setPostCashAccountId("");
    },
    onError: (err: Error) => {
      if (err?._handledGlobally) return;
      toast({ title: "Save failed", description: err.message, variant: "destructive" });
    },
  });

  const [repayByMonthOpen, setRepayByMonthOpen] = useState(false);
  const [repayByMonthForm, setRepayByMonthForm] = useState({
    repaymentDate: "",
    cashAccountId: "",
  });
  const [repayByMonthExpanded, setRepayByMonthExpanded] = useState<Set<string>>(new Set());
  const [repayingMonth, setRepayingMonth] = useState<string | null>(null);
  const [confirmRepay, setConfirmRepay] = useState<{
    monthKey: string;
    monthLabel: string;
    items: AdvanceRecord[];
    total: number;
  } | null>(null);

  const repayByMonthMutation = useMutation({
    mutationFn: async (month: string) => {
      if (!recordChanges.allowed) throw new Error(recordChanges.reason ?? "");
      const res = await apiRequest("POST", "/api/factory/advances/repay-by-month", {
        month,
        repaymentDate: repayByMonthForm.repaymentDate,
        cashAccountId: parseInt(repayByMonthForm.cashAccountId),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || "Failed to repay");
      return { ...data, month };
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/advances"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/advance-repayments"] });
      toast({
        title: "Repayments recorded",
        description: `${data.repaid} advance(s) repaid — total $${parseFloat(data.total).toFixed(2)}`,
      });
      setRepayingMonth(null);
    },
    onError: (err: Error) => {
      setRepayingMonth(null);
      if (wasHandledGlobally(err)) return;
      toast({ title: "Save failed", description: err.message, variant: "destructive" });
    },
  });

  const [cashAdjOpen, setCashAdjOpen] = useState(false);
  const [cashAdjForm, setCashAdjForm] = useState({
    cashAccountId: "",
    amount: "",
    direction: "credit",
    date: "",
    narration: "Cash balance adjustment",
  });
  const cashAdjMutation = useMutation({
    mutationFn: async (data: typeof cashAdjForm) => {
      if (!recordChanges.allowed) throw new Error(recordChanges.reason ?? "");
      const res = await apiRequest("POST", "/api/factory/advances/cash-adjustment", {
        cashAccountId: parseInt(data.cashAccountId),
        amount: data.amount,
        direction: data.direction,
        date: data.date,
        narration: data.narration,
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.message || "Failed");
      return json;
    },
    onSuccess: () => {
      toast({ title: "Adjustment posted", description: "Cash account balance corrected." });
      setCashAdjOpen(false);
      setCashAdjForm({
        cashAccountId: "",
        amount: "",
        direction: "credit",
        date: "",
        narration: "Cash balance adjustment",
      });
    },
    onError: (err: Error) => {
      if (wasHandledGlobally(err)) return;
      toast({ title: "Save failed", description: err.message, variant: "destructive" });
    },
  });

  const [repayAuditOpen, setRepayAuditOpen] = useState(false);
  const [repayAuditForm, setRepayAuditForm] = useState({ cashAccountId: "", repaymentDate: "" });

  interface AuditResult {
    advances: AuditAdvance[];
    summary: { total: number; ok: number; missingVoucher: number; noRepayment: number };
  }

  const {
    data: auditData,
    isLoading: auditLoading,
    refetch: refetchAudit,
  } = useQuery<AuditResult>({
    queryKey: ["/api/factory/advances/repayment-audit"],
    queryFn: async () => {
      const res = await fetch("/api/factory/advances/repayment-audit", { credentials: "include" });
      if (!res.ok) {
        const e = await res.json();
        throw new Error(e.message || "Failed");
      }
      return res.json();
    },
    enabled: repayAuditOpen,
    staleTime: 15000,
    refetchOnMount: true,
  });

  const { data: auditCashBalance } = useQuery<{ balance: string; name: string }>({
    queryKey: ["/api/factory/cash-account-balance", repayAuditForm.cashAccountId],
    queryFn: async () => {
      const res = await fetch(`/api/factory/cash-account-balance/${repayAuditForm.cashAccountId}`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to fetch balance");
      return res.json();
    },
    enabled: !!repayAuditForm.cashAccountId && repayAuditOpen,
    staleTime: 15000,
    refetchOnMount: true,
  });
  return {
    addOpen,
    advances,
    auditCashBalance,
    auditData,
    auditLoading,
    bulkAmounts,
    bulkCashAccountId,
    bulkForm,
    bulkOpen,
    bulkSelected,
    cashAccounts,
    cashAdjForm,
    cashAdjMutation,
    cashAdjOpen,
    confirmRepay,
    deleteTarget,
    filterStatus,
    filterWorker,
    form,
    formatDisplayDate,
    isLoading,
    postAccountingMutation,
    postAccountingOpen,
    postCashAccountId,
    recordChanges,
    refetchAudit,
    repayAuditForm,
    repayAuditOpen,
    repayByMonthExpanded,
    repayByMonthForm,
    repayByMonthMutation,
    repayByMonthOpen,
    repayingMonth,
    reverseTarget,
    selectedIds,
    setAddOpen,
    setBulkAmounts,
    setBulkCashAccountId,
    setBulkForm,
    setBulkOpen,
    setBulkSelected,
    setCashAdjForm,
    setCashAdjOpen,
    setConfirmRepay,
    setDeleteTarget,
    setFilterStatus,
    setFilterWorker,
    setForm,
    setPostAccountingOpen,
    setPostCashAccountId,
    setRepayAuditForm,
    setRepayAuditOpen,
    setRepayByMonthExpanded,
    setRepayByMonthForm,
    setRepayByMonthOpen,
    setRepayingMonth,
    setReverseTarget,
    setSelectedIds,
    toast,
    unvouchered,
    unvoucheredLoading,
    workers,
  };
}
