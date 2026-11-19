// Extracted from ./useContainerDetailModel.tsx: container queries, mutations and dialog state.
import type { ClientErrorLike } from "@/lib/clientError";
import { useState, useEffect, useRef } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useDateFormat } from "@/contexts/DateFormatContext";
import { useParams, useLocation } from "wouter";
import { useEscapeToParent } from "@/hooks/use-escape-to-parent";
import { useForm } from "react-hook-form";
import { useToast } from "@/hooks/use-toast";
import { useExistingRecordChangeAccess } from "@/hooks/useExistingRecordChangeAccess";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useCompany } from "@/contexts/CompanyContext";
import { useCurrencyContext } from "@/contexts/CurrencyContext";
import type { Supplier, Customer, ContainerSale } from "@shared/schema";
import {
  containerDocuments as containerDocumentsTable,
  containerDocumentTypes as containerDocumentTypesTable,
  containerFreight as containerFreightTable,
  ledgerAccounts as ledgerAccountsTable,
} from "@shared/schema";
import type { ContainerDetailData, SpContainerDetailResponse } from "../containers/types";
import { importContainerPriceFile } from "./containerDetailExports";
import type { ContainerPriceImportPreviewRow } from "./useContainerDetailModel";

export type PaymentFormValues = { paymentDate: string; amount: string; method: string; reference: string };

export function useContainerDetailDataModel({
  idProp,
  forceErp,
}: {
  idProp: { id?: string; forceErp?: boolean }["id"];
  forceErp: { id?: string; forceErp?: boolean }["forceErp"];
}) {
  const { formatDisplayDate } = useDateFormat();
  const params = useParams();
  const containerId = idProp ?? params.id;
  const [showOffloadDialog, setShowOffloadDialog] = useState(false);
  const [showSellDialog, setShowSellDialog] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<(() => void) | null>(null);
  const { toast } = useToast();
  const recordChanges = useExistingRecordChangeAccess();
  const [, setLocation] = useLocation();
  useEscapeToParent();
  const { selectedCompany } = useCompany();
  const { formatAmount } = useCurrencyContext();
  const companyId = selectedCompany?.id;
  // forceErp: when an SP company opens an ERP-sourced container, treat it as a regular ERP container
  const isSupplierPartner = forceErp ? false : selectedCompany?.companyType === "supplier_partner";

  // Check for auto-print query parameter
  const handlePrint = async () => {
    window.print();
  };

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

  const {
    data: containerData,
    isLoading,
    error: containerError,
    refetch: retryContainer,
  } = useQuery<ContainerDetailData>({
    queryKey: [`/api/containers/${containerId}`],
    enabled: !!containerId && !isSupplierPartner,
  });

  const { data: spContainerData, isLoading: spDetailLoading } = useQuery<SpContainerDetailResponse>({
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

  const { data: docsData } = useQuery<{
    documents: (typeof containerDocumentsTable.$inferSelect & { isGhost: boolean })[];
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

  useQuery<
    (typeof containerFreightTable.$inferSelect & {
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
  const [priceImportPreview, setPriceImportPreview] = useState<ContainerPriceImportPreviewRow[] | null>(null);
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
      if (!recordChanges.allowed) throw new Error(recordChanges.reason ?? "");
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
    return await importContainerPriceFile({
      setPriceImportError,
      setPriceImportPreview,
      setPriceImportParsing,
      file,
      pricePreviewMutation,
    });
  };

  const uploadDocMutation = useMutation({
    mutationFn: async ({ docTypeId, file }: { docTypeId: number; file: File }) => {
      if (!recordChanges.allowed) throw new Error(recordChanges.reason ?? "");
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

  type FreightFormValues = {
    vendorName: string;
    freightAmount: string;
    currency: string;
    dueDate: string;
    notes: string;
  };

  const freightForm = useForm<FreightFormValues>({
    defaultValues: { vendorName: "", freightAmount: "", currency: "USD", dueDate: "", notes: "" },
  });

  const addFreightMutation = useMutation({
    mutationFn: async (data: FreightFormValues) => {
      if (!recordChanges.allowed) throw new Error(recordChanges.reason ?? "");
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

  return {
    formatDisplayDate,
    containerId,
    showOffloadDialog,
    setShowOffloadDialog,
    showSellDialog,
    setShowSellDialog,
    pendingDelete,
    setPendingDelete,
    toast,
    recordChanges,
    setLocation,
    selectedCompany,
    formatAmount,
    isSupplierPartner,
    handlePrint,
    isDeveloper,
    containerData,
    isLoading,
    containerError,
    retryContainer,
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
  };
}
