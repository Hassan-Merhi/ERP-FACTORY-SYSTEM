import { useState, useMemo, useCallback, useEffect } from "react";
import { useSearch } from "wouter";
import { addDays, format } from "date-fns";
import { useQuery } from "@tanstack/react-query";
import { authenticatedUserQueryOptions } from "@/contracts/sessionQueryContracts";
import { useCompany } from "@/contexts/CompanyContext";
import { canUseFactorySurface } from "@/lib/factoryClientAccess";
import type { FactoryMyAccess } from "@shared/apiTypes";

import type { Preset, ProductionValuationMode, ReportData } from "./types";
import {
  computeWorkerExpectedSalary,
  lastMonthRange,
  monthEnd,
  monthStart,
  todayStr,
  weekEnd,
  weekStart,
  yearStart,
  yesterdayStr,
} from "./utils";

const normalizeOverviewTab = (tab: string | null) => (tab === "ledger" ? "product-comparison" : tab || "production");

/**
 * State, queries and derived values for the Overview page. Extracted so the page
 * component is a layout shell and the two heavy tab panels can live in their own
 * files without prop-drilling a dozen arguments each.
 */
export function useDailyProductionReport() {
  const search = useSearch();
  const initialTab = normalizeOverviewTab(new URLSearchParams(search).get("tab"));
  const [activeTab, setActiveTab] = useState(initialTab);

  // Keep the active tab in sync with the query string. Bale Ledger is intentionally
  // hidden in Factory mode, so legacy ?tab=ledger links open its Product Comparison replacement.
  useEffect(() => {
    const tab = new URLSearchParams(search).get("tab");
    setActiveTab(normalizeOverviewTab(tab));
  }, [search]);
  const [preset, setPreset] = useState<Preset>("today");
  const [customFrom, setCustomFrom] = useState(todayStr());
  const [customTo, setCustomTo] = useState(todayStr());
  const [workerPayrollOpen, setWorkerPayrollOpen] = useState(false);
  const [empPayrollOpen, setEmpPayrollOpen] = useState(false);
  const { data: authenticatedUser } = useQuery(authenticatedUserQueryOptions());
  const { data: myAccess } = useQuery<FactoryMyAccess>({
    queryKey: ["/api/factory/my-access"],
    staleTime: 5 * 60_000,
  });
  const { selectedCompany } = useCompany();
  const canReadWorkerAttendanceReport = canUseFactorySurface(myAccess, "factory/payroll-hub", [
    "hide_tab_payrollhub_workers",
    "hide_tab_workers_report",
  ]);
  const canReadWorkerPayrollSummary = canUseFactorySurface(myAccess, "factory/payroll-hub", [
    "hide_tab_payrollhub_workers",
    "hide_tab_workers_payroll",
  ]);
  const [valuationMode, setValuationModeState] = useState<ProductionValuationMode>("cost");
  const [valuationLoadedKey, setValuationLoadedKey] = useState<string | null>(null);

  const valuationStorageKey = useMemo(() => {
    if (!authenticatedUser?.id || !selectedCompany?.id) return null;
    return `factory:production-overview:valuation:${String(authenticatedUser.id)}:${selectedCompany.id}`;
  }, [authenticatedUser?.id, selectedCompany?.id]);

  useEffect(() => {
    if (!valuationStorageKey) {
      setValuationLoadedKey(null);
      return;
    }
    const saved = window.localStorage.getItem(valuationStorageKey);
    setValuationModeState(saved === "selling" ? "selling" : "cost");
    setValuationLoadedKey(valuationStorageKey);
  }, [valuationStorageKey]);

  const setValuationMode = useCallback(
    (mode: ProductionValuationMode) => {
      setValuationModeState(mode);
      if (valuationStorageKey) window.localStorage.setItem(valuationStorageKey, mode);
    },
    [valuationStorageKey]
  );

  const valuationReady = valuationStorageKey !== null && valuationLoadedKey === valuationStorageKey;

  const { from, to } = useMemo(() => {
    if (preset === "today") return { from: todayStr(), to: todayStr() };
    if (preset === "yesterday") return { from: yesterdayStr(), to: yesterdayStr() };
    if (preset === "week") return { from: weekStart(), to: weekEnd() };
    if (preset === "month") return { from: monthStart(), to: monthEnd() };
    if (preset === "lastmonth") {
      const [f, t] = lastMonthRange();
      return { from: f, to: t };
    }
    if (preset === "year") return { from: yearStart(), to: todayStr() };
    if (preset === "alltime") return { from: "", to: "" };
    return { from: customFrom, to: customTo };
  }, [preset, customFrom, customTo]);

  const stepDates = useCallback(
    (n: number) => {
      const fmt = "yyyy-MM-dd";
      const baseFrom = from || todayStr();
      const baseTo = to || todayStr();
      setCustomFrom(format(addDays(new Date(baseFrom + "T00:00:00"), n), fmt));
      setCustomTo(format(addDays(new Date(baseTo + "T00:00:00"), n), fmt));
      setPreset("custom");
    },
    [from, to]
  );

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName?.toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select") return;
      const isBack = e.key === "-" || e.code === "Minus";
      const isForward = (e.key === "+" && e.shiftKey) || (e.code === "Equal" && e.shiftKey) || e.key === "=";
      if (isBack) {
        e.preventDefault();
        stepDates(-1);
      } else if (isForward) {
        e.preventDefault();
        stepDates(1);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [stepDates]);

  const { data, isLoading } = useQuery<ReportData>({
    queryKey: ["/api/factory/production-value-report", from, to, "production", valuationMode],
    queryFn: async () => {
      const params = new URLSearchParams({ view: "production", valuationMode });
      if (from) params.set("from", from);
      if (to) params.set("to", to);
      const qs = params.toString() ? `?${params.toString()}` : "";
      const res = await fetch(`/api/factory/production-value-report${qs}`, { credentials: "include" });
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    },
    enabled: valuationReady && (preset === "alltime" || (!!from && !!to)),
  });

  const { data: attendanceData } = useQuery<{
    dates: { date: string; isWeekend: boolean }[];
    workers: {
      id: number;
      employeeCode: string;
      fullName: string;
      baseSalary: string;
      salaryType: string;
      transportAllowance: string;
      attendance: Record<string, string>;
      paidSalary: string;
    }[];
  }>({
    queryKey: ["/api/factory/workers/attendance-report", from, to],
    queryFn: async () => {
      const res = await fetch(`/api/factory/workers/attendance-report?startDate=${from}&endDate=${to}`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to load attendance");
      return res.json();
    },
    enabled: canReadWorkerAttendanceReport && !!from && !!to,
  });

  const payrollDateParam = to || todayStr();
  const payrollStartParam = from || "";
  const { data: monthlySalarySummary } = useQuery<{
    currentDay: number;
    daysInMonth: number;
    totalWorkerBaseSalary: number;
    totalWorkerTransport: number;
    totalWorkerPaid: number;
    totalEmployeeMonthlySalary: number;
    totalEmployeeBalance: number;
    workerBreakdown: {
      id: number;
      name: string;
      baseSalary: number;
      transport: number;
      expected: number;
      transportProrated: number;
      total: number;
    }[];
    employeeBreakdown: { id: number; name: string; monthlySalary: number; expected: number; balance: number }[];
  }>({
    queryKey: ["/api/factory/monthly-salary-summary", payrollDateParam, payrollStartParam],
    queryFn: async () => {
      const params = new URLSearchParams({ date: payrollDateParam, includeBreakdown: "true" });
      if (payrollStartParam) params.set("startDate", payrollStartParam);
      const res = await fetch(`/api/factory/monthly-salary-summary?${params}`, { credentials: "include" });
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    },
    staleTime: 60_000,
    enabled: canReadWorkerPayrollSummary,
  });

  const salaryKpi = useMemo(() => {
    if (!attendanceData || !attendanceData.dates.length) return null;
    let totalExpected = 0;
    let totalPaid = 0;
    const perWorker: { code: string; name: string; attendanceSalary: number; transport: number; baseSalary: number }[] =
      [];
    for (const w of attendanceData.workers) {
      const transport = parseFloat(w.transportAllowance || "0");
      const fullExpected = computeWorkerExpectedSalary(w, attendanceData.dates);
      const attendanceSalary = fullExpected - transport;
      totalExpected += fullExpected;
      totalPaid += parseFloat(w.paidSalary || "0");
      perWorker.push({
        code: w.employeeCode || String(w.id),
        name: w.fullName || w.employeeCode || String(w.id),
        attendanceSalary,
        transport,
        baseSalary: parseFloat(w.baseSalary || "0"),
      });
    }
    return { totalExpected, totalPaid, totalRemaining: totalExpected - totalPaid, perWorker };
  }, [attendanceData]);

  const presets: { key: Preset; label: string }[] = [
    { key: "today", label: "Today" },
    { key: "yesterday", label: "Yesterday" },
    { key: "week", label: "This Week" },
    { key: "month", label: "This Month" },
    { key: "lastmonth", label: "Last Month" },
    { key: "year", label: "This Year" },
    { key: "alltime", label: "All Time" },
    { key: "custom", label: "Custom" },
  ];

  const statusValue = data?.summary.statusValue ?? 0;
  const statusPositive = statusValue >= 0;
  const profitValue = data?.summary.profitValue ?? 0;

  return {
    activeTab,
    setActiveTab,
    preset,
    setPreset,
    customFrom,
    setCustomFrom,
    customTo,
    setCustomTo,
    workerPayrollOpen,
    setWorkerPayrollOpen,
    empPayrollOpen,
    setEmpPayrollOpen,
    from,
    to,
    stepDates,
    data,
    isLoading,
    attendanceData,
    monthlySalarySummary,
    salaryKpi,
    presets,
    statusValue,
    statusPositive,
    profitValue,
    valuationMode,
    setValuationMode,
  };
}

export type DailyProductionReportState = ReturnType<typeof useDailyProductionReport>;
