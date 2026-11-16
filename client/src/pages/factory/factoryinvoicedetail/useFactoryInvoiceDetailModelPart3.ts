// Extracted from ./useFactoryInvoiceDetailModel.tsx to keep that module under the source-size cap.
import type { ClientErrorLike } from "@/lib/clientError";
import { getErrorDetails } from "@shared/errorUtils";
import { useMutation } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
import { useFactoryInvoiceDetailModelPart1 } from "./useFactoryInvoiceDetailModelPart1";
import { useFactoryInvoiceDetailModelPart2 } from "./useFactoryInvoiceDetailModelPart2";

export function useFactoryInvoiceDetailModelPart3({
  assertCanChange,
  editValue,
  inputRef,
  modeApiRequest,
  orderId,
  repriceArticleMutation,
  setEditValue,
  setEditingArticleCode,
  setExchangeBale,
  setNewRefInput,
  setRemoveBaleState,
  toast,
}: Pick<
  Awaited<ReturnType<typeof useFactoryInvoiceDetailModelPart1>> &
    Awaited<ReturnType<typeof useFactoryInvoiceDetailModelPart2>>,
  | "assertCanChange"
  | "editValue"
  | "inputRef"
  | "modeApiRequest"
  | "orderId"
  | "repriceArticleMutation"
  | "setEditValue"
  | "setEditingArticleCode"
  | "setExchangeBale"
  | "setNewRefInput"
  | "setRemoveBaleState"
  | "toast"
>) {
  const exchangeMutation = useMutation({
    mutationFn: async ({ orderBaleId, newBaleReference }: { orderBaleId: number; newBaleReference: string }) => {
      assertCanChange();
      const res = await modeApiRequest("POST", `/api/factory/customer-orders/${orderId}/bales/exchange`, {
        orderBaleId,
        newBaleReference,
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.message || "Failed to exchange bale");
      }
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Bale exchanged", description: `Replaced successfully.` });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/customer-orders"] });
      setExchangeBale(null);
      setNewRefInput("");
    },
    onError: (error: ClientErrorLike) => {
      if (error?._handledGlobally) return;
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const removeBaleMutation = useMutation({
    mutationFn: async (orderBaleId: number) => {
      assertCanChange();
      const res = await modeApiRequest("DELETE", `/api/factory/customer-orders/${orderId}/bales/${orderBaleId}`);
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.message || "Failed to remove bale");
      }
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Bale removed", description: "Bale returned to stock." });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/customer-orders"] });
      setRemoveBaleState(null);
    },
    onError: (error: ClientErrorLike) => {
      if (error?._handledGlobally) return;
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const startEdit = (articleCode: string, currentPrice: number) => {
    setEditingArticleCode(articleCode);
    setEditValue(String(currentPrice));
    setTimeout(() => inputRef.current?.select(), 30);
  };

  const commitEdit = (articleCode: string) => {
    const price = parseFloat(editValue);
    if (isNaN(price) || price < 0) {
      toast({ title: "Invalid price", description: "Please enter a valid number.", variant: "destructive" });
      setEditingArticleCode(null);
      return;
    }
    repriceArticleMutation.mutate({ articleCode, pricePerBale: price });
  };

  const cancelEdit = () => {
    setEditingArticleCode(null);
    setEditValue("");
  };

  // Shared helper: fetch a binary file from the server and trigger a browser download.
  // Using fetch+blob instead of window.open() ensures auth cookies are always sent,
  // errors surface as toast messages, and stalled 0-byte downloads are avoided.
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
      // Handle both  filename*=UTF-8''encoded-name  and  filename="plain-name"
      const starMatch = cd.match(/filename\*=UTF-8''([^;\s]+)/i);
      const plainMatch = cd.match(/filename="([^"]+)"/i);
      const rawName = starMatch ? starMatch[1] : plainMatch ? plainMatch[1] : null;
      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = objectUrl;
      a.download = rawName ? decodeURIComponent(rawName) : fallbackName;
      document.body.appendChild(a);
      a.click();
      // Delay cleanup so Chrome has time to consume the blob URL before it is revoked.
      setTimeout(() => {
        document.body.removeChild(a);
        URL.revokeObjectURL(objectUrl);
      }, 10000);
    } catch (err) {
      toast({ title: "Export failed", description: getErrorDetails(err).message, variant: "destructive" });
    }
  };

  const handleExportExcel = () => {
    if (!orderId) return;
    downloadFromUrl(`/api/factory/customer-orders/${orderId}/export-excel`, "invoice.xlsx");
  };

  const handleExportExcelNoCharges = () => {
    if (!orderId) return;
    downloadFromUrl(`/api/factory/customer-orders/${orderId}/export-excel?noCharges=1`, "invoice-no-charges.xlsx");
  };

  const handleExportPdf = () => {
    if (!orderId) return;
    downloadFromUrl(`/api/factory/customer-orders/${orderId}/export-pdf`, "invoice.pdf");
  };

  const handleExportPdfNoCharges = () => {
    if (!orderId) return;
    downloadFromUrl(`/api/factory/customer-orders/${orderId}/export-pdf?noCharges=1`, "invoice-no-charges.pdf");
  };

  const handleExportLoadingStatus = () => {
    if (!orderId) return;
    downloadFromUrl(`/api/factory/customer-orders/${orderId}/loading-status-export`, "loading-status.xlsx");
  };
  return {
    cancelEdit,
    commitEdit,
    exchangeMutation,
    handleExportExcel,
    handleExportExcelNoCharges,
    handleExportLoadingStatus,
    handleExportPdf,
    handleExportPdfNoCharges,
    removeBaleMutation,
    startEdit,
  };
}
