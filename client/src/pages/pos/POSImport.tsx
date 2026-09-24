/**
 * POS Import page shell.
 *
 * Keeps its route and default export. The parse/validate/import pipeline,
 * CFA→USD conversion and print snapshot live in
 * ./posimport/usePosImportModel; the upload form, validation errors, preview
 * table, print receipt and dialogs are separate views under ./posimport.
 */
import { CreditCard, Download, ShoppingCart } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/PageHeader";
import { usePosImportModel } from "./posimport/usePosImportModel";
import { PosImportForm } from "./posimport/PosImportForm";
import { PosImportPreview, PosImportValidationErrors } from "./posimport/PosImportResults";
import { PosImportDialogs } from "./posimport/PosImportDialogs";

export default function POSImport() {
  const model = usePosImportModel();
  const { isCreditSale } = model;

  return (
    <div className="container mx-auto space-y-4 p-0 sm:p-4 md:space-y-6 md:p-6">
      <PageHeader
        title={isCreditSale ? "Credit Sales Import" : "POS Import"}
        subtitle={`Import ${isCreditSale ? "credit" : "cash"} sales transactions from Excel (Barcode, Quantity, Selling Rate)`}
        icon={isCreditSale ? <CreditCard className="h-5 w-5" /> : <ShoppingCart className="h-5 w-5" />}
      >
        <Button variant="outline" onClick={model.downloadTemplate} data-testid="button-download-template">
          <Download className="h-4 w-4 mr-2" />
          Download Template
        </Button>
      </PageHeader>

      <PosImportForm model={model} />
      <PosImportValidationErrors model={model} />
      <PosImportPreview model={model} />
      <PosImportDialogs model={model} />
    </div>
  );
}
