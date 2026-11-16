// Extracted from ./useFactoryInvoiceDetailModel.tsx to keep that module under the source-size cap.
import type { ClientErrorLike } from "@/lib/clientError";
import { getErrorDetails } from "@shared/errorUtils";
import { useMutation } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
import { downloadFromUrl, exportFileName } from "@/lib/exportFile";
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

  // Server-named exports: the shared helper sends auth cookies and rejects with
  // the server's message, which surfaces here as a toast.
  const downloadExport = async (url: string, fallbackName: string) => {
    try {
      await downloadFromUrl(url, { fileName: fallbackName });
    } catch (err) {
      toast({ title: "Export failed", description: getErrorDetails(err).message, variant: "destructive" });
    }
  };

  const handleExportExcel = () => {
    if (!orderId) return;
    downloadExport(`/api/factory/customer-orders/${orderId}/export-excel`, exportFileName("invoice", "xlsx"));
  };

  const handleExportExcelNoCharges = () => {
    if (!orderId) return;
    downloadExport(
      `/api/factory/customer-orders/${orderId}/export-excel?noCharges=1`,
      exportFileName("invoice no charges", "xlsx")
    );
  };

  const handleExportPdf = () => {
    if (!orderId) return;
    downloadExport(`/api/factory/customer-orders/${orderId}/export-pdf`, exportFileName("invoice", "pdf"));
  };

  const handleExportPdfNoCharges = () => {
    if (!orderId) return;
    downloadExport(
      `/api/factory/customer-orders/${orderId}/export-pdf?noCharges=1`,
      exportFileName("invoice no charges", "pdf")
    );
  };

  const handleExportLoadingStatus = () => {
    if (!orderId) return;
    downloadExport(
      `/api/factory/customer-orders/${orderId}/loading-status-export`,
      exportFileName("loading status", "xlsx")
    );
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
