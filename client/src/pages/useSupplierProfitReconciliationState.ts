// Extracted from ./SupplierProfitReconciliation.tsx
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { useCompany } from "@/contexts/CompanyContext";
import { companyQueryKey } from "@/lib/companyQueryScope";
import { today, firstDay, lastDay, type Options, type Report, type Period } from "./SupplierProfitReconciliationParts";

export function useSupplierProfitReconciliationState() {
  const { selectedCompany } = useCompany();
  const [, navigate] = useLocation();
  const [supplierId, setSupplierId] = useState("");
  const [groupId, setGroupId] = useState("");
  const [period, setPeriod] = useState<Period>("all");
  const [day, setDay] = useState(today());
  const [month, setMonth] = useState(today().slice(0, 7));
  const [year, setYear] = useState(String(new Date().getFullYear()));
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  const optionsQuery = useQuery<Options>({
    queryKey: companyQueryKey("/api/supplier-profit-reconciliation/options", selectedCompany?.id),
    queryFn: async () => {
      const r = await fetch("/api/supplier-profit-reconciliation/options", { credentials: "include" });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).message || "Could not load suppliers");
      return r.json();
    },
    enabled: !!selectedCompany?.id,
    staleTime: 60_000,
  });
  const options = optionsQuery.data;

  useEffect(() => {
    if (!options?.suppliers.length) return;
    if (!options.suppliers.some((supplier) => String(supplier.id) === supplierId)) {
      setSupplierId(String(options.suppliers[0].id));
    }
  }, [options, supplierId]);

  const range = useMemo(() => {
    if (period === "all") return { from: "", to: "" };
    if (period === "day") return { from: day, to: day };
    if (period === "month") return { from: firstDay(month), to: lastDay(month) };
    if (period === "year") {
      return /^\d{4}$/.test(year) ? { from: year + "-01-01", to: year + "-12-31" } : { from: "", to: "" };
    }
    return { from, to };
  }, [period, day, month, year, from, to]);

  const params = useMemo(() => {
    const p = new URLSearchParams({ supplierId });
    if (groupId) p.set("groupId", groupId);
    if (range.from) p.set("startDate", range.from);
    if (range.to) p.set("endDate", range.to);
    return p.toString();
  }, [supplierId, groupId, range]);

  const validRange =
    (period !== "year" || /^\d{4}$/.test(year)) &&
    (period !== "month" || !!firstDay(month)) &&
    (period !== "custom" || !range.from || !range.to || range.from <= range.to);

  const reportQuery = useQuery<Report>({
    queryKey: companyQueryKey("/api/supplier-profit-reconciliation/report?" + params, selectedCompany?.id),
    queryFn: async () => {
      const r = await fetch("/api/supplier-profit-reconciliation/report?" + params, {
        credentials: "include",
        cache: "no-store",
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).message || "Unable to calculate supplier profit");
      return r.json();
    },
    enabled: !!selectedCompany?.id && !!supplierId && validRange,
  });

  const supplierBalanceQuery = useQuery<{ balance: string | number }>({
    queryKey: companyQueryKey("/api/suppliers/" + supplierId + "/balance", selectedCompany?.id),
    queryFn: async () => {
      const r = await fetch("/api/suppliers/" + supplierId + "/balance", {
        credentials: "include",
        cache: "no-store",
      });
      if (!r.ok) throw new Error("Supplier statement unavailable");
      return r.json();
    },
    enabled: !!supplierId && !!selectedCompany?.id,
  });

  // This sheet displays only saved summary amounts; drilldowns stay in Sales Report.
  const report = reportQuery.data;
  const totals = report?.totals;
  const isAllTime = period === "all";
  const bridgeGap = totals?.modeledVsRecordedGap ?? 0;

  const salesReportUrl =
    "/sales-report?" +
    new URLSearchParams({
      startDate: range.from,
      endDate: range.to,
      ...(groupId ? { stockGroupId: groupId } : {}),
    }).toString();
  return {
    navigate,
    supplierId,
    setSupplierId,
    setGroupId,
    groupId,
    period,
    setPeriod,
    day,
    setDay,
    month,
    setMonth,
    year,
    setYear,
    from,
    setFrom,
    to,
    setTo,
    optionsQuery,
    options,
    range,
    validRange,
    reportQuery,
    supplierBalanceQuery,
    report,
    totals,
    isAllTime,
    bridgeGap,
    salesReportUrl,
  };
}
