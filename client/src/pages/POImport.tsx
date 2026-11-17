import SpPOImport from "./SpPOImport";
import PropertiesIntercompanyPOImport from "./poimport/PropertiesIntercompanyPOImport";
import { PageHeader } from "@/components/PageHeader";
import { ErpListTable } from "@/erp-core";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useCompany } from "@/contexts/CompanyContext";
import { CheckCircle, XCircle, Download, RefreshCw } from "lucide-react";

import { formatCurrency, type POImportItem, type POImportContainer } from "./poimport/poImportShared";
import { ErpPOImportSection, useErpPOImportState } from "./useErpPOImportState";
import { ErpPOImportCardSection } from "./ErpPOImportCardSection";

function ErpPOImport() {
  const {
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
  } = useErpPOImportState();

  return (
    <div className="space-y-4">
      <PageHeader title="PO Import (Excel)">
        <Button variant="outline" asChild data-testid="button-download-template">
          <a href="/api/po-import/template" download="po-import-template.xlsx">
            <Download className="w-4 h-4 mr-2" />
            Download Template
          </a>
        </Button>
      </PageHeader>

      <ErpPOImportCardSection
        containerNumber={containerNumber}
        file={file}
        freightPaidBy={freightPaidBy}
        freightParentAccountId={freightParentAccountId}
        handleFileChange={handleFileChange}
        handleParse={handleParse}
        importCurrency={importCurrency}
        importDate={importDate}
        isNativeZmw={isNativeZmw}
        lockedRate={lockedRate}
        parentFreightAccounts={parentFreightAccounts}
        parseMutation={parseMutation}
        preview={preview}
        rateLoading={rateLoading}
        requiresImportCurrency={requiresImportCurrency}
        selectedContainer={selectedContainer}
        selectedSupplier={selectedSupplier}
        setContainerNumber={setContainerNumber}
        setFreightPaidBy={setFreightPaidBy}
        setFreightParentAccountId={setFreightParentAccountId}
        setImportCurrency={setImportCurrency}
        setImportDate={setImportDate}
        setSelectedSupplier={setSelectedSupplier}
        setValidationResult={setValidationResult}
        suppliers={suppliers}
        suppliersError={suppliersError}
        suppliersLoading={suppliersLoading}
      />

      {preview && preview.preview.length > 0 && (
        <Card>
          <CardHeader>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <CardTitle>Preview & Validation</CardTitle>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={refreshStockItems}
                disabled={refreshStockItemsMutation.isPending}
                data-testid="button-refresh-po-stock-items"
              >
                <RefreshCw className="w-4 h-4 mr-2" />
                {refreshStockItemsMutation.isPending ? "Refreshing..." : "Refresh stock items"}
              </Button>
            </div>
            <CardDescription>
              Review the data and validate before importing. {preview.preview.length} container(s) found
            </CardDescription>
          </CardHeader>
          <CardContent>
            {validationResult && hasValidationErrors && (
              <div className="mb-4 p-4 bg-destructive/10 border border-destructive rounded-md">
                <div className="flex items-start gap-2">
                  <XCircle className="w-5 h-5 text-destructive mt-0.5" />
                  <div>
                    <h3 className="font-semibold text-destructive">Validation Errors Found</h3>
                    <ul className="mt-2 space-y-1 text-sm text-destructive">
                      {validationResult.errors.map((error: React.ReactNode, idx: number) => (
                        <li key={idx}>• {error}</li>
                      ))}
                    </ul>
                  </div>
                </div>
              </div>
            )}

            {validationResult && !hasValidationErrors && (
              <div className="mb-4 p-4 bg-green-500/10 border border-green-500 rounded-md">
                <div className="flex items-start gap-2">
                  <CheckCircle className="w-5 h-5 text-green-600 mt-0.5" />
                  <div>
                    <h3 className="font-semibold text-green-600">Validation Passed</h3>
                    <p className="mt-1 text-sm text-green-600">All items validated successfully. Ready to import.</p>
                  </div>
                </div>
              </div>
            )}

            {preview.preview.map((container: POImportContainer, idx: number) => (
              <div key={idx} className="space-y-4 mb-6">
                <div className="flex items-center justify-between">
                  <h3 className="text-lg font-semibold">Container: {container.containerNumber}</h3>
                  <div className="flex gap-4 text-sm">
                    <span className="text-muted-foreground">{container.itemsCount} items</span>
                    <span className="text-muted-foreground">{container.posCount} PO(s)</span>
                  </div>
                </div>
                <div className="rounded-md border">
                  <ErpListTable
                    pageKey="po-import-preview"
                    companyId={selectedCompany?.id}
                    showDensityControl={false}
                    scrollLabel="PO import preview"
                  >
                    <TableHeader className="sticky top-0 z-30 bg-background">
                      <TableRow>
                        <TableHead>PO Number</TableHead>
                        <TableHead>Item Name</TableHead>
                        <TableHead className="text-right">Quantity</TableHead>
                        <TableHead className="text-right">Rate</TableHead>
                        <TableHead className="text-right">Line Total</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {container.items.map((item: POImportItem, itemIdx: number) => (
                        <TableRow key={itemIdx}>
                          <TableCell>{item.poNumber}</TableCell>
                          <TableCell>{item.itemName || item.barcode || "Unmatched item"}</TableCell>
                          <TableCell className="text-right">{formatCurrency(Number(item.quantity))}</TableCell>
                          <TableCell className="text-right">
                            {priceSymbol}
                            {formatCurrency(Number(item.rate))}
                          </TableCell>
                          <TableCell className="text-right font-medium">
                            {priceSymbol}
                            {formatCurrency(Number(item.lineTotal))}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </ErpListTable>
                </div>

                <div className="grid grid-cols-2 md:grid-cols-3 gap-4 p-4 bg-muted rounded-md">
                  <div>
                    <p className="text-sm text-muted-foreground">Items Total</p>
                    <p className="text-lg font-semibold">
                      {priceSymbol}
                      {formatCurrency(Number(container.itemsTotal))}
                    </p>
                  </div>
                  {Number(container.charges.freight) > 0 && (
                    <div>
                      <p className="text-sm text-muted-foreground">Freight</p>
                      <p className="text-lg font-semibold">
                        {priceSymbol}
                        {formatCurrency(Number(container.charges.freight))}
                      </p>
                    </div>
                  )}
                  {Number(container.charges.surcharge) > 0 && (
                    <div>
                      <p className="text-sm text-muted-foreground">Surcharge</p>
                      <p className="text-lg font-semibold">
                        {priceSymbol}
                        {formatCurrency(Number(container.charges.surcharge))}
                      </p>
                    </div>
                  )}
                  {Number(container.charges.fumigation) > 0 && (
                    <div>
                      <p className="text-sm text-muted-foreground">Fumigation</p>
                      <p className="text-lg font-semibold">
                        {priceSymbol}
                        {formatCurrency(Number(container.charges.fumigation))}
                      </p>
                    </div>
                  )}
                  {Number(container.charges.discount) > 0 && (
                    <div>
                      <p className="text-sm text-muted-foreground">Discount</p>
                      <p className="text-lg font-semibold text-red-500">
                        -{priceSymbol}
                        {formatCurrency(Number(container.charges.discount))}
                      </p>
                    </div>
                  )}
                  {Number(container.charges.documentCharges) > 0 && (
                    <div>
                      <p className="text-sm text-muted-foreground">Document Charges</p>
                      <p className="text-lg font-semibold">
                        {priceSymbol}
                        {formatCurrency(Number(container.charges.documentCharges))}
                      </p>
                    </div>
                  )}
                  <div className="col-span-full border-t pt-2">
                    <p className="text-sm text-muted-foreground">Grand Total</p>
                    <p className="text-xl font-bold">
                      {priceSymbol}
                      {formatCurrency(Number(container.grandTotal))}
                    </p>
                  </div>
                </div>
              </div>
            ))}

            <ErpPOImportSection
              containerNumber={containerNumber}
              handleCancel={handleCancel}
              handleImport={handleImport}
              handleValidate={handleValidate}
              hasValidationErrors={hasValidationErrors}
              importCurrency={importCurrency}
              importMutation={importMutation}
              isValidated={isValidated}
              requiresImportCurrency={requiresImportCurrency}
              selectedSupplier={selectedSupplier}
              suppliersError={suppliersError}
              suppliersLoading={suppliersLoading}
              validateMutation={validateMutation}
            />
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// Keep ERP and Supplier Payable routes identical from the user perspective,
// while keeping their separate accounting and import endpoints.
export default function POImport() {
  const { selectedCompany } = useCompany();
  if (selectedCompany?.companyType === "properties") return <PropertiesIntercompanyPOImport />;
  return selectedCompany?.companyType === "supplier_partner" ? <SpPOImport /> : <ErpPOImport />;
}
