// Extracted from ./FactoryMonthlyProductionWorkers.tsx
import { useMemo, useState } from "react";
import { formatQuantity } from "@/lib/formatNumber";
import { useQuery } from "@tanstack/react-query";
import { useLocation, useRoute, useSearch } from "wouter";
import { ArrowLeft } from "lucide-react";
import { useCompany } from "@/contexts/CompanyContext";
import { companyQueryKey } from "@/lib/companyQueryScope";
import { Button } from "@/components/ui/button";
import { useOptionalApplicationLanguage } from "@/contexts/ApplicationLanguageContext";
import { duoMobileText } from "@/i18n/iphoneDuoMobileTranslations";

export type Product = { id: number; name: string; articleCode: string };

export type Worker = {
  workerId: number;
  workerName: string;
  quantity: number;
  weightKg: string;
  monthlyBales: Record<string, number>;
};

type WorkerResponse = {
  product: Product;
  months: string[];
  workers: Worker[];
  totalBales: number;
  totalWeightKg: number;
};

export type Bale = {
  id: number;
  baleCode: string;
  referenceNumber: string;
  articleCode: string;
  productName: string;
  weightKg: string;
  quantity: number;
  status: string;
  stockEntryDate: string | null;
  finalizedAt: string | null;
  category: string | null;
  grade: string | null;
  workerName: string | null;
  locationName: string | null;
};

export type DailyProductionGroup = {
  date: string;
  productName: string;
  quantity: number;
  weightKg: string;
};

export const root = "/factory/monthly-production-matrix";

export const validMonths = (raw: string) => {
  const months = raw.split(",");
  return months.length > 0 && months.length <= 240 && months.every((month) => /^\d{4}-(0[1-9]|1[0-2])$/.test(month));
};

export const monthText = (months: string) =>
  months
    .split(",")
    .map((month) => {
      const [y, m] = month.split("-").map(Number);
      return new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: "short", year: "numeric" });
    })
    .join(", ");

export const format = (count: number) => count.toLocaleString();

export const kg = (value: string | number) => formatQuantity(Number(value));

export const requestJson = async <T,>(url: string): Promise<T> => {
  const response = await fetch(url, { credentials: "include" });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.message || "Unable to load production details");
  }
  return response.json();
};

export const periodQuery = (productId: number, months: string) => {
  const params = new URLSearchParams({ productId: String(productId), months });
  return params.toString();
};

export function DrilldownBack({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <Button type="button" variant="outline" size="sm" onClick={onClick} className="gap-2">
      <ArrowLeft className="h-4 w-4" /> {label}
    </Button>
  );
}

export function useFactoryMonthlyProductionWorkersState() {
  const lang = useOptionalApplicationLanguage()?.language ?? "en";
  const dt = (key: Parameters<typeof duoMobileText>[0]) => duoMobileText(key, lang);
  const [, match] = useRoute("/factory/monthly-production-matrix/:productId/workers");
  const [, navigate] = useLocation();
  const searchParams = new URLSearchParams(useSearch());
  const months = searchParams.get("months") ?? "";
  const productId = Number(match?.productId);
  const { selectedCompany } = useCompany();
  const [search, setSearch] = useState("");
  const enabled = Number.isSafeInteger(productId) && productId > 0 && validMonths(months);
  const { data, error, isLoading, refetch } = useQuery<WorkerResponse>({
    queryKey: companyQueryKey("/api/factory/monthly-production-matrix/workers", selectedCompany?.id, productId, months),
    enabled: !!selectedCompany?.id && enabled,
    queryFn: () =>
      requestJson<WorkerResponse>("/api/factory/monthly-production-matrix/workers?" + periodQuery(productId, months)),
    staleTime: 60_000,
  });
  const filtered = useMemo(
    () =>
      (data?.workers ?? []).filter(
        (worker) =>
          worker.workerName.toLowerCase().includes(search.toLowerCase()) ||
          String(worker.workerId).includes(search.trim())
      ),
    [data?.workers, search]
  );
  const backToMatrix = () => navigate(root + "?months=" + encodeURIComponent(months));
  const openBales = (worker: Worker, selectedMonth?: string) => {
    const params = new URLSearchParams({ months: selectedMonth ?? months, name: worker.workerName });
    if (selectedMonth && selectedMonth !== months) params.set("returnMonths", months);
    navigate(root + "/" + productId + "/bales/" + worker.workerId + "?" + params.toString());
  };
  return { backToMatrix, data, dt, enabled, error, filtered, isLoading, months, openBales, refetch, search, setSearch };
}
