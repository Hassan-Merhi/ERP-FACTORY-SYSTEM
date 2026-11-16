// Extracted from ./useFactoryPendingInvoiceVerifyModel.tsx to keep that module under the source-size cap.
import { getErrorDetails } from "@shared/errorUtils";
import { Badge } from "@/components/ui/badge";
import { CheckCircle } from "lucide-react";
import type { ComparisonItem } from "./types";
import { useFactoryPendingInvoiceVerifyModelPart1 } from "./useFactoryPendingInvoiceVerifyModelPart1";

export function useFactoryPendingInvoiceVerifyModelPart3({
  orderDetail,
  orderId,
  orderLoading,
  toast,
  verification,
  verificationLoading,
}: Pick<
  Awaited<ReturnType<typeof useFactoryPendingInvoiceVerifyModelPart1>>,
  "orderDetail" | "orderId" | "orderLoading" | "toast" | "verification" | "verificationLoading"
>) {
  // Keep the verified-order Actions menu in parity with finalized invoices.
  // Fetching as a blob preserves auth cookies and lets us surface export errors
  // instead of opening a new tab that can fail silently.
  const downloadFromUrl = async (url: string, fallbackName: string) => {
    try {
      const res = await fetch(url, { credentials: "include", cache: "no-store" });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.message || `Server error ${res.status}`);
      }
      const blob = await res.blob();
      if (blob.size === 0) {
        throw new Error("Server returned an empty file.");
      }
      const cd = res.headers.get("content-disposition") || "";
      const starMatch = cd.match(/filename\*=UTF-8''([^;\s]+)/i);
      const plainMatch = cd.match(/filename="([^"]+)"/i);
      const rawName = starMatch ? starMatch[1] : plainMatch ? plainMatch[1] : null;
      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = objectUrl;
      a.download = rawName ? decodeURIComponent(rawName) : fallbackName;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        document.body.removeChild(a);
        URL.revokeObjectURL(objectUrl);
      }, 10000);
    } catch (error) {
      toast({ title: "Export failed", description: getErrorDetails(error).message, variant: "destructive" });
    }
  };

  const handleExportExcel = () => {
    if (!orderId) return;
    void downloadFromUrl(`/api/factory/customer-orders/${orderId}/export-excel`, "invoice.xlsx");
  };

  const handleExportExcelNoCharges = () => {
    if (!orderId) return;
    void downloadFromUrl(`/api/factory/customer-orders/${orderId}/export-excel?noCharges=1`, "invoice-no-charges.xlsx");
  };

  const handleExportPdf = () => {
    if (!orderId) return;
    void downloadFromUrl(`/api/factory/customer-orders/${orderId}/export-pdf`, "invoice.pdf");
  };

  const handleExportPdfNoCharges = () => {
    if (!orderId) return;
    void downloadFromUrl(`/api/factory/customer-orders/${orderId}/export-pdf?noCharges=1`, "invoice-no-charges.pdf");
  };

  const handleExportLoadingStatus = () => {
    if (!orderId) return;
    void downloadFromUrl(`/api/factory/customer-orders/${orderId}/loading-status-export`, "loading-status.xlsx");
  };

  const getStatusBadge = (status: ComparisonItem["status"]) => {
    switch (status) {
      case "LOADED_NOT_IN_PROFORMA":
        return (
          <Badge variant="destructive" data-testid="badge-loaded-not-in-proforma">
            Not in Proforma
          </Badge>
        );
      case "MISSING_FROM_LOADED":
        return (
          <Badge variant="destructive" data-testid="badge-missing-from-loaded">
            Missing
          </Badge>
        );
      case "UNDER_LOADED":
        return (
          <Badge
            variant="outline"
            className="bg-yellow-50 dark:bg-yellow-950 text-yellow-700 dark:text-yellow-300 border-yellow-200 dark:border-yellow-800"
            data-testid="badge-under-loaded"
          >
            Under Loaded
          </Badge>
        );
      case "OVER_LOADED":
        return (
          <Badge
            variant="outline"
            className="bg-green-50 dark:bg-green-950 text-green-700 dark:text-green-300 border-green-200 dark:border-green-800"
            data-testid="badge-over-loaded"
          >
            Over Loaded
          </Badge>
        );
      case "MATCH":
        return (
          <Badge
            variant="outline"
            className="text-green-700 dark:text-green-300 border-green-200 dark:border-green-800"
            data-testid="badge-match"
          >
            <CheckCircle className="h-3 w-3 mr-1" />
            Match
          </Badge>
        );
      default:
        return null;
    }
  };

  const isLoading = verificationLoading || orderLoading;
  const charges = orderDetail?.charges || [];
  const orderStatus = verification?.order?.status || orderDetail?.status || "";
  const isPending = false; // PENDING_VERIFICATION is now treated as VERIFIED directly
  const isVerified = orderStatus === "VERIFIED" || orderStatus === "PENDING_VERIFICATION";
  const isLoadingStatus = orderStatus === "LOADING";

  const totalNotLoadedBales = (verification?.comparison ?? []).reduce((sum, item) => {
    const remaining = item.expectedQty - item.loadedQty;
    return sum + (remaining > 0 ? remaining : 0);
  }, 0);

  // Compute the not-loaded weight using actual IN-STOCK bale weights where
  // available (stockTotalWeight / stockQty), so the number reflects reality
  // rather than an average of already-loaded bales (which can introduce
  // fractions even when every physical bale has a whole-number weight).
  const globalAvgWeightPerBale =
    (verification?.totalLoadedBales ?? 0) > 0
      ? (verification?.totalLoadedWeight ?? 0) / (verification?.totalLoadedBales ?? 1)
      : 0;
  const totalNotLoadedWeight = (verification?.comparison ?? []).reduce((sum, item) => {
    const remaining = item.expectedQty - item.loadedQty;
    if (remaining <= 0) return sum;
    // Priority 1: actual average weight of IN-STOCK bales for this article
    const stockQty: number = item.stockQty ?? 0;
    const stockTotalWeight: number = item.stockTotalWeight ?? 0;
    if (stockQty > 0 && stockTotalWeight > 0) {
      const stockAvg = stockTotalWeight / stockQty;
      return sum + stockAvg * remaining;
    }
    // Priority 2: average of already-loaded bales of this article
    if (item.loadedQty > 0) {
      return sum + (item.totalWeight / item.loadedQty) * remaining;
    }
    // Priority 3: global average across all loaded bales
    return sum + globalAvgWeightPerBale * remaining;
  }, 0);
  return {
    charges,
    getStatusBadge,
    handleExportExcel,
    handleExportExcelNoCharges,
    handleExportLoadingStatus,
    handleExportPdf,
    handleExportPdfNoCharges,
    isLoading,
    isLoadingStatus,
    isPending,
    isVerified,
    totalNotLoadedBales,
    totalNotLoadedWeight,
  };
}
