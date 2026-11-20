import { UnifiedAccountPicker } from "@/components/accounts/UnifiedAccountPicker";
// Extracted from ./POImport.tsx to keep that module under the source-size cap.
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FileSpreadsheet } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SupplierCombobox } from "./poimport/poImportShared";
import { useErpPOImportState } from "./useErpPOImportState";

export function ErpPOImportCardSection({
  containerNumber,
  file,
  freightPaidBy,
  freightParentAccountId,
  handleFileChange,
  handleParse,
  importCurrency,
  importDate,
  isNativeZmw,
  lockedRate,
  parentFreightAccounts,
  parseMutation,
  preview,
  rateLoading,
  requiresImportCurrency,
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
}: Pick<
  ReturnType<typeof useErpPOImportState>,
  | "containerNumber"
  | "file"
  | "freightPaidBy"
  | "freightParentAccountId"
  | "handleFileChange"
  | "handleParse"
  | "importCurrency"
  | "importDate"
  | "isNativeZmw"
  | "lockedRate"
  | "parentFreightAccounts"
  | "parseMutation"
  | "preview"
  | "rateLoading"
  | "requiresImportCurrency"
  | "selectedContainer"
  | "selectedSupplier"
  | "setContainerNumber"
  | "setFreightPaidBy"
  | "setFreightParentAccountId"
  | "setImportCurrency"
  | "setImportDate"
  | "setSelectedSupplier"
  | "setValidationResult"
  | "suppliers"
  | "suppliersError"
  | "suppliersLoading"
>) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Upload Purchase Order Excel File</CardTitle>
        <CardDescription>
          Three-step process: Parse → Validate → Import. Need help? Download the template above to see the required
          format.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="file-upload">Step 1: Select & Parse Excel File (.xlsx)</Label>
          <div className="flex flex-col sm:flex-row gap-2">
            <Input
              id="file-upload"
              type="file"
              accept=".xlsx,.xls"
              onChange={handleFileChange}
              data-testid="input-file-upload"
            />
            <Button onClick={handleParse} disabled={!file || parseMutation.isPending} data-testid="button-parse">
              {parseMutation.isPending ? (
                "Parsing..."
              ) : (
                <>
                  <FileSpreadsheet className="w-4 h-4 mr-2" />
                  Parse
                </>
              )}
            </Button>
          </div>
          {file && <p className="text-sm text-muted-foreground">Selected: {file.name}</p>}
        </div>

        {preview && (
          <div className="space-y-4">
            {selectedContainer &&
              (/^FD-/i.test(selectedContainer.containerNumber) ||
                selectedContainer.items.some((i) => /^FDPO-/i.test(i.poNumber))) && (
                <div
                  className="rounded-lg border border-blue-300 bg-blue-50/70 p-4 text-sm dark:border-blue-800 dark:bg-blue-950/20"
                  data-testid="factory-trip-po-import-notice"
                >
                  <p className="font-semibold">Factory Dispatch — manual truck PO import</p>
                  <p className="mt-1">
                    This Excel file represents one financially finalized Factory truck. You must select the exact ERP
                    supplier code{" "}
                    {selectedContainer.supplierCode ? (
                      <strong className="font-mono">{selectedContainer.supplierCode}</strong>
                    ) : (
                      "(shown in the file)"
                    )}{" "}
                    and validate every article code before importing.
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    ERP articles are matched by exact code or alias, not a similar item name. If any code is missing,
                    create the correct ERP article/alias first and validate again. Purchase rates and charges are
                    independently valued for ERP; re-importing the same truck is blocked, even if its file name or rates
                    change.
                  </p>
                </div>
              )}
            <Label>Step 2: Configure Import Details</Label>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="space-y-2">
                <Label htmlFor="supplier">Supplier *</Label>
                <SupplierCombobox
                  value={selectedSupplier}
                  onValueChange={(supplierId) => {
                    setSelectedSupplier(supplierId);
                    setValidationResult(null);
                  }}
                  suppliers={suppliers}
                  placeholder="Select supplier"
                  testId="select-supplier"
                  isLoading={suppliersLoading}
                  hasError={suppliersError}
                />
                {suppliersError && (
                  <p className="text-sm text-destructive">Suppliers could not be loaded for the active company.</p>
                )}
              </div>
              <div className="space-y-2">
                <Label htmlFor="container-number">Container Number *</Label>
                <Input
                  id="container-number"
                  value={containerNumber}
                  onChange={(e) => {
                    setContainerNumber(e.target.value);
                    setValidationResult(null);
                  }}
                  placeholder="CNTR-001"
                  data-testid="input-container-number"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="import-date">Import Date</Label>
                <Input
                  id="import-date"
                  type="date"
                  value={importDate}
                  onChange={(e) => {
                    setImportDate(e.target.value);
                    setValidationResult(null);
                  }}
                  data-testid="input-import-date"
                />
              </div>
              {requiresImportCurrency && (
                <div className="space-y-2">
                  <Label htmlFor="import-currency">Invoice Currency *</Label>
                  <Select
                    value={importCurrency}
                    onValueChange={(value) => {
                      setImportCurrency(value === "ZMW" ? "ZMW" : "USD");
                      setValidationResult(null);
                    }}
                  >
                    <SelectTrigger id="import-currency" data-testid="select-import-currency">
                      <SelectValue placeholder="Select USD or ZMW" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="USD">USD — invoice prices in dollars</SelectItem>
                      <SelectItem value="ZMW">ZMW — invoice prices in Kwacha (K)</SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    Applies to every line of this import. The spreadsheet must not state a different currency.
                  </p>
                </div>
              )}
              {isNativeZmw && (
                <div className="space-y-2">
                  <Label>Historical USD/ZMW rate (ZMW per USD)</Label>
                  <Input readOnly value={rateLoading ? "Loading approved rate..." : lockedRate || "No approved rate"} />
                  <p className="text-xs text-muted-foreground">
                    Original invoice prices remain ZMW; inventory, freight, goods-in-transit and parent postings use the
                    locked USD base.
                    {!lockedRate && !rateLoading ? " An approved company rate for the import date is required." : ""}
                  </p>
                </div>
              )}
            </div>

            {Number(selectedContainer?.charges?.freight || 0) > 0 && parentFreightAccounts.length > 0 && (
              <div className="space-y-3 pt-1">
                <Label>Freight Paid By</Label>
                <div className="flex gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant={freightPaidBy === "supplier" ? "default" : "outline"}
                    onClick={() => {
                      setFreightPaidBy("supplier");
                      setFreightParentAccountId("");
                    }}
                    data-testid="button-freight-by-supplier"
                  >
                    By Supplier
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant={freightPaidBy === "parent" ? "default" : "outline"}
                    onClick={() => setFreightPaidBy("parent")}
                    data-testid="button-freight-by-parent"
                  >
                    Parent Co.
                  </Button>
                </div>
                {freightPaidBy === "parent" && (
                  <div className="space-y-1">
                    <Label>Parent Freight Account *</Label>
                    <UnifiedAccountPicker
                      options={parentFreightAccounts.map((account) => ({ value: String(account.id), name: account.name }))}
                      value={freightParentAccountId}
                      onChange={setFreightParentAccountId}
                      placeholder="Select account..."
                      testId="select-freight-parent-account"
                    />
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
