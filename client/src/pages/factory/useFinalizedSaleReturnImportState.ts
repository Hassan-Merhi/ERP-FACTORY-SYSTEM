// Extracted from ./FinalizedSaleReturnImport.tsx
import { useEffect, useMemo, useState, type ChangeEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { companyQueryKey } from "@/lib/companyQueryScope";
import { useCompany } from "@/contexts/CompanyContext";
import { useApplicationLanguage } from "@/contexts/ApplicationLanguageContext";
import { useToast } from "@/hooks/use-toast";
import { getFinalizedSaleReturnCopy } from "@/i18n/factoryFinalizedSaleReturnTranslations";
import { queryClient } from "@/lib/queryClient";
import { readFinalizedReturnImport } from "./finalizedSaleReturnImportFile";
import { buildFinalizedReturnMatchWorkbook } from "./finalizedSaleReturnMatchWorkbook";
import { exportFileName } from "@/lib/exportFile";
import {
  endpoint,
  getJson,
  postJson,
  type PreviewRow,
  type Preview,
  type CustomerOption,
  type Posted,
  type InvoiceGroup,
  type Outcome,
} from "./FinalizedSaleReturnImportHelpers";

export function useFinalizedSaleReturnImportState() {
  const { selectedCompany } = useCompany();
  const { language } = useApplicationLanguage();
  const { toast } = useToast();
  const copy = getFinalizedSaleReturnCopy(language);
  const [fileName, setFileName] = useState("");
  const [customerId, setCustomerId] = useState<number | null>(null);
  const [exporting, setExporting] = useState(false);
  const {
    data: customers = [],
    isLoading: customersLoading,
    isError: customersError,
  } = useQuery<CustomerOption[]>({
    queryKey: companyQueryKey(endpoint + "/customers", selectedCompany?.id),
    queryFn: () => getJson<CustomerOption[]>(endpoint + "/customers"),
    enabled: !!selectedCompany?.id,
  });
  const [preview, setPreview] = useState<Preview | null>(null);
  const [selectedOrders, setSelectedOrders] = useState<number[]>([]);
  const [reason, setReason] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [reading, setReading] = useState(false);
  const [posting, setPosting] = useState(false);
  const [outcomes, setOutcomes] = useState<Record<number, Outcome>>({});

  useEffect(() => {
    setPreview(null);
    setSelectedOrders([]);
    setFileName("");
    setCustomerId(null);
    setReason("");
    setConfirmed(false);
    setOutcomes({});
  }, [selectedCompany?.id]);

  const groups = useMemo(() => {
    const grouped = new Map<number, InvoiceGroup>();
    for (const row of preview?.rows ?? []) {
      if (row.status !== "matched" || row.orderId == null || row.baleId == null || !row.grandTotal) continue;
      const group = grouped.get(row.orderId) ?? {
        orderId: row.orderId,
        invoiceNumber: row.invoiceNumber || "",
        containerNumber: row.containerNumber || null,
        customerName: row.customerName || null,
        grandTotal: row.grandTotal,
        rows: [],
      };
      group.rows.push(row as PreviewRow & { baleId: number; orderId: number });
      grouped.set(row.orderId, group);
    }
    return [...grouped.values()];
  }, [preview]);

  const chosen = groups.filter((group) => selectedOrders.includes(group.orderId));
  const totalSelected = chosen.reduce((sum, group) => sum + group.rows.length, 0);
  const canPost =
    !!preview &&
    customerId !== null &&
    preview.customerId === customerId &&
    preview.issues === 0 &&
    totalSelected > 0 &&
    reason.trim().length >= 5 &&
    reason.trim().length <= 500 &&
    confirmed &&
    !posting &&
    !reading &&
    Object.keys(outcomes).length === 0;

  const onFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || reading || posting) return;
    if (!customerId) {
      toast({ title: copy.importCustomerRequired, variant: "destructive" });
      return;
    }
    setReading(true);
    setPreview(null);
    setFileName(file.name);
    setSelectedOrders([]);
    setConfirmed(false);
    setOutcomes({});
    try {
      const references = await readFinalizedReturnImport(file, selectedCompany?.role);
      const mapped = await postJson<Preview>(endpoint + "/import-preview", { references, customerId });
      if (mapped.customerId !== customerId) throw new Error(copy.importCustomerRequired);
      setPreview(mapped);
      setSelectedOrders([...new Set(mapped.rows.filter((r) => r.status === "matched").map((r) => r.orderId!))]);
    } catch (error) {
      toast({
        title: copy.importReadFailed,
        description: String(error instanceof Error ? error.message : error),
        variant: "destructive",
      });
    } finally {
      setReading(false);
    }
  };

  const downloadPreview = async () => {
    if (!preview || !customerId || preview.customerId !== customerId || posting || exporting) return;
    setExporting(true);
    try {
      const { ExcelJS, writeFile } = await import("@/lib/excelHelper");
      const workbook = new ExcelJS.Workbook();
      buildFinalizedReturnMatchWorkbook(workbook, {
        customerName: preview.customerName,
        uploadedFile: fileName,
        rows: preview.rows,
      });
      await writeFile(
        workbook,
        exportFileName(`finalized return matches ${preview.customerName.slice(0, 50) || customerId}`, "xlsx")
      );
      toast({ title: copy.importExportReady, description: copy.importExportExplanation });
    } catch (error) {
      toast({
        title: copy.importExportFailed,
        description: String(error instanceof Error ? error.message : error),
        variant: "destructive",
      });
    } finally {
      setExporting(false);
    }
  };

  const downloadTemplate = async () => {
    try {
      const { ExcelJS, writeFile } = await import("@/lib/excelHelper");
      const workbook = new ExcelJS.Workbook();
      const worksheet = workbook.addWorksheet("Returns");
      worksheet.addRow(["Ref Code"]);
      worksheet.getColumn(1).width = 32;
      worksheet.getCell("A1").font = { bold: true };
      await writeFile(workbook, "Finalized_Sale_Return_References.xlsx");
    } catch (error) {
      toast({ title: copy.requestFailed, description: String(error), variant: "destructive" });
    }
  };

  const applyAll = async () => {
    if (!canPost) return;
    setPosting(true);
    let posted = 0;
    let failures = 0;
    for (const group of chosen) {
      let expectedTotal = group.grandTotal;
      let completed = 0;
      let warning = "";
      try {
        // The original secured route limits each write to 200 bale IDs.
        // A later chunk must use the new invoice total returned by the prior one.
        for (let offset = 0; offset < group.rows.length; offset += 200) {
          const batch = group.rows.slice(offset, offset + 200);
          const result = await postJson<Posted>(endpoint + "/apply", {
            orderId: group.orderId,
            baleIds: batch.map((row) => row.baleId),
            expectedTotal,
            reason: reason.trim(),
            confirmReturn: true,
          });
          completed += result.quantity;
          expectedTotal = result.revisedTotal;
          if (result.warning) warning = result.warning;
        }
        posted += completed;
        setOutcomes((previous) => ({
          ...previous,
          [group.orderId]: {
            success: true,
            quantity: completed,
            message: warning || copy.importPosted,
          },
        }));
      } catch (error) {
        failures += 1;
        setOutcomes((previous) => ({
          ...previous,
          [group.orderId]: {
            success: false,
            quantity: completed,
            message: error instanceof Error ? error.message : String(error),
          },
        }));
      }
    }
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: [endpoint + "/orders"] }),
      queryClient.invalidateQueries({ queryKey: [endpoint + "/history"] }),
      queryClient.invalidateQueries({ queryKey: ["/api/factory/customer-orders"] }),
      queryClient.invalidateQueries({ queryKey: ["/api/factory/bales"] }),
      queryClient.invalidateQueries({ queryKey: ["/api/factory/stock"] }),
      queryClient.invalidateQueries({ queryKey: ["/api/factory/customer-balances"] }),
    ]);
    toast({
      title: failures ? copy.importPartial : copy.importPosted,
      description: String(posted) + " " + copy.bales + " · " + String(failures) + " " + copy.importFailedInvoices,
      variant: failures ? "destructive" : "default",
    });
    setPosting(false);
    setConfirmed(false);
  };
  return {
    copy,
    setFileName,
    fileName,
    customerId,
    setCustomerId,
    exporting,
    customersLoading,
    customers,
    customersError,
    setPreview,
    preview,
    setSelectedOrders,
    selectedOrders,
    reason,
    setReason,
    setConfirmed,
    confirmed,
    reading,
    posting,
    setOutcomes,
    outcomes,
    groups,
    totalSelected,
    canPost,
    onFile,
    downloadPreview,
    downloadTemplate,
    applyAll,
  };
}
