// Extracted from ./FactoryMonthlyProductionDrilldown.tsx
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation, useRoute, useSearch } from "wouter";
import { useCompany } from "@/contexts/CompanyContext";
import { companyQueryKey } from "@/lib/companyQueryScope";
import { useOptionalApplicationLanguage } from "@/contexts/ApplicationLanguageContext";
import { duoMobileText } from "@/i18n/iphoneDuoMobileTranslations";
import {
  periodQuery,
  requestJson,
  root,
  validMonths,
  type Bale,
  type DailyProductionGroup,
  type Product,
} from "./FactoryMonthlyProductionWorkers";

type BaleView = "condensed" | "detailed";

type BaleResponse = {
  product: Product;
  months: string[];
  workerId: number;
  page: number;
  view: BaleView;
  limit: number;
  totalBales: number;
  totalWeightKg: string;
  totalRows: number;
  groups: DailyProductionGroup[];
  bales: Bale[];
};

export function useFactoryMonthlyProductionBalesState() {
  const lang = useOptionalApplicationLanguage()?.language ?? "en";
  const dt = (key: Parameters<typeof duoMobileText>[0]) => duoMobileText(key, lang);
  const [, match] = useRoute("/factory/monthly-production-matrix/:productId/bales/:workerId");
  const [, navigate] = useLocation();
  const query = new URLSearchParams(useSearch());
  const months = query.get("months") ?? "";
  const name = query.get("name") || "Unassigned";
  const productId = Number(match?.productId);
  const workerId = Number(match?.workerId);
  const { selectedCompany } = useCompany();
  const [page, setPage] = useState(1);
  const [view, setView] = useState<BaleView>("condensed");
  const changeView = (nextView: BaleView) => {
    setView(nextView);
    setPage(1);
  };
  const enabled =
    Number.isSafeInteger(productId) &&
    productId > 0 &&
    Number.isSafeInteger(workerId) &&
    workerId >= 0 &&
    validMonths(months);
  const { data, error, isLoading, refetch } = useQuery<BaleResponse>({
    queryKey: companyQueryKey(
      "/api/factory/monthly-production-matrix/bales",
      selectedCompany?.id,
      productId,
      workerId,
      months,
      view,
      page
    ),
    enabled: !!selectedCompany?.id && enabled,
    queryFn: () =>
      requestJson<BaleResponse>(
        "/api/factory/monthly-production-matrix/bales?" +
          periodQuery(productId, months) +
          "&workerId=" +
          workerId +
          "&page=" +
          page +
          "&view=" +
          view
      ),
    staleTime: 60_000,
  });
  const backToWorkers = () =>
    navigate(root + "/" + productId + "/workers?months=" + encodeURIComponent(query.get("returnMonths") || months));
  const totalPages = Math.max(1, Math.ceil((data?.totalRows ?? 0) / (data?.limit ?? 100)));
  return {
    backToWorkers,
    changeView,
    data,
    dt,
    enabled,
    error,
    isLoading,
    months,
    name,
    page,
    refetch,
    setPage,
    totalPages,
    view,
  };
}
