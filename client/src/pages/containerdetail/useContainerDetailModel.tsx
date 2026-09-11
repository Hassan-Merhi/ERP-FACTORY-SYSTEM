import type { ClientErrorLike } from "@/lib/clientError";
import { getErrorDetails } from "@shared/errorUtils";
import { useState, useEffect, useRef } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useDateFormat } from "@/contexts/DateFormatContext";
import { useParams, useLocation } from "wouter";
import { useEscapeToParent } from "@/hooks/use-escape-to-parent";
import { useForm } from "react-hook-form";
import { zodResolver } from "@/lib/form-resolver";
import { z } from "zod";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useCompany } from "@/contexts/CompanyContext";
import { useCurrencyContext } from "@/contexts/CurrencyContext";
import type { Supplier, Customer, ContainerSale } from "@shared/schema";
import {
  type PurchaseOrder,
  type POLineItem,
  type ContainerCharge,
  containers as containersTable,
  containerDocuments as containerDocumentsTable,
  containerDocumentTypes as containerDocumentTypesTable,
  containerFreight as containerFreightTable,
  ledgerAccounts as ledgerAccountsTable,
} from "@shared/schema";

import { utils, writeFile, read as readExcel, ExcelJS } from "@/lib/excelHelper";

interface ContainerDetailData {
  container: typeof containersTable.$inferSelect;
  pos: (PurchaseOrder & { items: POLineItem[] })[];
  charges: ContainerCharge[];
  offloadId?: number | null;
}

const saleFormSchema = z.object({
  customerId: z.string().min(1, "Customer is required"),
  commission: z
    .string()
    .refine((val) => !isNaN(parseFloat(val)) && parseFloat(val) >= 0, "Commission must be non-negative"),
  commissionAccountId: z.string().optional(),
  saleDate: z.string().min(1, "Sale date is required"),
});

