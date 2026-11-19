// Extracted from ./usePosImportModel.ts to keep that module under the source-size cap.
import { downloadFromUrl } from "@/lib/exportFile";
import { usePosImportModelPart1 } from "./usePosImportModelPart1";
import { usePosImportModelPart3 } from "./usePosImportModelPart3";

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
  const {
    creditImportMutation,
    handleFileChange,
    toggleCreditSale,
    handleLocationChange,
    warn,
    hasRequiredTargets,
    handleParse,
    handleValidate,
    doImport,
  } = usePosImportModelPart3({
    applicableExchangeRate,
    clientRequestIdRef,
    customers,
    file,
    importBatchIdRef,
    importMutation,
    isCreditSale,
    locations,
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
    setValidationResult,
    toUsdItems,
    toast,
    validateMutation,
    validationResult,
  });

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
