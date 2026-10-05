/**
 * Compares a loading against its proforma: stock on hand for the proforma's
 * articles, per-line progress, and articles loaded that the proforma does not
 * list. All quantities come from the authoritative capacity snapshot.
 */
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { visibleTabInterval } from "@/lib/queryPolicies";
import {
  buildProformaProgress,
  normalizeProformaArticleCode,
  proformaCapacityArticles,
  type ProformaCapacitySnapshot,
} from "@/lib/proformaCapacity";
import type { OrderDetail, Proforma } from "./types";

interface ProformaComparisonInput {
  proformaCapacity: ProformaCapacitySnapshot | null;
  proformas: Proforma[];
  orderDetail: OrderDetail | undefined;
  selectedLocationId: string;
  loadedByArticle: Record<string, number>;
}

export function useProformaComparison({
  proformaCapacity,
  proformas,
  orderDetail,
  selectedLocationId,
  loadedByArticle,
}: ProformaComparisonInput) {
  // Stock count targets come from the same authoritative capacity buckets.
  const proformaArticleCodesForStock = useMemo(
    () =>
      proformaCapacityArticles(proformaCapacity)
        .filter((article) => article.isOnProforma)
        .map((article) => article.articleCode)
        .filter(Boolean),
    [proformaCapacity]
  );
  const stockLocationId = orderDetail?.locationId || (selectedLocationId ? parseInt(selectedLocationId) : null);
  const { data: stockCounts = {} } = useQuery<Record<string, number>>({
    queryKey: ["/api/factory/bale-stock-count", proformaArticleCodesForStock.join(","), stockLocationId],
    queryFn: async () => {
      if (proformaArticleCodesForStock.length === 0) return {};
      const params = new URLSearchParams({ articleCodes: proformaArticleCodesForStock.join(",") });
      if (stockLocationId) params.set("locationId", String(stockLocationId));
      const res = await fetch(`/api/factory/bale-stock-count?${params}`, { credentials: "include" });
      if (!res.ok) return {};
      return res.json();
    },
    enabled: proformaArticleCodesForStock.length > 0,
    refetchInterval: visibleTabInterval(30_000),
  });

  // Linked proforma metadata stays compact; all quantity math comes from the
  // authoritative capacity snapshot so sibling loadings are never missed.
  const linkedProforma = orderDetail?.proformaIdUsed
    ? proformas.find((p) => p.id === orderDetail.proformaIdUsed) ||
      (proformaCapacity
        ? {
            id: proformaCapacity.proformaId,
            customerId: proformaCapacity.customerId,
            name: proformaCapacity.proformaName,
            isActive: proformaCapacity.proformaActive,
            lines: [],
          }
        : null)
    : proformas.find((p) => p.isActive) || null;

  const proformaProgress = buildProformaProgress(proformaCapacity);
  const fulfilledCount = proformaProgress.filter(
    (line) => line.status === "fulfilled" || line.status === "overloaded"
  ).length;
  const totalLines = proformaProgress.length;

  const proformaArticleCodes = new Set(
    proformaCapacityArticles(proformaCapacity)
      .filter((article) => article.isOnProforma)
      .map((article) => article.normalizedArticleCode)
  );
  const remainingProformaBales = proformaCapacity?.remainingTotalQty ?? 0;
  const extraArticles = Object.keys(loadedByArticle).filter(
    (code) => !proformaArticleCodes.has(normalizeProformaArticleCode(code))
  );

  return {
    stockCounts,
    stockLocationId,
    linkedProforma,
    proformaProgress,
    fulfilledCount,
    totalLines,
    remainingProformaBales,
    extraArticles,
  };
}
