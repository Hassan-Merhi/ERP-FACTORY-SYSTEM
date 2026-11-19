// Extracted from ./usePosImportModel.ts to keep that module under the source-size cap.
import type { ClientErrorLike } from "@/lib/clientError";
import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { useReactToPrint } from "react-to-print";
import { formatNumber } from "@/lib/formatNumber";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useCurrencyContext } from "@/contexts/CurrencyContext";
import { useCompany } from "@/contexts/CompanyContext";
import type {
  Customer,
  ImportedSale,
  LedgerAccount,
  Location,
  PosImportItem,
  PosImportPreview,
  PosImportValidationResult,
} from "./types";

function createImportIdentity(scope: string): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return `${scope}:${globalThis.crypto.randomUUID()}`;
  }
  return `${scope}:${Date.now()}:${Math.random().toString(36).slice(2, 12)}`;
}

export function usePosImportModelPart1() {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const { displayCurrency, exchangeRate, isLoadingCompany } = useCurrencyContext();
  const { selectedCompany } = useCompany();
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<PosImportPreview | null>(null);
  const [validationResult, setValidationResult] = useState<PosImportValidationResult | null>(null);
  const [selectedLocation, setSelectedLocation] = useState<string>("");
  const [selectedCashAccount, setSelectedCashAccount] = useState<string>("");
  const [selectedCustomer, setSelectedCustomer] = useState<string>("");
  const [isCreditSale, setIsCreditSale] = useState(false);
  const [saleDate, setSaleDate] = useState<string>(new Date().toLocaleDateString("en-CA"));
  const [showWarningDialog, setShowWarningDialog] = useState(false);
  const [saleCurrency, setSaleCurrency] = useState<"USD" | "CFA" | "ZMW">("USD");
  const [showPrintDialog, setShowPrintDialog] = useState(false);
  const [importedSale, setImportedSale] = useState<ImportedSale | null>(null);
  const [printTime, setPrintTime] = useState<string>("");
  const printRef = useRef<HTMLDivElement>(null);
  const errorsRef = useRef<HTMLDivElement>(null);
  const importBatchIdRef = useRef<string>(createImportIdentity("pos-import-batch"));
  const clientRequestIdRef = useRef<string>(createImportIdentity("pos-import-request"));

  const refreshImportIdentity = () => {
    importBatchIdRef.current = createImportIdentity("pos-import-batch");
    clientRequestIdRef.current = createImportIdentity("pos-import-request");
  };

  const fmtPrint = (n: number, prefix = "") => {
    const fixed = Math.abs(n).toFixed(2);
    const clean = fixed.replace(/\.00$/, "");
    const parts = clean.split(".");
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    const num = parts.join(".");
    return prefix ? prefix + "\u00A0" + num : num;
  };

  // Printed ZMW imports display original Kwacha worksheet amounts, not
  // today's conversion of the already-stored USD sales items.
  const printCurrPrefix = importedSale?.voucher?.currency === "ZMW" ? "K" : "$";

  const { data: locations = [] } = useQuery<Location[]>({
    queryKey: ["/api/locations"],
  });

  const { data: ledgerAccounts = [] } = useQuery<LedgerAccount[]>({
    queryKey: ["/api/ledger-accounts?profile=picker"],
  });

  const { data: customers = [] } = useQuery<Customer[]>({
    queryKey: ["/api/customers/for-pos"],
    enabled: isCreditSale,
  });

  const { data: authUser } = useQuery<{ fullName?: string; name?: string; username?: string; email?: string }>({
    queryKey: ["/api/auth/me"],
  });
  const printUserName = authUser?.fullName || authUser?.name || authUser?.username || authUser?.email || "Import";

  const showCurrencySelector = !isLoadingCompany && (displayCurrency === "CFA" || displayCurrency === "ZMW");

  // Changing company must clear the previous company's native-currency choice
  // and validation; otherwise the same Excel upload could be imported as CFA
  // on Zambia or as ZMW on Mali.
  useEffect(() => {
    setSaleCurrency(displayCurrency === "CFA" || displayCurrency === "ZMW" ? displayCurrency : "USD");
    setValidationResult(null);
  }, [selectedCompany?.id, displayCurrency]);

  const { data: datedZmwRate, isFetching: isFetchingZmwRate } = useQuery<{ rate: string } | null>({
    queryKey: ["/api/exchange-rates/latest", selectedCompany?.id, "USD", "ZMW", saleDate, "pos-import"],
    queryFn: async () => {
      const query = new URLSearchParams({
        companyId: String(selectedCompany!.id),
        fromCurrency: "USD",
        toCurrency: "ZMW",
        asOf: saleDate,
      });
      const response = await fetch("/api/exchange-rates/latest?" + query, { credentials: "include" });
      if (!response.ok) return null;
      return response.json();
    },
    enabled: !!selectedCompany?.id && displayCurrency === "ZMW" && !!saleDate,
    staleTime: 0,
  });
  const datedZmwNumber = Number(datedZmwRate?.rate);
  const applicableExchangeRate =
    saleCurrency === "ZMW"
      ? !isFetchingZmwRate && datedZmwRate && Number.isFinite(datedZmwNumber) && datedZmwNumber > 0
        ? datedZmwNumber
        : null
      : exchangeRate;

  /** Import payload USD rates and the original typed local-currency rate, which the sale posts exactly. */
  const toUsdItems = (items: PosImportItem[]): PosImportItem[] =>
    saleCurrency !== "USD" && applicableExchangeRate
      ? items.map((item) => ({
          ...item,
          originalCurrencyRate: String(item.rate),
          rate: (Number(item.rate) / applicableExchangeRate).toFixed(6),
        }))
      : items;

  const parseMutation = useMutation({
    mutationFn: async (formData: FormData) => {
      const res = await fetch("/api/pos-import/parse", {
        method: "POST",
        body: formData,
      });
      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.message || "Failed to parse file");
      }
      return await res.json();
    },
    onSuccess: (data) => {
      setPreview(data);
      setValidationResult(null);
      toast({
        title: "File parsed successfully",
        description: `Found ${data.items.length} item(s) totaling ${formatNumber(data.totalValue)}. Click Validate to check the data.`,
      });
    },
    onError: (error: ClientErrorLike) => {
      if ((error as { _handledGlobally?: boolean })?._handledGlobally) return;
      toast({
        title: "Parse error",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const validateMutation = useMutation({
    mutationFn: async (data: unknown) => {
      const res = await apiRequest("POST", "/api/pos-import/validate", data);
      return await res.json();
    },
    onSuccess: (data) => {
      setValidationResult(data);
      const errorCount = data.errors?.length || 0;
      if (errorCount === 0) {
        toast({
          title: "Validation passed",
          description: "All items validated successfully. You can now import the data.",
        });
      } else {
        toast({
          title: "Validation failed",
          description: `Found ${errorCount} error(s). Scroll down to see the full list.`,
          variant: "destructive",
        });
        // Auto-scroll to the error list so the user sees them immediately
        setTimeout(() => {
          errorsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
        }, 100);
      }
    },
    onError: (error: ClientErrorLike) => {
      if ((error as { _handledGlobally?: boolean })?._handledGlobally) return;
      toast({
        title: "Validation error",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const handlePrint = useReactToPrint({
    contentRef: printRef,
    documentTitle: `${(importedSale?.location?.name || "POS").replace(/\s+/g, "_")}_${new Date().toLocaleDateString("en-CA")}`,
    onAfterPrint: () => {
      setShowPrintDialog(false);
      navigate("/vouchers");
    },
  });

  const importMutation = useMutation({
    mutationFn: async (data: unknown) => {
      const res = await apiRequest("POST", "/api/pos-import/import", data);
      return await res.json();
    },
    onSuccess: (data) => {
      toast({
        title: "Import successful",
        description: `${data.itemsCount} items imported. Total sales: ${data.totalSales}`,
      });
      queryClient.invalidateQueries({ queryKey: ["/api/vouchers"] });

      const location = locations.find((l) => l.id === parseInt(selectedLocation));
      const itemsForPrint =
        saleCurrency === "ZMW"
          ? validationResult?.validatedItems || []
          : toUsdItems(validationResult?.validatedItems || []);
      setImportedSale({
        voucher: data.voucher,
        items: itemsForPrint,
        grandTotal: data.totalSales,
        saleDate,
        location,
        isCreditSale: false,
      });
      setPrintTime(new Date().toLocaleTimeString());
      setShowPrintDialog(true);
      refreshImportIdentity();
    },
    onError: (error: ClientErrorLike) => {
      if ((error as { _handledGlobally?: boolean })?._handledGlobally) return;
      toast({
        title: "Import error",
        description: error.message,
        variant: "destructive",
      });
    },
  });
  return {
    applicableExchangeRate,
    clientRequestIdRef,
    customers,
    displayCurrency,
    errorsRef,
    file,
    fmtPrint,
    handlePrint,
    importBatchIdRef,
    importMutation,
    importedSale,
    isCreditSale,
    ledgerAccounts,
    locations,
    navigate,
    parseMutation,
    preview,
    printCurrPrefix,
    printRef,
    printTime,
    printUserName,
    refreshImportIdentity,
    saleCurrency,
    saleDate,
    selectedCashAccount,
    selectedCompany,
    selectedCustomer,
    selectedLocation,
    setFile,
    setImportedSale,
    setIsCreditSale,
    setPreview,
    setPrintTime,
    setSaleCurrency,
    setSaleDate,
    setSelectedCashAccount,
    setSelectedCustomer,
    setSelectedLocation,
    setShowPrintDialog,
    setShowWarningDialog,
    setValidationResult,
    showCurrencySelector,
    showPrintDialog,
    showWarningDialog,
    toUsdItems,
    toast,
    validateMutation,
    validationResult,
  };
}
