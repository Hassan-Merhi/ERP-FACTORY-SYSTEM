// Extracted from ./usePosImportModel.ts to keep that module under the source-size cap.
import type { ClientErrorLike } from "@/lib/clientError";
import type { ChangeEvent } from "react";
import { useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { downloadFromUrl } from "@/lib/exportFile";
import { usePosImportModelPart1 } from "./usePosImportModelPart1";

export function usePosImportModelPart2({
  applicableExchangeRate,
  clientRequestIdRef,
  customers,
  file,
  importBatchIdRef,
  importMutation,
  isCreditSale,
  locations,
  navigate,
  parseMutation,
  preview,
  refreshImportIdentity,
  saleCurrency,
  saleDate,
  selectedCashAccount,
  selectedCustomer,
  selectedLocation,
  setFile,
  setImportedSale,
  setIsCreditSale,
  setPreview,
  setPrintTime,
  setSelectedCashAccount,
  setSelectedCustomer,
  setSelectedLocation,
  setShowPrintDialog,
  setShowWarningDialog,
  setValidationResult,
  toUsdItems,
  toast,
  validateMutation,
  validationResult,
}: Pick<
  Awaited<ReturnType<typeof usePosImportModelPart1>>,
  | "applicableExchangeRate"
  | "clientRequestIdRef"
  | "customers"
  | "file"
  | "importBatchIdRef"
  | "importMutation"
  | "isCreditSale"
  | "locations"
  | "navigate"
  | "parseMutation"
  | "preview"
  | "refreshImportIdentity"
  | "saleCurrency"
  | "saleDate"
  | "selectedCashAccount"
  | "selectedCustomer"
  | "selectedLocation"
  | "setFile"
  | "setImportedSale"
  | "setIsCreditSale"
  | "setPreview"
  | "setPrintTime"
  | "setSelectedCashAccount"
  | "setSelectedCustomer"
  | "setSelectedLocation"
  | "setShowPrintDialog"
  | "setShowWarningDialog"
  | "setValidationResult"
  | "toUsdItems"
  | "toast"
  | "validateMutation"
  | "validationResult"
>) {
  const creditImportMutation = useMutation({
    mutationFn: async (data: unknown) => {
      const res = await apiRequest("POST", "/api/credit-sales-import/import", data);
      return await res.json();
    },
    onSuccess: (data) => {
      toast({
        title: "Credit Sale Import successful",
        description: `${data.itemsCount} items imported. Total: $${data.totalSales} to ${data.customerName}`,
      });
      queryClient.invalidateQueries({ queryKey: ["/api/vouchers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/customers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/customers/for-pos"] });

      const location = locations.find((l) => l.id === parseInt(selectedLocation));
      const customer = customers.find((c) => c.id === parseInt(selectedCustomer));
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
        isCreditSale: true,
        customer: customer ? { name: customer.legalName } : null,
      });
      setPrintTime(new Date().toLocaleTimeString());
      setShowPrintDialog(true);
      refreshImportIdentity();
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
      refreshImportIdentity();
      setFile(selectedFile);
      setPreview(null);
      setValidationResult(null);
    }
  };

  const toggleCreditSale = (checked: boolean) => {
    setIsCreditSale(checked);
    setSelectedCashAccount("");
    setSelectedCustomer("");
    setValidationResult(null);
  };

  const handleLocationChange = (locationId: string) => {
    setSelectedLocation(locationId);
    // Remaining stock in the validation result belongs to the former location.
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
    if (!validationResult) return;

    // Both normal and credit imports post USD sale prices, with the approved
    // dated foreign amount and locked rate recorded on the voucher entries.
    if (saleCurrency !== "USD" && (!applicableExchangeRate || !Number.isFinite(applicableExchangeRate))) {
      warn("Exchange rate required", "A valid rate for the sale date is required before importing.");
      return;
    }
    const itemsToImport = toUsdItems(validationResult.validatedItems);
    const requestIdentity = {
      importBatchId: importBatchIdRef.current,
      clientRequestId: clientRequestIdRef.current,
    };

    if (isCreditSale) {
      creditImportMutation.mutate({
        locationId: parseInt(selectedLocation),
        customerId: parseInt(selectedCustomer),
        saleDate,
        currency: saleCurrency,
        exchangeRate: saleCurrency === "USD" ? undefined : String(applicableExchangeRate),
        items: itemsToImport,
        ...requestIdentity,
      });
    } else {
      importMutation.mutate({
        locationId: parseInt(selectedLocation),
        cashAccountId: parseInt(selectedCashAccount),
        saleDate,
        currency: saleCurrency,
        exchangeRate: saleCurrency === "USD" ? undefined : String(applicableExchangeRate),
        items: itemsToImport,
        ...requestIdentity,
      });
    }
  };

  const isValidated = validationResult !== null;
  const hasValidationErrors = validationResult?.errors && validationResult.errors.length > 0;

  const handleImport = () => {
    if (!hasRequiredTargets()) return;

    if (saleCurrency !== "USD" && (!applicableExchangeRate || !Number.isFinite(applicableExchangeRate))) {
      warn(
        "Exchange rate required",
        `Set an approved USD/${saleCurrency} rate for the selected sale date before importing.`
      );
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

  const downloadTemplate = async () => {
    try {
      await downloadFromUrl("/api/pos-import/template", { fileName: "pos_import_template.xlsx" });
    } catch (error) {
      toast({
        title: "Template download failed",
        description: error instanceof Error ? error.message : "Please try again.",
        variant: "destructive",
      });
    }
  };

  const skipPrint = () => {
    setShowPrintDialog(false);
    navigate("/vouchers");
  };
  return {
    creditImportMutation,
    downloadTemplate,
    handleConfirmImport,
    handleFileChange,
    handleImport,
    handleLocationChange,
    handleParse,
    handleValidate,
    hasValidationErrors,
    isValidated,
    skipPrint,
    toggleCreditSale,
  };
}
