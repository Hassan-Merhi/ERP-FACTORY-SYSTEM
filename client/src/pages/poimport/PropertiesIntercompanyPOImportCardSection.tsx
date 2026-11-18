// Extracted from ./PropertiesIntercompanyPOImport.tsx to keep that module under the source-size cap.
import { FileSpreadsheet, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { usePropertiesIntercompanyPOImportState } from "./usePropertiesIntercompanyPOImportState";

export function PropertiesIntercompanyPOImportCardSection({
  changeDefault,
  changeFile,
  companyId,
  copy,
  defaultDestinationId,
  file,
  fileInputVersion,
  importDate,
  importMutation,
  navigate,
  previewMutation,
  setImportDate,
  setSupplierId,
  setup,
  supplierId,
}: Pick<
  ReturnType<typeof usePropertiesIntercompanyPOImportState>,
  | "changeDefault"
  | "changeFile"
  | "companyId"
  | "copy"
  | "defaultDestinationId"
  | "file"
  | "fileInputVersion"
  | "importDate"
  | "importMutation"
  | "navigate"
  | "previewMutation"
  | "setImportDate"
  | "setSupplierId"
  | "setup"
  | "supplierId"
>) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <FileSpreadsheet className="h-5 w-5" /> {copy.uploadTitle}
        </CardTitle>
        <CardDescription>{copy.uploadDescription}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-[220px] flex-1 space-y-2">
            <Label htmlFor="properties-po-file">{copy.chooseFile}</Label>
            <Input
              id="properties-po-file"
              key={`${companyId}:${fileInputVersion}`}
              type="file"
              accept=".xlsx"
              data-testid="input-file-upload"
              disabled={importMutation.isPending}
              onChange={(event) => changeFile(event.target.files?.[0] ?? null)}
            />
          </div>
          <Button
            type="button"
            disabled={!file || previewMutation.isPending || importMutation.isPending || !setup?.destinations.length}
            onClick={() => file && previewMutation.mutate({ selectedFile: file, requestedCompanyId: companyId })}
            data-testid="button-parse"
          >
            <Upload className="mr-2 h-4 w-4" />
            {previewMutation.isPending ? copy.parsing : copy.parse}
          </Button>
          <Button type="button" variant="outline" onClick={() => navigate("/properties/suppliers")}>
            {copy.supplierLink}
          </Button>
        </div>
        {file && (
          <p className="text-xs text-muted-foreground">
            {copy.selected} {file.name}
          </p>
        )}
        {setup && setup.destinations.length === 0 && (
          <p role="alert" className="text-sm text-destructive">
            {copy.noDestinations}
          </p>
        )}
        <div className="grid gap-4 md:grid-cols-3">
          <div className="space-y-2">
            <Label htmlFor="properties-po-supplier">{copy.supplier}</Label>
            <select
              id="properties-po-supplier"
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
              value={supplierId}
              disabled={importMutation.isPending}
              onChange={(event) => setSupplierId(event.target.value)}
              data-testid="select-supplier"
            >
              <option value="">{copy.chooseSupplier}</option>
              {(setup?.suppliers ?? [])
                .filter((supplier) => supplier.companyId === companyId)
                .map((supplier) => (
                  <option value={supplier.id} key={supplier.id}>
                    {supplier.code} — {supplier.legalName}
                  </option>
                ))}
            </select>
            {setup && !setup.suppliers.some((supplier) => supplier.companyId === companyId) && (
              <p className="text-xs text-destructive">{copy.noSuppliers}</p>
            )}
          </div>
          <div className="space-y-2">
            <Label htmlFor="properties-po-date">{copy.importDate}</Label>
            <Input
              id="properties-po-date"
              type="date"
              value={importDate}
              disabled={importMutation.isPending}
              onChange={(event) => setImportDate(event.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="properties-po-default">{copy.defaultDestination}</Label>
            <select
              id="properties-po-default"
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
              value={defaultDestinationId}
              disabled={importMutation.isPending}
              onChange={(event) => changeDefault(event.target.value)}
              data-testid="select-default-erp-destination"
            >
              <option value="">{copy.chooseDestination}</option>
              {(setup?.destinations ?? []).map((company) => (
                <option key={company.id} value={company.id}>
                  {company.code} — {company.name}
                </option>
              ))}
            </select>
            <p className="text-xs text-muted-foreground">{copy.destinationHelp}</p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
