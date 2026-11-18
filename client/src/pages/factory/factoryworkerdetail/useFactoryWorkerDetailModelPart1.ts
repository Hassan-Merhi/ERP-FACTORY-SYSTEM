// Extracted from ./useFactoryWorkerDetailModel.tsx to keep that module under the source-size cap.
import { useRef, useState } from "react";
import { FACTORY_WORKERS_HUB_TABS } from "@/factory/config/navigationPresentation";
import { useExistingRecordChangeAccess } from "@/hooks/useExistingRecordChangeAccess";
import { useAdminOverride } from "@/hooks/use-admin-override";
import { useDateFormat } from "@/contexts/DateFormatContext";
import { useQuery } from "@tanstack/react-query";
import { useLocation, useRoute } from "wouter";
import { useEscapeToParent } from "@/hooks/use-escape-to-parent";
import { useToast } from "@/hooks/use-toast";
import { useCompany } from "@/contexts/CompanyContext";
import { companyQueryKey } from "@/lib/companyQueryScope";
import type { FactoryMyAccess } from "@shared/apiTypes";
import type { FactoryBale, FactoryWorkerAdvance, FactoryWorkerDocument } from "@shared/schema";
import type { CashAccount, PayrollRecord, WorkerStats, WorkerWithStats } from "./types";
import type { WorkerDetailTabSettings } from "./useFactoryWorkerDetailModelTypes";

