// Extracted from ./FactorySettingsAdminTools.tsx to keep that module under the source-size cap.
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { CheckCircle, Download, Loader2, Search, Upload } from "lucide-react";
import { useFactorySettingsAdminToolsState } from "./useFactorySettingsAdminToolsState";

export function FactorySettingsAdminToolsCardSection({
  baleFileInputRef,
  baleImportFile,
  baleImportLocationId,
  baleImportMutation,
  baleImportResult,
  baleValidateMutation,
  baleValidationResult,
  locations,
  setBaleImportFile,
  setBaleImportLocationId,
  setBaleImportResult,
  setBaleValidationResult,
}: Pick<
  ReturnType<typeof useFactorySettingsAdminToolsState>,
  | "baleFileInputRef"
  | "baleImportFile"
  | "baleImportLocationId"
  | "baleImportMutation"
  | "baleImportResult"
  | "baleValidateMutation"
  | "baleValidationResult"
  | "locations"
  | "setBaleImportFile"
  | "setBaleImportLocationId"
  | "setBaleImportResult"
  | "setBaleValidationResult"
>) {
  return (
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
  );
}
