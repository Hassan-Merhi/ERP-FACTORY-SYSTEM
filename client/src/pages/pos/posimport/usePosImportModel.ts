import type { ClientErrorLike } from "@/lib/clientError";
/**
 * Controller hook for the POS Import page.
 *
 * Owns the upload/parse/validate/import pipeline for both cash and credit
 * sales, the CFA→USD rate conversion applied before import and on the printed
 * receipt, the inventory-warning confirmation gate and the print snapshot.
 */
import { useState, useEffect, useRef, type ChangeEvent } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { useReactToPrint } from "react-to-print";
import { formatNumber } from "@/lib/formatNumber";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useCurrencyContext } from "@/contexts/CurrencyContext";
import { useCompany } from "@/contexts/CompanyContext";
import type { Customer, LedgerAccount, Location } from "./types";

export function usePosImportModel() {
  const [_location, navigate] = useLocation();
  const { toast } = useToast();
  const { displayCurrency, exchangeRate, isLoadingCompany } = useCurrencyContext();
  const { selectedCompany } = useCompany();
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<any>(null);
  const [validationResult, setValidationResult] = useState<any>(null);
  const [selectedLocation, setSelectedLocation] = useState<string>("");
  const [selectedCashAccount, setSelectedCashAccount] = useState<string>("");
  const [selectedCustomer, setSelectedCustomer] = useState<string>("");
  const [isCreditSale, setIsCreditSale] = useState(false);
  const [saleDate, setSaleDate] = useState<string>(new Date().toLocaleDateString("en-CA"));
  const [showWarningDialog, setShowWarningDialog] = useState(false);
  const [saleCurrency, setSaleCurrency] = useState<"USD" | "CFA">("USD");
  const [showPrintDialog, setShowPrintDialog] = useState(false);
  const [importedSale, setImportedSale] = useState<any>(null);
  const [printTime, setPrintTime] = useState<string>("");
  const printRef = useRef<HTMLDivElement>(null);
  const errorsRef = useRef<HTMLDivElement>(null);
  const importIdentityRef = useRef<{ signature: string; requestId: string } | null>(null);

  const createImportRequestId = () => {
    if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
    return `pos-import-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
  };

  const resolveImportRequestId = (signature: string) => {
    if (importIdentityRef.current?.signature === signature) return importIdentityRef.current.requestId;
    const requestId = createImportRequestId();
    importIdentityRef.current = { signature, requestId };
    return requestId;
  };

  const clearImportRequestId = () => {
    importIdentityRef.current = null;
  };

  const fmtPrint = (n: number, prefix = "") => {
    const fixed = Math.abs(n).toFixed(2);
    const clean = fixed.replace(/\.00$/, "");
    const parts = clean.split(".");
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    const num = parts.join(".");
    return prefix ? prefix + "\u00A0" + num : num;
  };

  // Print always shows USD amounts
  const printCurrPrefix = "$";

  const { data: locations = [] } = useQuery<Location[]>({
    queryKey: ["/api/locations"],
  });

  const { data: ledgerAccounts = [] } = useQuery<LedgerAccount[]>({
    queryKey: ["/api/ledger-accounts"],
  });

  const { data: customers = [] } = useQuery<Customer[]>({
    queryKey: ["/api/customers/for-pos"],
    enabled: isCreditSale,
  });

  const { data: authUser } = useQuery<{ fullName?: string; name?: string; username?: string; email?: string }>({
    queryKey: ["/api/auth/me"],
  });
  const printUserName = authUser?.fullName || authUser?.name || authUser?.username || authUser?.email || "Import";

  // Show currency selector when company has displayCurrency = "CFA" and data has loaded
  const showCurrencySelector = !isLoadingCompany && displayCurrency === "CFA";

  // Default to CFA when company has displayCurrency = CFA
  useEffect(() => {
    if (displayCurrency === "CFA") {
      setSaleCurrency("CFA");
    }
  }, [displayCurrency]);

  /** Excel rates arrive in the sale currency; the backend always stores USD. */
  const toUsdItems = (items: any[]) =>
    saleCurrency === "CFA" && exchangeRate
      ? items.map((item) => ({ ...item, rate: (parseFloat(item.rate) / exchangeRate).toFixed(2) }))
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
      clearImportRequestId();
      toast({
        title: "Import successful",
        description: `${data.itemsCount} items imported. Total sales: ${data.totalSales}`,
      });
      queryClient.invalidateQueries({ queryKey: ["/api/vouchers"] });

      const location = locations.find((l) => l.id === parseInt(selectedLocation));
      const itemsForPrint = toUsdItems(validationResult?.validatedItems || []);
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

  const creditImportMutation = useMutation({
    mutationFn: async (data: unknown) => {
      const res = await apiRequest("POST", "/api/credit-sales-import/import", data);
      return await res.json();
    },
    onSuccess: (data) => {
      clearImportRequestId();
      toast({
        title: "Credit Sale Import successful",
        description: `${data.itemsCount} items imported. Total: $${data.totalSales} to ${data.customerName}`,
      });
      queryClient.invalidateQueries({ queryKey: ["/api/vouchers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/customers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/customers/for-pos"] });

      const location = locations.find((l) => l.id === parseInt(selectedLocation));
      const customer = customers.find((c) => c.id === parseInt(selectedCustomer));
      const itemsForPrint = toUsdItems(validationResult?.validatedItems || []);
      setImportedSale({
        voucher: data.voucher,
        items: itemsForPrint,
        grandTotal: data.totalSales,
        saleDate,
        location,
        isCreditSale: true,
        customer: customer ? { name: customer.legalName } : null,
      });
      setPrintTime(new Date().toLocaleTimeString());
      setShowPrintDialog(true);
    },
    onError: (error: ClientErrorLike) => {
      if ((error as { _handledGlobally?: boolean })?._handledGlobally) return;
      toast({
        title: "Credit Import error",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    const selectedFile = e.target.files?.[0];
    if (selectedFile) {
      clearImportRequestId();
      setFile(selectedFile);
      setPreview(null);
      setValidationResult(null);
    }
  };

  const toggleCreditSale = (checked: boolean) => {
    clearImportRequestId();
    setIsCreditSale(checked);
    setSelectedCashAccount("");
    setSelectedCustomer("");
    setValidationResult(null);
  };

  const warn = (title: string, description: string) => {
    toast({ title, description, variant: "destructive" });
  };

  /** Location + cash-account/customer requirements shared by validate and import. */
  const hasRequiredTargets = () => {
    if (!selectedLocation) {
      warn("Location required", "Please select a location");
      return false;
    }
    if (!isCreditSale && !selectedCashAccount) {
      warn("Cash account required", "Please select a cash account");
      return false;
    }
    if (isCreditSale && !selectedCustomer) {
      warn("Customer required", "Please select a customer for credit sale");
      return false;
    }
    return true;
  };

  const handleParse = () => {
    if (!file) {
      warn("No file selected", "Please select an Excel file to upload");
      return;
    }
    if (!navigator.onLine) {
      warn("Not available offline", "File imports require a connection");
      return;
    }
    const formData = new FormData();
    formData.append("file", file);
    parseMutation.mutate(formData);
  };

  const handleValidate = () => {
    if (!hasRequiredTargets()) return;

    if (!preview) {
      warn("No preview data", "Please parse the file first");
      return;
    }

    validateMutation.mutate({
      locationId: parseInt(selectedLocation),
      saleDate,
      items: preview.items,
    });
  };

  const doImport = () => {
    // Convert CFA rates to USD if needed
    const itemsToImport = toUsdItems(validationResult.validatedItems);
    const requestPayload = isCreditSale
      ? {
          locationId: parseInt(selectedLocation),
          customerId: parseInt(selectedCustomer),
          saleDate,
          items: itemsToImport,
        }
      : {
          locationId: parseInt(selectedLocation),
          cashAccountId: parseInt(selectedCashAccount),
          saleDate,
          items: itemsToImport,
        };
    const signature = JSON.stringify({ isCreditSale, ...requestPayload });
    const requestId = resolveImportRequestId(signature);
    const payload = {
      ...requestPayload,
      clientRequestId: requestId,
      importBatchId: requestId,
    };

    if (isCreditSale) {
      creditImportMutation.mutate(payload);
    } else {
      importMutation.mutate(payload);
    }
  };

  const isValidated = validationResult !== null;
  const hasValidationErrors = validationResult?.errors && validationResult.errors.length > 0;

  const handleImport = () => {
    if (!hasRequiredTargets()) return;

    if (saleCurrency === "CFA" && !exchangeRate) {
      warn("Exchange rate required", "Please set an exchange rate in Settings before importing CFA sales");
      return;
    }

    if (!preview) {
      warn("No preview data", "Please parse the file first");
      return;
    }

    if (!isValidated) {
      warn("Validation required", "Please validate the data before importing");
      return;
    }

    if (hasValidationErrors) {
      warn("Validation errors present", "Please fix validation errors before importing");
      return;
    }

    if (!validationResult?.validatedItems) {
      warn("Validation data missing", "Please validate again before importing");
      return;
    }

    // Check if there are inventory warnings
    const hasWarnings = validationResult?.warnings && validationResult.warnings.length > 0;

    if (hasWarnings) {
      // Show confirmation dialog
      setShowWarningDialog(true);
    } else {
      // No warnings, proceed with import
      doImport();
    }
  };

  const handleConfirmImport = () => {
    setShowWarningDialog(false);
    doImport();
  };

  const downloadTemplate = () => {
    window.open("/api/pos-import/template", "_blank");
  };

  const skipPrint = () => {
    setShowPrintDialog(false);
    navigate("/vouchers");
  };

  return {
    // context
    selectedCompany,
    exchangeRate,
    showCurrencySelector,
    // form state
    file,
    handleFileChange,
    saleDate,
    setSaleDate,
    saleCurrency,
    setSaleCurrency,
    isCreditSale,
    toggleCreditSale,
    selectedLocation,
    setSelectedLocation,
    selectedCashAccount,
    setSelectedCashAccount,
    selectedCustomer,
    setSelectedCustomer,
    locations,
    ledgerAccounts,
    customers,
    // pipeline
    preview,
    validationResult,
    errorsRef,
    isValidated,
    hasValidationErrors,
    handleParse,
    handleValidate,
    handleImport,
    handleConfirmImport,
    downloadTemplate,
    parseMutation,
    validateMutation,
    importMutation,
    creditImportMutation,
    showWarningDialog,
    setShowWarningDialog,
    // print
    printRef,
    printUserName,
    printTime,
    printCurrPrefix,
    fmtPrint,
    handlePrint,
    skipPrint,
    importedSale,
    showPrintDialog,
    setShowPrintDialog,
  };
}

export type PosImportModel = ReturnType<typeof usePosImportModel>;