export function useFactoryWorkerDetailModelPart1() {
  const { selectedCompany } = useCompany();
  const { wrapAdminAction, AdminDialog } = useAdminOverride();
  const [, navigate] = useLocation();
  useEscapeToParent("/factory/payroll-hub?section=workers");
  const [, params] = useRoute("/factory/workers/:id");
  const workerId = params?.id ? parseInt(params.id) : null;
  const { toast } = useToast();
  const recordChanges = useExistingRecordChangeAccess();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const docInputRef = useRef<HTMLInputElement>(null);
  const [uploadingDoc, setUploadingDoc] = useState(false);
  const [viewingDoc, setViewingDoc] = useState<FactoryWorkerDocument | null>(null);

  const { data: currentUser } = useQuery<{ role?: string }>({ queryKey: ["/api/auth/me"] });
  const isDeveloper = currentUser?.role === "Developer";

  const { data: tabSettings } = useQuery<WorkerDetailTabSettings>({
    queryKey: companyQueryKey("/api/factory/settings", selectedCompany?.id),
    enabled: Boolean(selectedCompany?.id),
    queryFn: async () => {
      const r = await fetch("/api/factory/settings");
      return r.ok ? r.json() : {};
    },
    staleTime: 60000,
  });

  const { data: myAccess } = useQuery<FactoryMyAccess>({
    queryKey: companyQueryKey("/api/factory/my-access", selectedCompany?.id),
    enabled: Boolean(selectedCompany?.id),
    staleTime: 5 * 60000,
  });
  const hiddenTabs =
    myAccess?.companyId === selectedCompany?.id && myAccess?.hasFactoryAccess === true
      ? myAccess.hiddenCostFields
      : [
          "hide_tab_workerdetail_profile",
          "hide_tab_workerdetail_statement",
          "hide_tab_workerdetail_advances",
          "hide_tab_workerdetail_bales",
          "hide_tab_workerdetail_documents",
          FACTORY_WORKERS_HUB_TABS.attendance,
        ];
  const showProfile = !hiddenTabs.includes("hide_tab_workerdetail_profile");

  const showStatement =
    tabSettings?.workerDetailTabStatementEnabled !== false && !hiddenTabs.includes("hide_tab_workerdetail_statement");
  const showAdvances =
    tabSettings?.workerDetailTabAdvancesEnabled !== false && !hiddenTabs.includes("hide_tab_workerdetail_advances");
  const showBales =
    tabSettings?.workerDetailTabBalesEnabled !== false && !hiddenTabs.includes("hide_tab_workerdetail_bales");
  const showDocuments =
    tabSettings?.workerDetailTabDocumentsEnabled !== false && !hiddenTabs.includes("hide_tab_workerdetail_documents");
  // Attendance history reuses the Workers hub Attendance tab's access key and setting.
  const showAttendance =
    tabSettings?.workersTabAttendanceEnabled !== false && !hiddenTabs.includes(FACTORY_WORKERS_HUB_TABS.attendance);

  const { formatDisplayDate } = useDateFormat();
  const formatDate = (val: string | Date | null | undefined) => {
    if (!val) return "—";
    try {
      return formatDisplayDate(val instanceof Date ? val : new Date(val));
    } catch {
      return "—";
    }
  };

  const [endStep, setEndStep] = useState<1 | 2>(1);
  const [endOpen, setEndOpen] = useState(false);
  const [endStart, setEndStart] = useState("");
  const [endEnd, setEndEnd] = useState(new Date().toLocaleDateString("en-CA"));
  const [endCalculating, setEndCalculating] = useState(false);
  const [endResult, setEndResult] = useState<{
    earned: string;
    paid: string;
    advances: string;
    balance: string;
  } | null>(null);
  const [endCashAccountId, setEndCashAccountId] = useState("");
  const [endSubmitting, setEndSubmitting] = useState(false);

  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");

  const [payOpen, setPayOpen] = useState(false);
  const [payTargetId, setPayTargetId] = useState<number | null>(null);
  const [payCashAccountId, setPayCashAccountId] = useState("");

  const [fixAcctOpen, setFixAcctOpen] = useState(false);
  const [fixAcctTargetId, setFixAcctTargetId] = useState<number | null>(null);
  const [fixAcctCashId, setFixAcctCashId] = useState("");

  const [detailPayrollId, setDetailPayrollId] = useState<number | null>(null);

  const [editOpen, setEditOpen] = useState(false);

  const [advanceDate, setAdvanceDate] = useState(new Date().toLocaleDateString("en-CA"));
  const [advanceAmount, setAdvanceAmount] = useState("");
  const [advanceNotes, setAdvanceNotes] = useState("");
  const [advanceRepaymentType, setAdvanceRepaymentType] = useState("salary_deduction");
  const [advanceCashAccountId, setAdvanceCashAccountId] = useState("");
  const [showAdvanceForm, setShowAdvanceForm] = useState(false);

  const [repayAdvanceId, setRepayAdvanceId] = useState<number | null>(null);
  const [repayDate, setRepayDate] = useState(new Date().toLocaleDateString("en-CA"));
  const [repayAmount, setRepayAmount] = useState("");
  const [repayCashAccountId, setRepayCashAccountId] = useState("");
  const [repayNotes, setRepayNotes] = useState("");
  const [expandedAdvanceId, setExpandedAdvanceId] = useState<number | null>(null);

  const [bulkRepayOpen, setBulkRepayOpen] = useState(false);
  const [bulkRepayCashAccountId, setBulkRepayCashAccountId] = useState("");
  const [bulkRepayDates, setBulkRepayDates] = useState<Record<number, string>>({});
  const [pendingDeleteDocId, setPendingDeleteDocId] = useState<number | null>(null);

  const getEndOfMonth = (dateStr: string): string => {
    const d = new Date(dateStr + "T00:00:00");
    const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0);
    return lastDay.toLocaleDateString("en-CA");
  };

  const {
    data: worker,
    isLoading: workerLoading,
    error: workerError,
  } = useQuery<WorkerWithStats>({
    queryKey: companyQueryKey("/api/factory/workers", selectedCompany?.id, workerId),
    queryFn: async () => {
      const res = await fetch(`/api/factory/workers/${workerId}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch worker");
      return res.json();
    },
    enabled: !!workerId && Boolean(selectedCompany?.id),
  });

  const { data: stats, isLoading: statsLoading } = useQuery<WorkerStats>({
    queryKey: companyQueryKey("/api/factory/workers", selectedCompany?.id, workerId, "stats"),
    queryFn: async () => {
      const res = await fetch(`/api/factory/workers/${workerId}/stats`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch stats");
      return res.json();
    },
    enabled: !!workerId && Boolean(selectedCompany?.id),
  });

  const { data: payrolls, isLoading: payrollsLoading } = useQuery<PayrollRecord[]>({
    queryKey: companyQueryKey("/api/factory/workers", selectedCompany?.id, workerId, "payrolls"),
    queryFn: async () => {
      const res = await fetch(`/api/factory/workers/${workerId}/payrolls`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch payrolls");
      return res.json();
    },
    enabled: !!workerId && Boolean(selectedCompany?.id),
  });

  const { data: payrollDetail, isLoading: payrollDetailLoading } = useQuery<{
    payroll: PayrollRecord & {
      presentDays: string;
      absentDays: string;
      totalWorkingDays: number;
      balesCount: number;
      kgProcessed: string;
      overtimePay: string;
      overtimeHours: string;
      deductions: string;
      transport: string;
      notes: string | null;
    };
    attendance: { id: number; attendanceDate: string; status: string; shift: string | null; notes: string | null }[];
  }>({
    queryKey: companyQueryKey("/api/factory/payrolls", selectedCompany?.id, detailPayrollId, "detail"),
    queryFn: async () => {
      const res = await fetch(`/api/factory/payrolls/${detailPayrollId}/detail`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch detail");
      return res.json();
    },
    enabled: detailPayrollId !== null && Boolean(selectedCompany?.id),
  });

  const baleQueryString = [startDate && `startDate=${startDate}`, endDate && `endDate=${endDate}`]
    .filter(Boolean)
    .join("&");
  const { data: bales, isLoading: balesLoading } = useQuery<FactoryBale[]>({
    queryKey: companyQueryKey("/api/factory/workers", selectedCompany?.id, workerId, "bales", startDate, endDate),
    queryFn: async () => {
      const url = `/api/factory/workers/${workerId}/bales${baleQueryString ? `?${baleQueryString}` : ""}`;
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch bales");
      return res.json();
    },
    enabled: !!workerId && Boolean(selectedCompany?.id),
  });

  const { data: documents, isLoading: docsLoading } = useQuery<FactoryWorkerDocument[]>({
    queryKey: companyQueryKey("/api/factory/workers", selectedCompany?.id, workerId, "documents"),
    queryFn: async () => {
      const res = await fetch(`/api/factory/workers/${workerId}/documents`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch documents");
      return res.json();
    },
    enabled: !!workerId && Boolean(selectedCompany?.id),
  });

  const { data: workerAdvances, isLoading: advancesLoading } = useQuery<FactoryWorkerAdvance[]>({
    queryKey: companyQueryKey("/api/factory/workers", selectedCompany?.id, workerId, "advances"),
    queryFn: async () => {
      const res = await fetch(`/api/factory/workers/${workerId}/advances`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch advances");
      return res.json();
    },
    enabled: !!workerId && Boolean(selectedCompany?.id),
  });

  const { data: cashAccounts } = useQuery<CashAccount[]>({
    queryKey: companyQueryKey("/api/factory/cash-accounts", selectedCompany?.id),
    enabled: Boolean(selectedCompany?.id),
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
  return {
    AdminDialog,
    advanceAmount,
    advanceCashAccountId,
    advanceDate,
    advanceNotes,
    advanceRepaymentType,
    advancesLoading,
    baleQueryString,
    bales,
    balesLoading,
    bulkRepayCashAccountId,
    bulkRepayDates,
    bulkRepayOpen,
    cashAccounts,
    currentUser,
    detailPayrollId,
    docInputRef,
    docsLoading,
    documents,
    editOpen,
    endCalculating,
    endCashAccountId,
    endDate,
    endEnd,
    endOpen,
    endResult,
    endStart,
    endStep,
    endSubmitting,
    expandedAdvanceId,
    fileInputRef,
    fixAcctCashId,
    fixAcctOpen,
    fixAcctTargetId,
    formatDate,
    formatDisplayDate,
    getEndOfMonth,
    hiddenTabs,
    isDeveloper,
    myAccess,
    navigate,
    params,
    payCashAccountId,
    payOpen,
    payTargetId,
    payrollDetail,
    payrollDetailLoading,
    payrolls,
    payrollsLoading,
    pendingDeleteDocId,
    recordChanges,
    repayAdvanceId,
    repayAmount,
    repayCashAccountId,
    repayDate,
    repayNotes,
    setAdvanceAmount,
    setAdvanceCashAccountId,
    setAdvanceDate,
    setAdvanceNotes,
    setAdvanceRepaymentType,
    setBulkRepayCashAccountId,
    setBulkRepayDates,
    setBulkRepayOpen,
    setDetailPayrollId,
    setEditOpen,
    setEndCalculating,
    setEndCashAccountId,
    setEndDate,
    setEndEnd,
    setEndOpen,
    setEndResult,
    setEndStart,
    setEndStep,
    setEndSubmitting,
    setExpandedAdvanceId,
    setFixAcctCashId,
    setFixAcctOpen,
    setFixAcctTargetId,
    setPayCashAccountId,
    setPayOpen,
    setPayTargetId,
    setPendingDeleteDocId,
    setRepayAdvanceId,
    setRepayAmount,
    setRepayCashAccountId,
    setRepayDate,
    setRepayNotes,
    setShowAdvanceForm,
    setStartDate,
    setUploadingDoc,
    setViewingDoc,
    showAdvanceForm,
    showAdvances,
    showAttendance,
    showBales,
    showDocuments,
    showProfile,
    showStatement,
    startDate,
    stats,
    statsLoading,
    tabSettings,
    toast,
    uploadingDoc,
    viewingDoc,
    worker,
    workerAdvances,
    workerError,
    workerId,
    workerLoading,
    wrapAdminAction,
  };
}
