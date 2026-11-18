import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ArrowRight, CheckCircle, FileSpreadsheet, Loader2, Search, Upload, Wrench } from "lucide-react";
import { ImportBalesTab } from "../bale-stock-entry/ImportBalesTab";
import { LEGACY_FACTORY_RENAME_DEFAULTS } from "@shared/factoryUiDefaults";
import { useFactorySettingsAdminToolsState, type Props } from "./useFactorySettingsAdminToolsState";
import { FactorySettingsAdminToolsCardSection } from "./FactorySettingsAdminToolsCardSection";
import { FactorySettingsAdminToolsCardFixOcCurrency } from "./FactorySettingsAdminToolsCardFixOcCurrency";

export function FactorySettingsAdminTools(props: Props) {
  const {
    applyMutation,
    baleFileInputRef,
    baleImportFile,
    baleImportLocationId,
    baleImportMutation,
    baleImportResult,
    baleValidateMutation,
    baleValidationResult,
    codePrefix,
    excelFile,
    excelResult,
    excelUploadMutation,
    fileInputRef,
    findStr,
    isDeveloper,
    locations,
    ocFixMutation,
    ocFixResult,
    ocPreview,
    ocPreviewMutation,
    previewMutation,
    renamePreview,
    replaceStr,
    setBaleImportFile,
    setBaleImportLocationId,
    setBaleImportResult,
    setBaleValidationResult,
    setCodePrefix,
    setExcelFile,
    setExcelResult,
    setFindStr,
    setRenamePreview,
    setReplaceStr,
  } = useFactorySettingsAdminToolsState(props);

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
                placeholder={LEGACY_FACTORY_RENAME_DEFAULTS.codePrefix}
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

      <FactorySettingsAdminToolsCardSection
        baleFileInputRef={baleFileInputRef}
        baleImportFile={baleImportFile}
        baleImportLocationId={baleImportLocationId}
        baleImportMutation={baleImportMutation}
        baleImportResult={baleImportResult}
        baleValidateMutation={baleValidateMutation}
        baleValidationResult={baleValidationResult}
        locations={locations}
        setBaleImportFile={setBaleImportFile}
        setBaleImportLocationId={setBaleImportLocationId}
        setBaleImportResult={setBaleImportResult}
        setBaleValidationResult={setBaleValidationResult}
      />

      {isDeveloper && (
        <FactorySettingsAdminToolsCardFixOcCurrency
          ocFixMutation={ocFixMutation}
          ocFixResult={ocFixResult}
          ocPreview={ocPreview}
          ocPreviewMutation={ocPreviewMutation}
        />
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
