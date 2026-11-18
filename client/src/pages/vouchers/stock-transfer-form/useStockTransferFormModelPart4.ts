// Extracted from ./useStockTransferFormModel.ts to keep that module under the source-size cap.
import { downloadFromUrl } from "@/lib/exportFile";
import { useStockTransferFormModelPart1 } from "./useStockTransferFormModelPart1";
import { useStockTransferFormModelPart2 } from "./useStockTransferFormModelPart2";

export function useStockTransferFormModelPart4({
  importDate,
  importDestLocation,
  importFile,
  importMutation,
  importNotes,
  importParseMutation,
  importPreview,
  importValidateMutation,
  importValidationResult,
  setImportConfirmDialogOpen,
  setImportDate,
  setImportDestLocation,
  setImportDialogOpen,
  setImportFile,
  setImportNotes,
  setImportPreview,
  setImportValidationResult,
  toast,
}: Pick<
  Awaited<ReturnType<typeof useStockTransferFormModelPart1>> &
    Awaited<ReturnType<typeof useStockTransferFormModelPart2>>,
  | "importDate"
  | "importDestLocation"
  | "importFile"
  | "importMutation"
  | "importNotes"
  | "importParseMutation"
  | "importPreview"
  | "importValidateMutation"
  | "importValidationResult"
  | "setImportConfirmDialogOpen"
  | "setImportDate"
  | "setImportDestLocation"
  | "setImportDialogOpen"
  | "setImportFile"
  | "setImportNotes"
  | "setImportPreview"
  | "setImportValidationResult"
  | "toast"
>) {
  const handleImportFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = e.target.files?.[0];
    if (selectedFile) {
      setImportFile(selectedFile);
      setImportPreview(null);
      setImportValidationResult(null);
    }
  };
  const handleImportParse = () => {
    if (!importFile) {
      toast({
        title: "No file selected",
        description: "Please select an Excel file to upload",
        variant: "destructive",
      });
      return;
    }
    const formData = new FormData();
    formData.append("file", importFile);
    importParseMutation.mutate(formData);
  };
  const handleImportValidate = () => {
    if (!importDestLocation) {
      toast({
        title: "Destination required",
        description: "Please select a destination location",
        variant: "destructive",
      });
      return;
    }
    if (!importPreview) {
      toast({ title: "No preview data", description: "Please parse the file first", variant: "destructive" });
      return;
    }
    importValidateMutation.mutate({ destinationLocationId: parseInt(importDestLocation), items: importPreview.items });
  };
  const handleImportSubmit = () => {
    if (!importDestLocation || !importPreview || !importValidationResult?.validatedItems) {
      toast({
        title: "Cannot import",
        description: "Please parse, validate, and fix any errors first",
        variant: "destructive",
      });
      return;
    }
    const validItems = importValidationResult.validatedItems.filter((item) => !item.error);
    if (importValidationResult?.errors?.length > 0) {
      setImportConfirmDialogOpen(true);
      return;
    }
    importMutation.mutate({
      destinationLocationId: parseInt(importDestLocation),
      transferDate: importDate,
      notes: importNotes,
      items: validItems,
    });
  };
  const handleConfirmedImport = () => {
    const validItems = importValidationResult?.validatedItems?.filter((item) => !item.error) || [];
    setImportConfirmDialogOpen(false);
    if (validItems.length === 0) {
      setImportDialogOpen(false);
      setImportFile(null);
      setImportPreview(null);
      setImportValidationResult(null);
      setImportDestLocation("");
      setImportDate(new Date().toLocaleDateString("en-CA"));
      setImportNotes("");
      toast({ title: "No items imported", description: "All items had validation errors. No transfer was created." });
      return;
    }
    importMutation.mutate({
      destinationLocationId: parseInt(importDestLocation),
      transferDate: importDate,
      notes: importNotes,
      items: validItems,
    });
  };
  const downloadImportTemplate = async () => {
    try {
      await downloadFromUrl("/api/stock-transfer-import/template-multi-source", {
        fileName: "stock_transfer_import_template.xlsx",
      });
    } catch (error) {
      toast({
        title: "Template download failed",
        description: error instanceof Error ? error.message : "Please try again.",
        variant: "destructive",
      });
    }
  };
  return {
    downloadImportTemplate,
    handleConfirmedImport,
    handleImportFileChange,
    handleImportParse,
    handleImportSubmit,
    handleImportValidate,
  };
}
