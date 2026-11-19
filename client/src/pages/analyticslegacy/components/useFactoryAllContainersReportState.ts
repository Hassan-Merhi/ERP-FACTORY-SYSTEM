// Extracted from ./FactoryAllContainersReport.tsx
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getDefaultPeriodValue, type PeriodFilterValue } from "@/components/ui/period-filter";
import { factoryReportStatus, isFactoryReportContainer } from "./factoryContainerReportStatus";

type ContainerRow = {
  id: number;
  companyId: number;
  containerNumber: string;
  supplierId: number | null;
  supplierName: string | null;
  status: string;
  origin: string | null;
  arrivalDate: string | null;
  createdAt: string;
  totalKg: string | null;
  actualReceivedKg: string | null;
  ratePerKg: string | null;
  finalPayableAmount: string | null;
  currencyCode: string | null;
};

export const number = (value: string | number | null | undefined): number | null => {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

export function goodsAmount(container: ContainerRow): { amount: number; estimated: boolean } | null {
  const finalAmount = number(container.finalPayableAmount);
  if (finalAmount !== null) return { amount: finalAmount, estimated: false };
  const kg = number(container.totalKg);
  const rate = number(container.ratePerKg);
  if (kg === null || rate === null) return null;
  return { amount: kg * rate, estimated: true };
}

function dateValue(container: ContainerRow): string {
  // Arrival is the business date for incoming factory containers. Records without
  // an arrival date use their creation date rather than silently disappearing.
  return container.arrivalDate?.slice(0, 10) || container.createdAt?.slice(0, 10) || "";
}

export function useFactoryAllContainersReportState() {
  const [period, setPeriod] = useState<PeriodFilterValue>(() => getDefaultPeriodValue("all_time"));
  const [supplier, setSupplier] = useState("all");
  const [status, setStatus] = useState("all");
  const [search, setSearch] = useState("");

  const {
    data: containers = [],
    isLoading,
    isError,
    refetch,
  } = useQuery<ContainerRow[]>({
    queryKey: ["/api/factory/containers"],
    queryFn: async () => {
      const response = await fetch("/api/factory/containers", { credentials: "include" });
      if (!response.ok) throw new Error("Failed to load factory containers");
      return response.json() as Promise<ContainerRow[]>;
    },
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });

  // Exclude synthetic opening-balance container records from this report
  // entirely, including the supplier/status filters and total denominator.
  const reportContainers = useMemo(
    () => containers.filter((container) => isFactoryReportContainer(container.status)),
    [containers]
  );

  const suppliers = useMemo(
    () =>
      Array.from(
        new Map(
          reportContainers.map((c) => [String(c.supplierId ?? "none"), c.supplierName || "No Supplier"])
        ).entries()
      ).sort((a, b) => a[1].localeCompare(b[1])),
    [reportContainers]
  );

  // Group report labels only; keep their original warehouse lifecycle statuses.
  const statuses = useMemo(
    () => [...new Set(reportContainers.map((c) => factoryReportStatus(c.status)))].sort(),
    [reportContainers]
  );

  const visible = useMemo(() => {
    const searchText = search.trim().toLowerCase();
    return reportContainers
      .filter((c) => {
        if (supplier !== "all" && String(c.supplierId ?? "none") !== supplier) return false;
        if (status !== "all" && factoryReportStatus(c.status) !== status) return false;
        const date = dateValue(c);
        if (period.fromDate && (!date || date < period.fromDate)) return false;
        if (period.toDate && (!date || date > period.toDate)) return false;
        if (
          searchText &&
          ![c.containerNumber, c.supplierName, c.origin, factoryReportStatus(c.status)].some((v) =>
            String(v || "")
              .toLowerCase()
              .includes(searchText)
          )
        )
          return false;
        return true;
      })
      .sort((a, b) => dateValue(b).localeCompare(dateValue(a)) || b.id - a.id);
  }, [reportContainers, supplier, status, search, period.fromDate, period.toDate]);

  const totals = useMemo(() => {
    const currencies = new Map<string, number>();
    let weight = 0;
    let receivedWeight = 0;
    let estimatedCount = 0;
    for (const c of visible) {
      weight += number(c.totalKg) ?? 0;
      receivedWeight += number(c.actualReceivedKg) ?? 0;
      const value = goodsAmount(c);
      if (!value) continue;
      if (value.estimated) estimatedCount++;
      const currency = c.currencyCode || "USD";
      currencies.set(currency, (currencies.get(currency) || 0) + value.amount);
    }
    return { weight, receivedWeight, estimatedCount, currencies: Array.from(currencies.entries()).sort() };
  }, [visible]);

  const groups = useMemo(() => {
    const bySupplier = new Map<string, { name: string; rows: ContainerRow[]; weight: number }>();
    for (const container of visible) {
      const key = String(container.supplierId ?? "none");
      const group = bySupplier.get(key) ?? {
        name: container.supplierName || "No Supplier",
        rows: [],
        weight: 0,
      };
      group.rows.push(container);
      group.weight += number(container.totalKg) ?? 0;
      bySupplier.set(key, group);
    }
    return [...bySupplier.entries()].sort((a, b) => a[1].name.localeCompare(b[1].name));
  }, [visible]);
  return {
    period,
    setPeriod,
    supplier,
    setSupplier,
    status,
    setStatus,
    search,
    setSearch,
    isLoading,
    isError,
    refetch,
    reportContainers,
    suppliers,
    statuses,
    visible,
    totals,
    groups,
  };
}