export function useContainerDetailModel({ id: idProp, forceErp }: { id?: string; forceErp?: boolean }) {
  const { formatDisplayDate } = useDateFormat();
  const params = useParams();
  const containerId = idProp ?? params.id;
  const [showOffloadDialog, setShowOffloadDialog] = useState(false);
  const [showSellDialog, setShowSellDialog] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<(() => void) | null>(null);
  const { toast } = useToast();
  const [_location, setLocation] = useLocation();
  useEscapeToParent();
  const { selectedCompany } = useCompany();
  const { formatAmount } = useCurrencyContext();
  const companyId = selectedCompany?.id;
  // forceErp: when an SP company opens an ERP-sourced container, treat it as a regular ERP container
  const isSupplierPartner = forceErp ? false : selectedCompany?.companyType === "supplier_partner";
  const _printRef = useRef<HTMLDivElement>(null);

  // Check for auto-print query parameter
  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get("print") === "true") {
      // Remove the print param from URL to prevent re-printing on refresh
      const newUrl = window.location.pathname;
      window.history.replaceState({}, "", newUrl);
      // Trigger print after a short delay to allow content to load
      setTimeout(() => {
        handlePrint();
      }, 1000);
    }
  }, []);

  const { data: currentUser } = useQuery<{ role?: string }>({ queryKey: ["/api/auth/me"] });
  const isDeveloper = currentUser?.role === "Developer";

  const { data: containerData, isLoading } = useQuery<ContainerDetailData>({
    queryKey: [`/api/containers/${containerId}`],
    enabled: !!containerId && !isSupplierPartner,
  });

  const { data: spContainerData, isLoading: spDetailLoading } = useQuery({
    queryKey: [`/api/sp/containers/${containerId}`],
    queryFn: () => fetch(`/api/sp/containers/${containerId}`, { credentials: "include" }).then((r) => r.json()),
    enabled: !!containerId && isSupplierPartner,
  });

  const [showSpOffloadDialog, setShowSpOffloadDialog] = useState(false);

  const { data: suppliers = [] } = useQuery<Supplier[]>({
    queryKey: ["/api/suppliers"],
  });

  const { data: customers = [] } = useQuery<Customer[]>({
    queryKey: ["/api/customers", companyId],
    enabled: !!companyId,
  });

  const { data: allLedgerAccounts = [] } = useQuery<(typeof ledgerAccountsTable.$inferSelect)[]>({
    queryKey: ["/api/ledger-accounts", companyId],
    enabled: !!companyId,
  });

  // Filter for income accounts only for commission dropdown
  const incomeAccounts = allLedgerAccounts.filter((account) => account.accountType === "Income");

  const { data: containerSales = [] } = useQuery<ContainerSale[]>({
    queryKey: ["/api/container-sales", companyId],
    enabled: !!companyId,
  });

  const containerSale = containerSales.find((sale: ContainerSale) => sale.containerId === parseInt(containerId!));

  const { data: docsData, isLoading: _docsLoading } = useQuery<{
    documents: ((typeof containerDocumentsTable.$inferSelect) & { isGhost: boolean })[];
    docTypes: (typeof containerDocumentTypesTable.$inferSelect)[];
    completeness: { total: number; uploaded: number; complete: boolean };
  }>({
    queryKey: ["/api/factory/containers", containerId, "documents"],
    queryFn: async () => {
      const res = await fetch(`/api/factory/containers/${containerId}/documents`);
      if (!res.ok) throw new Error("Failed to load documents");
      return res.json();
    },
    enabled: !!containerId,
  });

  const { data: _freightData = [], isLoading: _freightLoading } = useQuery<
    ((typeof containerFreightTable.$inferSelect) & {
      payments?: unknown[];
      totalPaid?: number;
      computedStatus?: string;
    })[]
  >({
    queryKey: ["/api/factory/containers", containerId, "freight"],
    queryFn: async () => {
      const res = await fetch(`/api/factory/containers/${containerId}/freight`);
      if (!res.ok) throw new Error("Failed to load freight");
      return res.json();
    },
    enabled: !!containerId,
  });

  const [showUploadDialog, setShowUploadDialog] = useState(false);
  const [showFreightDialog, setShowFreightDialog] = useState(false);
  const [showPaymentDialog, setShowPaymentDialog] = useState<number | null>(null);
  const [uploadDocTypeId, setUploadDocTypeId] = useState("");
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [showPriceImportDialog, setShowPriceImportDialog] = useState(false);
  const [priceImportPreview, setPriceImportPreview] = useState<any[] | null>(null);
  const [priceImportParsing, setPriceImportParsing] = useState(false);
  const [priceImportError, setPriceImportError] = useState<string | null>(null);
  const priceImportFileRef = useRef<HTMLInputElement>(null);

  const pricePreviewMutation = useMutation({
    mutationFn: async (rows: { barcode: string; price: string }[]) => {
      const res = await apiRequest("POST", `/api/containers/${containerId}/price-import/preview`, { rows });
      return res.json();
    },
    onSuccess: (data) => {
      setPriceImportPreview(data.preview || []);
    },
    onError: (e: ClientErrorLike) => {
      toast({ title: "Preview failed", description: e.message, variant: "destructive" });
    },
  });

  const priceApplyMutation = useMutation({
    mutationFn: async (rows: { lineItemIds: number[]; newRate: number }[]) => {
      const res = await apiRequest("POST", `/api/containers/${containerId}/price-import/apply`, { rows });
      return res.json();
    },
    onSuccess: (data) => {
      toast({ title: "Prices updated", description: `${data.updated} line item(s) updated successfully.` });
      setShowPriceImportDialog(false);
      setPriceImportPreview(null);
      setPriceImportError(null);
      queryClient.invalidateQueries({ queryKey: [`/api/containers/${containerId}`] });
    },
    onError: (e: ClientErrorLike) => {
      toast({ title: "Apply failed", description: e.message, variant: "destructive" });
    },
  });

  const handlePriceImportFile = async (file: File) => {
    setPriceImportError(null);
    setPriceImportPreview(null);
    setPriceImportParsing(true);
    try {
      const wb = await readExcel(file);
      const sheetName = wb.SheetNames[0];
      const sheet = wb.Sheets[sheetName];
      const rows: { barcode: string; price: string }[] = [];
      let barcodeCol = -1;
      let priceCol = -1;
      let headerRow = -1;

      sheet.eachRow((row, rowNumber: number) => {
        const vals = row.values as unknown[];
        if (headerRow === -1) {
          vals.forEach((cell, colIdx: number) => {
            const v = String(cell || "")
              .toLowerCase()
              .trim();
            if (v === "barcode" || v === "barcodes" || v === "bar_code" || v === "code") barcodeCol = colIdx;
            if (v === "price" || v === "new_price" || v === "newprice" || v === "unit_price" || v === "unit price")
              priceCol = colIdx;
          });
          if (barcodeCol !== -1 && priceCol !== -1) {
            headerRow = rowNumber;
          }
          return;
        }
        const barcode = String(vals[barcodeCol] ?? "").trim();
        const price = String(vals[priceCol] ?? "").trim();
        if (barcode) rows.push({ barcode, price });
      });

      if (rows.length === 0 && (barcodeCol === -1 || priceCol === -1)) {
        const headerKeywords = [
          "barcode",
          "barcodes",
          "bar_code",
          "code",
          "price",
          "new_price",
          "newprice",
          "unit_price",
          "unit price",
        ];
        sheet.eachRow((row) => {
          const vals = row.values as unknown[];
          const firstCell = String(vals[1] ?? "")
            .toLowerCase()
            .trim();
          if (headerKeywords.includes(firstCell)) return;
          const barcode = String(vals[1] ?? "").trim();
          const price = String(vals[2] ?? "").trim();
          if (barcode) rows.push({ barcode, price });
        });
        if (rows.length === 0) {
          setPriceImportError(
            'Could not detect columns. Use headers "barcode" and "price", or put barcodes in column A and prices in column B.'
          );
          setPriceImportParsing(false);
          return;
        }
      }

      if (rows.length === 0) {
        setPriceImportError("No data rows found in the Excel file.");
        setPriceImportParsing(false);
        return;
      }

      pricePreviewMutation.mutate(rows);
    } catch (err) {
      setPriceImportError("Could not read Excel file: " + getErrorDetails(err).message);
    } finally {
      setPriceImportParsing(false);
    }
  };

  const uploadDocMutation = useMutation({
    mutationFn: async ({ docTypeId, file }: { docTypeId: number; file: File }) => {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("docTypeId", String(docTypeId));
      const res = await fetch(`/api/factory/containers/${containerId}/documents`, {
        method: "POST",
        body: formData,
      });
      if (!res.ok) {
        const e = await res.json();
        throw new Error(e.message);
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/containers", containerId, "documents"] });
      queryClient.invalidateQueries({ queryKey: [`/api/containers/${containerId}`] });
      setShowUploadDialog(false);
      setUploadDocTypeId("");
      setUploadFile(null);
      toast({ title: "Document uploaded" });
    },
    onError: (e: ClientErrorLike) => toast({ title: "Upload failed", description: e.message, variant: "destructive" }),
  });

  const _deleteDocMutation = useMutation({
    mutationFn: async (docId: number) => {
      await apiRequest("DELETE", `/api/factory/containers/${containerId}/documents/${docId}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/containers", containerId, "documents"] });
      queryClient.invalidateQueries({ queryKey: [`/api/containers/${containerId}`] });
      toast({ title: "Document deleted" });
    },
    onError: (e: ClientErrorLike) => {
      if (e?._handledGlobally) return;
      toast({ title: "Delete failed", description: e.message, variant: "destructive" });
    },
  });

  async function _handleViewDoc(storageKey: string) {
    try {
      const resp = await fetch(`/api/factory/uploads/${storageKey}`, { credentials: "include" });
      if (!resp.ok) {
        const isJson = resp.headers.get("content-type")?.includes("application/json");
        const msg = isJson ? (await resp.json()).message : await resp.text();
        toast({
          title: resp.status === 404 ? "File no longer available" : "File unavailable",
          description:
            resp.status === 404
              ? "This file was uploaded before database storage was enabled and cannot be retrieved. Please delete it and re-upload."
              : msg || `Server returned ${resp.status}`,
          variant: "destructive",
        });
        return;
      }
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      window.open(url, "_blank");
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch {
      toast({ title: "Could not open file", description: "Network error", variant: "destructive" });
    }
  }

  type FreightFormValues = { vendorName: string; freightAmount: string; currency: string; dueDate: string; notes: string };
  type PaymentFormValues = { paymentDate: string; amount: string; method: string; reference: string };

  const freightForm = useForm<FreightFormValues>({
    defaultValues: { vendorName: "", freightAmount: "", currency: "USD", dueDate: "", notes: "" },
  });

  const addFreightMutation = useMutation({
    mutationFn: async (data: FreightFormValues) => {
      const res = await apiRequest("POST", `/api/factory/containers/${containerId}/freight`, data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/containers", containerId, "freight"] });
      setShowFreightDialog(false);
      freightForm.reset();
      toast({ title: "Freight charge added" });
    },
    onError: (e: ClientErrorLike) => {
      if (e?._handledGlobally) return;
      toast({ title: "Failed", description: e.message, variant: "destructive" });
    },
  });

  const _deleteFreightMutation = useMutation({
    mutationFn: async (freightId: number) => {
      await apiRequest("DELETE", `/api/factory/containers/${containerId}/freight/${freightId}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/containers", containerId, "freight"] });
      toast({ title: "Freight charge removed" });
    },
    onError: (e: ClientErrorLike) => {
      if (e?._handledGlobally) return;
      toast({ title: "Failed", description: e.message, variant: "destructive" });
    },
  });

  const paymentForm = useForm<PaymentFormValues>({
    defaultValues: { paymentDate: new Date().toLocaleDateString("en-CA"), amount: "", method: "", reference: "" },
  });

  const addPaymentMutation = useMutation({
    mutationFn: async ({ freightId, data }: { freightId: number; data: PaymentFormValues }) => {
      const res = await apiRequest("POST", `/api/factory/freight/${freightId}/payments`, data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/containers", containerId, "freight"] });
      setShowPaymentDialog(null);
      paymentForm.reset({ paymentDate: new Date().toLocaleDateString("en-CA"), amount: "", method: "", reference: "" });
      toast({ title: "Payment recorded" });
    },
    onError: (e: ClientErrorLike) => {
      if (e?._handledGlobally) return;
      toast({ title: "Failed", description: e.message, variant: "destructive" });
    },
  });

  const _deletePaymentMutation = useMutation({
    mutationFn: async ({ freightId, paymentId }: { freightId: number; paymentId: number }) => {
      await apiRequest("DELETE", `/api/factory/freight/${freightId}/payments/${paymentId}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/containers", containerId, "freight"] });
      toast({ title: "Payment deleted" });
    },
    onError: (e: ClientErrorLike) => {
      if (e?._handledGlobally) return;
      toast({ title: "Failed", description: e.message, variant: "destructive" });
    },
  });

  const handleExportContainer = async () => {
    if (!navigator.onLine) {
      toast({ title: "Not available offline", description: "Exports require a connection", variant: "destructive" });
      return;
    }
    try {
      const response = await fetch(`/api/containers/${containerId}/export`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || "Export failed");

      const rows: { Code: string; Name: string; Qty: string; Rate: string; Value: string }[] = [];
      for (const po of data.purchaseOrders || []) {
        for (const item of po.lineItems || []) {
          rows.push({
            Code: item.stockItemCode || "",
            Name: item.stockItemName || "",
            Qty: item.quantity || "0",
            Rate: item.rate || "0",
            Value: item.lineTotal || "0",
          });
        }
      }

      const worksheet = utils.json_to_sheet(rows);
      const workbook = utils.book_new();
      utils.book_append_sheet(workbook, worksheet, "Container Items");
      await writeFile(workbook, `container_${data.container.containerNumber}.xlsx`);

      toast({ title: "Export successful", description: "Container data downloaded as Excel" });
    } catch (error) {
      toast({ title: "Export failed", description: getErrorDetails(error).message, variant: "destructive" });
    }
  };

  const handleExportContainerNoCost = async () => {
    if (!navigator.onLine) {
      toast({ title: "Not available offline", description: "Exports require a connection", variant: "destructive" });
      return;
    }
    try {
      const response = await fetch(`/api/containers/${containerId}/export`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || "Export failed");

      const supplierLabel =
        data.supplier?.code ||
        data.container?.supplierCode ||
        data.supplier?.legalName ||
        data.container?.supplierName ||
        "";
      const containerNumber = data.container?.containerNumber || "";
      const truckNumber = data.container?.numberPlate || data.container?.truckNumber || "";

      // ── build ExcelJS workbook directly for full styling support ──
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet("Container Items");

      // Column definitions: NO | BARCODE (hidden) | DESCRIPTION | Q'TY
      ws.columns = [
        { key: "no", width: 6 },
        { key: "bc", width: 20, hidden: true },
        { key: "desc", width: 70 },
        { key: "qty", width: 18 },
      ];

      // ── Row 1: supplier label (merged A1:D1) ──
      ws.addRow([supplierLabel, "", "", ""]);
      ws.mergeCells("A1:D1");
      const r1 = ws.getRow(1);
      r1.height = 28;
      r1.eachCell((cell) => {
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1B2A4A" } };
        cell.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 13 };
        cell.alignment = { horizontal: "center", vertical: "middle" };
        cell.border = {
          top: { style: "thin" },
          bottom: { style: "thin" },
          left: { style: "thin" },
          right: { style: "thin" },
        };
      });

      // ── Row 2: container (A2:C2) + truck (D2) ──
      ws.addRow([`CONTAINER: ${containerNumber}`, "", "", `TRUCK: ${truckNumber}`]);
      ws.mergeCells("A2:C2");
      const r2 = ws.getRow(2);
      r2.height = 22;
      r2.eachCell({ includeEmpty: true }, (cell) => {
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFBDD7EE" } };
        cell.font = { bold: true, size: 11 };
        cell.alignment = { horizontal: "center", vertical: "middle" };
        cell.border = {
          top: { style: "thin" },
          bottom: { style: "thin" },
          left: { style: "thin" },
          right: { style: "thin" },
        };
      });

      // ── Row 3: column headers ──
      ws.addRow(["NO", "BARCODE", "DESCRIPTION", "Q'TY"]);
      const r3 = ws.getRow(3);
      r3.eachCell((cell, colNum) => {
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF2E3B4E" } };
        cell.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 10 };
        cell.alignment = {
          horizontal: colNum === 3 ? "left" : "center",
          vertical: "middle",
        };
        cell.border = {
          top: { style: "thin" },
          bottom: { style: "thin" },
          left: { style: "thin" },
          right: { style: "thin" },
        };
      });

      // ── Rows 4+: line items ──
      let idx = 1;
      for (const po of data.purchaseOrders || []) {
        for (const item of po.lineItems || []) {
          const isEven = idx % 2 === 0;
          const row = ws.addRow([
            idx,
            item.stockItemCode || "",
            item.stockItemName || "",
            parseFloat(item.quantity) || 0,
          ]);
          row.eachCell({ includeEmpty: true }, (cell, colNum) => {
            if (isEven) {
              cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF2F6FC" } };
            }
            cell.alignment = {
              horizontal: colNum === 3 ? "left" : "center",
              vertical: "middle",
              wrapText: colNum === 3,
            };
            cell.border = {
              top: { style: "thin" },
              bottom: { style: "thin" },
              left: { style: "thin" },
              right: { style: "thin" },
            };
            cell.font = { size: 10 };
          });
          idx++;
        }
      }

      // Freeze top 3 rows
      ws.views = [{ state: "frozen", xSplit: 0, ySplit: 3 }];

      // ── download ──
      const buffer = await wb.xlsx.writeBuffer();
      const blob = new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `container_${containerNumber}_no_cost.xlsx`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      toast({ title: "No-cost export downloaded" });
    } catch (error) {
      toast({ title: "Export failed", description: getErrorDetails(error).message, variant: "destructive" });
    }
  };

  // Determine the back URL based on container status
  const backUrl = containerData?.container?.status === "SOLD" ? "/sold-containers" : "/containers";

  const form = useForm<z.infer<typeof saleFormSchema>>({
    resolver: zodResolver(saleFormSchema),
    defaultValues: {
      customerId: "",
      commission: "0.00",
      commissionAccountId: "",
      saleDate: new Date().toLocaleDateString("en-CA"),
    },
  });

  // Delete PO mutation
  const deletePOMutation = useMutation({
    mutationFn: async (poId: number) => {
      await apiRequest("DELETE", `/api/purchase-orders/${poId}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/containers/${containerId}`] });
      queryClient.invalidateQueries({ queryKey: ["/api/containers/active", selectedCompany?.id] });
      toast({
        title: "Purchase Order Deleted",
        description: "The purchase order and associated data have been removed",
      });
    },
    onError: (error: ClientErrorLike) => {
      if (error?._handledGlobally) return;
      toast({
        title: "Deletion Failed",
        description: error.message || "Failed to delete purchase order",
        variant: "destructive",
      });
    },
  });

  // Delete Container mutation
  const deleteContainerMutation = useMutation({
    mutationFn: async (id: number) => {
      await apiRequest("DELETE", `/api/containers/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/containers/active", selectedCompany?.id] });
      toast({
        title: "Container Deleted",
        description: "The container and all associated data have been removed",
      });
      setLocation("/containers");
    },
    onError: (error: ClientErrorLike) => {
      if (error?._handledGlobally) return;
      toast({
        title: "Deletion Failed",
        description: error.message || "Failed to delete container",
        variant: "destructive",
      });
    },
  });

  // Sync purchase voucher amounts (fixes $0 balance when items were imported after PO creation)
  const syncVoucherMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/containers/${containerId}/sync-voucher`);
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: [`/api/containers/${containerId}`] });
      toast({
        title: "Voucher Synced",
        description: data.message || "Purchase voucher amounts updated successfully",
      });
    },
    onError: (error: ClientErrorLike) => {
      if (error?._handledGlobally) return;
      toast({
        title: "Sync Failed",
        description: error.message || "Failed to sync voucher amounts",
        variant: "destructive",
      });
    },
  });

  // Reverse Offload mutation
  const reverseOffloadMutation = useMutation({
    mutationFn: async (id: number) => {
      await apiRequest("POST", `/api/containers/${id}/reverse-offload`, {});
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/containers/${containerId}`] });
      queryClient.invalidateQueries({ queryKey: ["/api/containers/active", selectedCompany?.id] });
      toast({
        title: "Offload Reversed",
        description: "Container status restored to IN_TRANSIT",
      });
    },
    onError: (error: ClientErrorLike) => {
      if (error?._handledGlobally) return;
      toast({
        title: "Reverse Failed",
        description: error.message || "Failed to reverse offload",
        variant: "destructive",
      });
    },
  });

  // Sell Container mutation
  const sellContainerMutation = useMutation({
    mutationFn: async (data: z.infer<typeof saleFormSchema>) => {
      const containerCost = parseFloat(containerData?.container.grandTotal || "0");
      const commission = parseFloat(data.commission);
      const totalAmount = containerCost + commission;

      await apiRequest("POST", "/api/container-sales", {
        containerId: parseInt(containerId!),
        customerId: parseInt(data.customerId),
        saleDate: data.saleDate,
        containerCost: containerCost.toString(),
        commission: data.commission,
        commissionAccountId: data.commissionAccountId ? parseInt(data.commissionAccountId) : undefined,
        totalAmount: totalAmount.toString(),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/container-sales", selectedCompany?.id] });
      queryClient.invalidateQueries({ queryKey: [`/api/containers/${containerId}`] });
      queryClient.invalidateQueries({ queryKey: ["/api/containers/active", selectedCompany?.id] });
      queryClient.invalidateQueries({ queryKey: ["/api/containers/sold", selectedCompany?.id] });
      toast({
        title: "Container Sold",
        description: "Container sale has been recorded successfully",
      });
      setShowSellDialog(false);
      form.reset();
    },
    onError: (error: ClientErrorLike) => {
      if (error?._handledGlobally) return;
      toast({
        title: "Sale Failed",
        description: error.message || "Failed to record container sale",
        variant: "destructive",
      });
    },
  });

  const handleDeletePO = async (poId: number, _poNumber: string) => {
    setPendingDelete(() => () => deletePOMutation.mutate(poId));
  };

  const handleDeleteContainer = async () => {
    setPendingDelete(() => () => deleteContainerMutation.mutate(parseInt(containerId!)));
  };

  const handleSellSubmit = async (data: z.infer<typeof saleFormSchema>) => {
    sellContainerMutation.mutate(data);
  };

  const handlePrint = async () => {
    window.print();
  };

  const saleCustomer = customers.find((c) => c.id === containerSale?.customerId);

  return {
    formatDisplayDate,
    containerId,
    showOffloadDialog,
    setShowOffloadDialog,
    showSellDialog,
    setShowSellDialog,
    pendingDelete,
    setPendingDelete,
    setLocation,
    formatAmount,
    isSupplierPartner,
    isDeveloper,
    containerData,
    isLoading,
    spContainerData,
    spDetailLoading,
    showSpOffloadDialog,
    setShowSpOffloadDialog,
    suppliers,
    customers,
    incomeAccounts,
    containerSale,
    docsData,
    showUploadDialog,
    setShowUploadDialog,
    showFreightDialog,
    setShowFreightDialog,
    showPaymentDialog,
    setShowPaymentDialog,
    uploadDocTypeId,
    setUploadDocTypeId,
    uploadFile,
    setUploadFile,
    fileInputRef,
    showPriceImportDialog,
    setShowPriceImportDialog,
    priceImportPreview,
    setPriceImportPreview,
    priceImportParsing,
    priceImportError,
    setPriceImportError,
    priceImportFileRef,
    pricePreviewMutation,
    priceApplyMutation,
    handlePriceImportFile,
    uploadDocMutation,
    freightForm,
    addFreightMutation,
    paymentForm,
    addPaymentMutation,
    handleExportContainer,
    handleExportContainerNoCost,
    backUrl,
    form,
    deletePOMutation,
    deleteContainerMutation,
    syncVoucherMutation,
    reverseOffloadMutation,
    sellContainerMutation,
    handleDeletePO,
    handleDeleteContainer,
    handleSellSubmit,
    handlePrint,
    saleCustomer,
  } as const;
}
