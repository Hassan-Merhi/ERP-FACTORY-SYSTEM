// Extracted from ./POImport.tsx to keep that module under the source-size cap.
import { Button } from "@/components/ui/button";
import { CheckCircle, FileSpreadsheet, Upload } from "lucide-react";
import { useErpPOImportStatePart1 } from "./useErpPOImportStatePart1";
import { useErpPOImportStatePart2 } from "./useErpPOImportStatePart2";

export function useErpPOImportState() {
  const {
    containerNumber,
    file,
    freightPaidBy,
    freightParentAccountId,
    importCurrency,
    importDate,
    importMutation,
    parentFreightAccounts,
    parseMutation,
    preview,
    refreshInFlight,
    refreshStockItemsMutation,
    requiresImportCurrency,
    selectedCompany,
    selectedSupplier,
    setContainerNumber,
    setFile,
    setFreightPaidBy,
    setFreightParentAccountId,
    setImportCurrency,
    setImportDate,
    setPreview,
    setSelectedSupplier,
    setValidatedAgainstStockItemsAt,
    setValidationResult,
    stockItemsUpdatedAt,
    suppliers,
    suppliersError,
    suppliersLoading,
    toast,
    validateMutation,
    validatedAgainstStockItemsAt,
    validationResult,
  } = useErpPOImportStatePart1();
  const {
    handleCancel,
    handleFileChange,
    handleImport,
    handleParse,
    handleValidate,
    hasValidationErrors,
    isNativeZmw,
    isValidated,
    lockedRate,
    priceSymbol,
    rateLoading,
    refreshStockItems,
    selectedContainer,
  } = useErpPOImportStatePart2({
    containerNumber,
    file,
    freightPaidBy,
    freightParentAccountId,
    importCurrency,
    importDate,
    importMutation,
    parseMutation,
    preview,
    refreshInFlight,
    refreshStockItemsMutation,
    requiresImportCurrency,
    selectedCompany,
    selectedSupplier,
    setContainerNumber,
    setFile,
    setFreightPaidBy,
    setFreightParentAccountId,
    setPreview,
    setSelectedSupplier,
    setValidatedAgainstStockItemsAt,
    setValidationResult,
    stockItemsUpdatedAt,
    toast,
    validateMutation,
    validatedAgainstStockItemsAt,
    validationResult,
  });
  return {
    containerNumber,
    file,
    freightPaidBy,
    freightParentAccountId,
    handleCancel,
    handleFileChange,
    handleImport,
    handleParse,
    handleValidate,
    hasValidationErrors,
    importCurrency,
    importDate,
    importMutation,
    isNativeZmw,
    isValidated,
    lockedRate,
    parentFreightAccounts,
    parseMutation,
    preview,
    priceSymbol,
    rateLoading,
    refreshStockItems,
    refreshStockItemsMutation,
    requiresImportCurrency,
    selectedCompany,
    selectedContainer,
    selectedSupplier,
    setContainerNumber,
    setFreightPaidBy,
    setFreightParentAccountId,
    setImportCurrency,
    setImportDate,
    setSelectedSupplier,
    setValidationResult,
    suppliers,
    suppliersError,
    suppliersLoading,
    validateMutation,
    validationResult,
  };
}

export function ErpPOImportSection({
  containerNumber,
  handleCancel,
  handleImport,
  handleValidate,
  hasValidationErrors,
  importCurrency,
  importMutation,
  isValidated,
  requiresImportCurrency,
  selectedSupplier,
  suppliersError,
  suppliersLoading,
  validateMutation,
}: Pick<
  ReturnType<typeof useErpPOImportState>,
  | "containerNumber"
  | "handleCancel"
  | "handleImport"
  | "handleValidate"
  | "hasValidationErrors"
  | "importCurrency"
  | "importMutation"
  | "isValidated"
  | "requiresImportCurrency"
  | "selectedSupplier"
  | "suppliersError"
  | "suppliersLoading"
  | "validateMutation"
>) {
  return (
    <div className="flex flex-wrap gap-2 justify-end mt-4">
      <Button variant="outline" onClick={handleCancel} data-testid="button-cancel">
        Cancel
      </Button>
      <Button
        onClick={handleValidate}
        disabled={
          validateMutation.isPending ||
          suppliersLoading ||
          suppliersError ||
          !selectedSupplier ||
          !containerNumber ||
          (requiresImportCurrency && !importCurrency)
        }
        variant={isValidated && !hasValidationErrors ? "secondary" : "default"}
        data-testid="button-validate"
      >
        {validateMutation.isPending ? (
          "Validating..."
        ) : (
          <>
            {isValidated && !hasValidationErrors ? (
              <CheckCircle className="w-4 h-4 mr-2" />
            ) : (
              <FileSpreadsheet className="w-4 h-4 mr-2" />
            )}
            {isValidated ? "Re-validate" : "Validate"}
          </>
        )}
      </Button>
      <Button
        onClick={handleImport}
        disabled={importMutation.isPending || !isValidated || hasValidationErrors}
        data-testid="button-import"
      >
        {importMutation.isPending ? (
          "Importing..."
        ) : (
          <>
            <Upload className="w-4 h-4 mr-2" />
            Import
          </>
        )}
      </Button>
    </div>
  );
}
