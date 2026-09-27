import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle,
  DollarSign,
  Download,
  FileSpreadsheet,
  Loader2,
  Search,
  Upload,
  Wrench,
} from "lucide-react";
import { ImportBalesTab } from "../bale-stock-entry/ImportBalesTab";
import type { useFactorySettingsModel } from "./useFactorySettingsModel";

type Props = {
  model: ReturnType<typeof useFactorySettingsModel>;
};

export function FactorySettingsAdminTools({ model }: Props) {
  const {
    isDeveloper,
    locations,
    codePrefix,
    setCodePrefix,
    findStr,
    setFindStr,
    replaceStr,
    setReplaceStr,
    renamePreview,
    setRenamePreview,
    previewMutation,
    applyMutation,
    excelFile,
    setExcelFile,
    excelResult,
    setExcelResult,
    fileInputRef,
    excelUploadMutation,
    baleImportFile,
    setBaleImportFile,
    baleImportResult,
    setBaleImportResult,
    baleFileInputRef,
    baleImportLocationId,
    setBaleImportLocationId,
    baleValidationResult,
    setBaleValidationResult,
    baleValidateMutation,
    baleImportMutation,
    ocPreview,
    ocFixResult,
    ocPreviewMutation,
    ocFixMutation,
  } = model;

  return (
    <>
      <Card className="md:col-span-2">
        <CardHeader>
          <div className="flex items-center gap-2">
            <Wrench className="h-5 w-5 text-muted-foreground" />
            <CardTitle data-testid="text-section-data-cleanup">Data Cleanup</CardTitle>
          </div>
          <CardDescription>Find products by code prefix and rename them in bulk</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-2">
              <Label htmlFor="codePrefix">Code Prefix</Label>
              <Input
                id="codePrefix"
                value={codePrefix}
                onChange={(event) => {
                  setCodePrefix(event.target.value);
                  setRenamePreview(null);
                }}
                placeholder="e.g. HMD13"
                data-testid="input-code-prefix"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="findStr">Find in Name</Label>
              <Input
                id="findStr"
                value={findStr}
                onChange={(event) => {
                  setFindStr(event.target.value);
                  setRenamePreview(null);
                }}
                placeholder="e.g. -"
                data-testid="input-find-str"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="replaceStr">Replace With</Label>
              <Input
                id="replaceStr"
                value={replaceStr}
                onChange={(event) => {
                  setReplaceStr(event.target.value);
                  setRenamePreview(null);
                }}
                placeholder="e.g. (space)"
                data-testid="input-replace-str"
              />
            </div>
          </div>
          <Button
            onClick={() => previewMutation.mutate()}
            disabled={previewMutation.isPending || !codePrefix.trim() || !findStr}
            data-testid="button-preview-rename"
          >
            {previewMutation.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin mr-2" />
            ) : (
              <Search className="h-4 w-4 mr-2" />
            )}
            Preview Changes
          </Button>

          {renamePreview && renamePreview.length > 0 && (
            <div className="space-y-3">
              <div className="text-sm text-muted-foreground">{renamePreview.length} product(s) will be renamed:</div>
              <div className="max-h-80 overflow-y-auto border rounded-md">
                <Table mobileLayout="cards">
                  <TableHeader className="sticky top-0 z-30 bg-background">
                    <TableRow>
                      <TableHead>Code</TableHead>
                      <TableHead>Current Name</TableHead>
                      <TableHead className="w-8" />
                      <TableHead>New Name</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {renamePreview.map((item) => (
                      <TableRow key={item.id} data-testid={`row-rename-${item.id}`}>
                        <TableCell className="font-mono text-xs">{item.code}</TableCell>
                        <TableCell>{item.currentName}</TableCell>
                        <TableCell>
                          <ArrowRight className="h-4 w-4 text-muted-foreground" />
                        </TableCell>
                        <TableCell className="font-medium">{item.newName}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              <Button
                onClick={() => applyMutation.mutate(renamePreview)}
                disabled={applyMutation.isPending}
                data-testid="button-apply-rename"
              >
                {applyMutation.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin mr-2" />
                ) : (
                  <CheckCircle className="h-4 w-4 mr-2" />
                )}
                Apply {renamePreview.length} Rename(s)
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="md:col-span-2">
        <CardHeader>
          <div className="flex items-center gap-2">
            <Upload className="h-5 w-5 text-muted-foreground" />
            <CardTitle data-testid="text-section-excel-import">Excel Product Import</CardTitle>
          </div>
          <CardDescription>
            Upload an Excel file to update bale product names, weights, and categories by matching on article code
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="text-sm text-muted-foreground space-y-1">
            <p>Your Excel file should have these column headers:</p>
            <ul className="list-disc list-inside ml-2 space-y-0.5">
              <li>
                <span className="font-mono text-xs">articleCode</span> (required) - matches existing products
              </li>
              <li>
                <span className="font-mono text-xs">name</span> - new product name
              </li>
              <li>
                <span className="font-mono text-xs">weightPerBaleKg</span> - weight per bale in KG
              </li>
              <li>
                <span className="font-mono text-xs">category</span> - product category (auto-created if new)
              </li>
              <li>
                <span className="font-mono text-xs">description</span> - product description (optional)
              </li>
            </ul>
          </div>
          <div className="flex items-center gap-3 flex-wrap">
            <input
              ref={fileInputRef}
              type="file"
              accept=".xlsx,.xls,.csv"
              onChange={(event) => {
                setExcelFile(event.target.files?.[0] || null);
                setExcelResult(null);
              }}
              className="text-sm file:mr-3 file:rounded-md file:border-0 file:bg-primary file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-primary-foreground hover:file:bg-primary/90 cursor-pointer"
              data-testid="input-excel-file"
            />
            <Button
              onClick={() => excelFile && excelUploadMutation.mutate(excelFile)}
              disabled={!excelFile || excelUploadMutation.isPending}
              data-testid="button-upload-excel"
            >
              {excelUploadMutation.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
              ) : (
                <Upload className="h-4 w-4 mr-2" />
              )}
              {excelUploadMutation.isPending ? "Importing..." : "Import"}
            </Button>
          </div>
          {excelResult && (
            <div className="flex items-center gap-2 p-3 rounded-md bg-muted text-sm" data-testid="text-excel-result">
              <CheckCircle className="h-4 w-4 text-green-600" />
              <span>
                {excelResult.updated} product(s) updated, {excelResult.created} new product(s) created
                {excelResult.categoriesCreated > 0 ? `, ${excelResult.categoriesCreated} new category(ies)` : ""}
              </span>
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="md:col-span-2">
        <CardHeader>
          <div className="flex items-center gap-2">
            <Upload className="h-5 w-5 text-muted-foreground" />
            <CardTitle data-testid="text-section-bale-import">Import Historical Bales</CardTitle>
          </div>
          <CardDescription>
            Upload an Excel file to import old stock as bales. Each row creates bales with automatic REF codes and the
            specified production date.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="text-sm text-muted-foreground space-y-1">
            <p>Your Excel file should have these column headers:</p>
            <ul className="list-disc list-inside ml-2 space-y-0.5">
              <li>
                <span className="font-mono text-xs">ITEM BARCODE</span> (required) - article code to match existing
                products (e.g. HMD11298)
              </li>
              <li>
                <span className="font-mono text-xs">QUANTITY</span> - number of bales to create (default: 1)
              </li>
              <li>
                <span className="font-mono text-xs">PRODUCTION DATE</span> - date the bales were produced (required)
              </li>
            </ul>
            <p className="mt-2 text-xs">
              Products must already exist in the system. The weight will be taken from the product definition.
            </p>
          </div>
          <div className="space-y-2">
            <Label>Location / Warehouse</Label>
            <Select value={baleImportLocationId} onValueChange={setBaleImportLocationId}>
              <SelectTrigger className="w-64" data-testid="select-bale-import-location">
                <SelectValue placeholder="Select location..." />
              </SelectTrigger>
              <SelectContent>
                {locations?.map((location) => (
                  <SelectItem key={location.id} value={String(location.id)}>
                    {location.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center gap-3 flex-wrap">
            <Button
              variant="outline"
              onClick={() => {
                const header = "ITEM BARCODE\tQUANTITY\tPRODUCTION DATE\n";
                const example = "HMD11298\t1\t2/11/2026\n";
                const blob = new Blob([header + example], { type: "application/vnd.ms-excel" });
                const url = URL.createObjectURL(blob);
                const anchor = document.createElement("a");
                anchor.href = url;
                anchor.download = "bale_import_template.xls";
                anchor.click();
                URL.revokeObjectURL(url);
              }}
              data-testid="button-download-bale-template"
            >
              <Download className="h-4 w-4 mr-2" />
              Download Template
            </Button>
          </div>
          <div className="flex items-center gap-3 flex-wrap">
            <input
              ref={baleFileInputRef}
              type="file"
              accept=".xlsx,.xls,.csv"
              onChange={(event) => {
                setBaleImportFile(event.target.files?.[0] || null);
                setBaleImportResult(null);
                setBaleValidationResult(null);
              }}
              className="text-sm file:mr-3 file:rounded-md file:border-0 file:bg-primary file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-primary-foreground hover:file:bg-primary/90 cursor-pointer"
              data-testid="input-bale-import-file"
            />
            <Button
              onClick={() => baleImportFile && baleValidateMutation.mutate(baleImportFile)}
              disabled={!baleImportFile || baleValidateMutation.isPending}
              data-testid="button-validate-bales"
            >
              {baleValidateMutation.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
              ) : (
                <Search className="h-4 w-4 mr-2" />
              )}
              {baleValidateMutation.isPending ? "Validating..." : "Validate"}
            </Button>
          </div>

          {baleValidationResult && (
            <div className="space-y-3">
              <div className="flex items-center gap-4 flex-wrap p-3 rounded-md bg-muted text-sm">
                <span>
                  Total rows: <strong>{baleValidationResult.totalRows}</strong>
                </span>
                <span>
                  Valid: <strong className="text-green-600">{baleValidationResult.validRows.length}</strong>
                </span>
                <span>
                  Skipped:{" "}
                  <strong className={baleValidationResult.skippedRows.length > 0 ? "text-destructive" : ""}>
                    {baleValidationResult.skippedRows.length}
                  </strong>
                </span>
                <span>
                  Bales to create: <strong>{baleValidationResult.totalBales}</strong>
                </span>
                <span>
                  Total weight: <strong>{baleValidationResult.totalWeight.toFixed(1)} kg</strong>
                </span>
              </div>

              {baleValidationResult.validRows.length > 0 && (
                <div className="border rounded-md overflow-auto max-h-64">
                  <Table mobileLayout="cards">
                    <TableHeader className="sticky top-0 z-30 bg-background">
                      <TableRow>
                        <TableHead className="w-12">Row</TableHead>
                        <TableHead>Article Code</TableHead>
                        <TableHead>Product Name</TableHead>
                        <TableHead className="text-right">Qty</TableHead>
                        <TableHead className="text-right">Weight (kg)</TableHead>
                        <TableHead>Production Date</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {baleValidationResult.validRows.map((row, index) => (
                        <TableRow key={index}>
                          <TableCell className="text-muted-foreground text-xs">{row.rowIndex}</TableCell>
                          <TableCell className="font-mono text-xs">{row.articleCode}</TableCell>
                          <TableCell>{row.productName}</TableCell>
                          <TableCell className="text-right">{row.quantity}</TableCell>
                          <TableCell className="text-right">{row.weight}</TableCell>
                          <TableCell>{row.productionDate}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}

              {baleValidationResult.skippedRows.length > 0 && (
                <div className="text-xs p-3 rounded-md border border-destructive/30 space-y-1">
                  <p className="font-medium text-destructive text-sm">Skipped rows:</p>
                  {baleValidationResult.skippedRows.map((row, index) => (
                    <p key={index} className="text-muted-foreground">
                      Row {row.rowIndex}: {row.articleCode ? `"${row.articleCode}"` : "(empty)"} - {row.reason}
                    </p>
                  ))}
                </div>
              )}

              {baleValidationResult.validRows.length > 0 && (
                <div className="flex items-center gap-3 flex-wrap pt-2">
                  <Button
                    onClick={() => baleImportFile && baleImportMutation.mutate(baleImportFile)}
                    disabled={!baleImportFile || baleImportMutation.isPending || !baleImportLocationId}
                    data-testid="button-finalize-import-bales"
                  >
                    {baleImportMutation.isPending ? (
                      <Loader2 className="h-4 w-4 animate-spin mr-2" />
                    ) : (
                      <Upload className="h-4 w-4 mr-2" />
                    )}
                    {baleImportMutation.isPending
                      ? "Importing..."
                      : `Finalize Import (${baleValidationResult.totalBales} bales)`}
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => {
                      setBaleValidationResult(null);
                      setBaleImportFile(null);
                      if (baleFileInputRef.current) baleFileInputRef.current.value = "";
                    }}
                    data-testid="button-cancel-import"
                  >
                    Cancel
                  </Button>
                  {!baleImportLocationId && (
                    <span className="text-xs text-destructive">Please select a location above before finalizing</span>
                  )}
                </div>
              )}
            </div>
          )}

          {baleImportResult && (
            <div className="space-y-2">
              <div
                className="flex items-center gap-2 p-3 rounded-md bg-muted text-sm"
                data-testid="text-bale-import-result"
              >
                <CheckCircle className="h-4 w-4 text-green-600" />
                <span>
                  {baleImportResult.totalBalesCreated} bale(s) created with automatic REF codes
                  {baleImportResult.skippedRows > 0 ? ` | ${baleImportResult.skippedRows} row(s) skipped` : ""}
                </span>
              </div>
              {baleImportResult.skippedDetails.length > 0 && (
                <div className="text-xs text-muted-foreground p-2 rounded-md border space-y-0.5">
                  <p className="font-medium">Skipped rows:</p>
                  {baleImportResult.skippedDetails.map((detail, index) => (
                    <p key={index}>{detail}</p>
                  ))}
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {isDeveloper && (
        <Card data-testid="card-fix-oc-currency">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <DollarSign className="h-5 w-5 text-muted-foreground" />
              Fix Other Charges Currency
            </CardTitle>
            <CardDescription>
              If other charges were accidentally entered in EUR instead of USD, this tool re-posts their accounting
              entries in USD without reversing the offload. Click "Preview" first to see which containers are affected,
              then "Apply Fix".
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center gap-2 flex-wrap">
              <Button
                variant="outline"
                onClick={() => ocPreviewMutation.mutate()}
                disabled={ocPreviewMutation.isPending || ocFixMutation.isPending}
                data-testid="button-oc-currency-preview"
              >
                {ocPreviewMutation.isPending ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <Search className="h-4 w-4 mr-2" />
                )}
                Preview
              </Button>
              {ocPreview && ocPreview.length > 0 && (
                <Button
                  onClick={() => ocFixMutation.mutate(ocPreview.map((container) => container.containerId))}
                  disabled={ocFixMutation.isPending}
                  data-testid="button-oc-currency-apply"
                >
                  {ocFixMutation.isPending ? (
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  ) : (
                    <DollarSign className="h-4 w-4 mr-2" />
                  )}
                  Apply Fix — Re-post as USD ({ocPreview.length} container{ocPreview.length !== 1 ? "s" : ""})
                </Button>
              )}
            </div>

            {ocPreview && ocPreview.length > 0 && (
              <div className="space-y-2" data-testid="section-oc-preview">
                <div className="flex items-center gap-2 text-sm text-amber-700 dark:text-amber-400 p-2 bg-amber-50 dark:bg-amber-950/30 rounded-md">
                  <AlertTriangle className="h-4 w-4 shrink-0" />
                  <span>
                    Found <strong>{ocPreview.length}</strong> container{ocPreview.length !== 1 ? "s" : ""} with non-USD
                    other charges. The existing EUR vouchers will be deleted and replaced with USD ones. The offload
                    data is not affected.
                  </span>
                </div>
                <div className="border rounded-md overflow-hidden">
                  <Table mobileLayout="cards">
                    <TableHeader className="sticky top-0 z-30 bg-background">
                      <TableRow>
                        <TableHead>Container</TableHead>
                        <TableHead>Description</TableHead>
                        <TableHead className="text-right">Amount</TableHead>
                        <TableHead className="text-center">Current Currency</TableHead>
                        <TableHead className="text-center">Will Become</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {ocPreview.flatMap((container) =>
                        container.charges.map((charge, chargeIndex) => (
                          <TableRow
                            key={`${container.containerId}-${chargeIndex}`}
                            data-testid={`row-oc-preview-${container.containerId}-${chargeIndex}`}
                          >
                            {chargeIndex === 0 && (
                              <TableCell rowSpan={container.charges.length} className="font-medium align-top">
                                {container.containerNumber}
                              </TableCell>
                            )}
                            <TableCell className="text-muted-foreground">{charge.description}</TableCell>
                            <TableCell className="text-right font-mono">
                              {parseFloat(charge.amount).toLocaleString(undefined, {
                                minimumFractionDigits: 2,
                                maximumFractionDigits: 2,
                              })}
                            </TableCell>
                            <TableCell className="text-center">
                              <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300">
                                {charge.currencyCode}
                              </span>
                            </TableCell>
                            <TableCell className="text-center">
                              <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300">
                                USD
                              </span>
                            </TableCell>
                          </TableRow>
                        ))
                      )}
                    </TableBody>
                  </Table>
                </div>
              </div>
            )}

            {ocFixResult && (
              <div className="flex items-center gap-2 p-3 rounded-md bg-muted text-sm" data-testid="text-oc-fix-result">
                <CheckCircle className="h-4 w-4 text-green-600 shrink-0" />
                <span>
                  Done — {ocFixResult.fixed} container{ocFixResult.fixed !== 1 ? "s" : ""} re-posted in USD. The
                  accounting ledger now shows USD for those other charges.
                </span>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <FileSpreadsheet className="h-5 w-5 text-muted-foreground" />
            Import Bales
          </CardTitle>
          <CardDescription>Bulk import bales from an Excel spreadsheet template.</CardDescription>
        </CardHeader>
        <CardContent className="pt-0">
          <ImportBalesTab />
        </CardContent>
      </Card>
    </>
  );
}
