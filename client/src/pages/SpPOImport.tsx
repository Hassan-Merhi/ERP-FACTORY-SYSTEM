import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { queryClient } from "@/lib/queryClient";
import { companyQueryKey } from "@/lib/companyQueryScope";
import { useCompany } from "@/contexts/CompanyContext";
import { CheckCircle, Download, FileSpreadsheet, Upload, XCircle } from "lucide-react";
import { useApplicationLanguage } from "@/contexts/ApplicationLanguageContext";
import { SP_CONTAINER_EXCEL_IMPORT_PARSE_PATH, type SpExcelImportContainer } from "@shared/spContainerExcelImport";
import { FRESH_START_OTW_SOURCE_NAME } from "@shared/goldenCoastOtwSource";
import type { Supplier } from "@shared/schema";
import {
  isDiscountOrNegativeLine,
  money,
  requestId,
  spImportWords,
  spPost,
  type ParsedFile,
  type Validation,
} from "./SpPOImportSpPost";

/** ERP-style three-step import for Supplier Payable companies.
 * The write stays on /api/sp/containers; it does not create an ERP PO or an ERP voucher.
 */
export default function SpPOImport() {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const { selectedCompany } = useCompany();
  const { language } = useApplicationLanguage();
  const copy = spImportWords[language];
  const [file, setFile] = useState<File | null>(null);
  const [parseKey, setParseKey] = useState(requestId);
  const [importKey, setImportKey] = useState(requestId);
  const [parsedCompanyId, setParsedCompanyId] = useState<number | null>(null);
  const [parsed, setParsed] = useState<ParsedFile | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [supplierId, setSupplierId] = useState("");
  const [containerNumber, setContainerNumber] = useState("");
  const [invoiceNumber, setInvoiceNumber] = useState("");
  const [invoiceDate, setInvoiceDate] = useState(new Date().toLocaleDateString("en-CA"));
  const [validation, setValidation] = useState<Validation | null>(null);

  const { data: suppliers = [], isLoading: suppliersLoading } = useQuery<Supplier[]>({
    queryKey: companyQueryKey("/api/suppliers", selectedCompany?.id),
    enabled: Boolean(selectedCompany?.id),
  });
  const selected = parsed?.containers[selectedIndex] ?? null;
  const freshStartOtw = parsed?.freshStartOtwSource === true;
  const companyMatches = Boolean(selectedCompany?.id && parsedCompanyId === selectedCompany.id);

  function invalidateValidation() {
    setValidation(null);
    setImportKey(requestId());
  }
  function selectContainer(index: number, containers: SpExcelImportContainer[]) {
    const c = containers[index];
    setSelectedIndex(index);
    setSupplierId(c.supplierId ? String(c.supplierId) : "");
    setContainerNumber(c.containerNumber);
    setInvoiceNumber(c.suggestedInvoiceNumber);
    invalidateValidation();
  }
  function payload() {
    if (!selected) throw new Error(copy.firstParse);
    const supplier = suppliers.find((s) => String(s.id) === supplierId);
    return {
      importSource: "excel",
      supplierId: freshStartOtw ? null : Number(supplierId),
      supplierName: freshStartOtw ? FRESH_START_OTW_SOURCE_NAME : (supplier?.legalName ?? ""),
      containerNumber: containerNumber.trim(),
      invoiceNumber: invoiceNumber.trim(),
      invoiceDate,
      invoiceTotalUsd: selected.invoiceTotalUsd.toFixed(2),
      discountPct: String(selected.discountPct),
      freightEstimateUsd: String(selected.freightEstimateUsd),
      surchargeUsd: String(selected.surchargeUsd),
      fumigationUsd: String(selected.fumigationUsd),
      documentChargesUsd: String(selected.documentChargesUsd),
      notes: selected.notes,
      lines: selected.lines.map((line) => ({
        articleCode: line.articleCode,
        description: line.description,
        qty: String(line.qty),
        unitRateUsd: String(line.unitRateUsd),
        stockItemId: line.stockItemId,
      })),
    };
  }

  const parseMutation = useMutation({
    mutationFn: async () => {
      if (!file) throw new Error(copy.chooseFile);
      const form = new FormData();
      form.append("file", file);
      const response = await fetch(SP_CONTAINER_EXCEL_IMPORT_PARSE_PATH, {
        method: "POST",
        credentials: "include",
        headers: { "X-Idempotency-Key": parseKey },
        body: form,
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.message || data.errors?.join("; ") || copy.excelReadError);
      return data as ParsedFile;
    },
    onSuccess: (data) => {
      if (!data.containers.length) {
        toast({ title: copy.emptyFile, variant: "destructive" });
        return;
      }
      setParsed(data);
      setParsedCompanyId(selectedCompany?.id ?? null);
      selectContainer(0, data.containers);
      toast({ title: copy.fileParsed, description: copy.parsedHint });
    },
    onError: (error: Error) =>
      toast({ title: copy.excelParseFailed, description: error.message, variant: "destructive" }),
  });

  const validateMutation = useMutation({
    mutationFn: async (request: ReturnType<typeof payload>) => {
      return spPost<Validation>("/api/sp/containers/import-excel/validate", request, requestId());
    },
    onSuccess: (data, request) => {
      // An older response must not validate changed supplier, date, or amounts.
      if (JSON.stringify(request) !== JSON.stringify(payload())) return;
      setValidation(data);
      toast({
        title: data.errors.length ? copy.validationFailed : copy.validationPassedToast,
        description: data.errors.length ? data.errors.join("; ") : copy.ready,
        variant: data.errors.length ? "destructive" : "default",
      });
    },
    onError: (error: Error) =>
      toast({ title: copy.validationFailed, description: error.message, variant: "destructive" }),
  });
  const importMutation = useMutation({
    mutationFn: async () => {
      // Golden Coast retired the generic SP mutation after September 1.
      // Keep ordinary Supplier Partners on the legacy SP importer, but send
      // Fresh Start-owned GC containers through the supported Phase 8 flow.
      return spPost<{ id?: number; container?: { id: number } }>(
        freshStartOtw ? "/api/sp/golden-coast/phase8/containers/import-excel" : "/api/sp/containers",
        payload(),
        importKey
      );
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/sp/containers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/sp/report/payable"] });
      queryClient.invalidateQueries({ queryKey: ["/api/vouchers"] });
      toast({ title: copy.containerImported, description: copy.posted });
      navigate("/containers");
    },
    onError: (error: Error) => toast({ title: copy.importFailed, description: error.message, variant: "destructive" }),
  });

  const canValidate =
    !!selected &&
    (freshStartOtw || !!supplierId) &&
    !!containerNumber.trim() &&
    !!invoiceNumber.trim() &&
    !!invoiceDate &&
    companyMatches &&
    !validateMutation.isPending;
  const canImport = canValidate && validation !== null && validation.errors.length === 0 && !importMutation.isPending;

  return (
    <div className="space-y-4">
      <PageHeader title={copy.pageHeading}>
        <Button variant="outline" asChild>
          <a href="/api/po-import/template" download="po-import-template.xlsx">
            <Download className="h-4 w-4 mr-2" /> {copy.downloadTemplate}
          </a>
        </Button>
      </PageHeader>
      <Card>
        <CardHeader>
          <CardTitle>{copy.uploadHeading}</CardTitle>
          <CardDescription>{copy.instructions}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Label htmlFor="sp-po-file">{copy.stepOne}</Label>
          <div className="flex flex-col sm:flex-row gap-2">
            <Input
              id="sp-po-file"
              type="file"
              disabled={parseMutation.isPending || importMutation.isPending}
              accept=".xlsx,.xls"
              data-testid="input-file-upload"
              onChange={(event) => {
                setFile(event.target.files?.[0] ?? null);
                // Reset the picker for reselecting the same Excel file in Safari.
                event.currentTarget.value = "";
                setParseKey(requestId());
                setParsed(null);
                setParsedCompanyId(null);
                invalidateValidation();
              }}
            />
            <Button
              data-testid="button-parse"
              disabled={!file || parseMutation.isPending}
              onClick={() => parseMutation.mutate()}
            >
              <FileSpreadsheet className="h-4 w-4 mr-2" />
              {parseMutation.isPending ? copy.parsing : copy.parse}
            </Button>
          </div>
          {parsed && (
            <div className="space-y-3">
              <Label>{copy.stepTwo}</Label>
              {parsed.containers.length > 1 && (
                <div className="space-y-2">
                  <Label>{copy.fromFile}</Label>
                  <Select
                    value={String(selectedIndex)}
                    onValueChange={(value) => selectContainer(Number(value), parsed.containers)}
                  >
                    <SelectTrigger data-testid="select-sp-excel-container">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {parsed.containers.map((c, index) => (
                        <SelectItem key={index} value={String(index)}>
                          {c.containerNumber || copy.unnamed} — {c.itemsCount} items
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                {freshStartOtw ? (
                  <div className="space-y-2" data-testid="fresh-start-otw-source">
                    <Label>{copy.source}</Label>
                    <p className="font-medium">{copy.freshStartOtw}</p>
                    <p className="text-xs text-muted-foreground">{copy.freshStartOtwHint}</p>
                  </div>
                ) : (
                  <div className="space-y-2">
                    <Label>{copy.supplier}</Label>
                    <Select
                      value={supplierId}
                      onValueChange={(v) => {
                        setSupplierId(v);
                        invalidateValidation();
                      }}
                    >
                      <SelectTrigger data-testid="select-supplier">
                        <SelectValue placeholder={suppliersLoading ? copy.supplierLoading : copy.supplierSelect} />
                      </SelectTrigger>
                      <SelectContent>
                        {suppliers.map((s) => (
                          <SelectItem key={s.id} value={String(s.id)}>
                            {s.legalName}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-muted-foreground">
                      {copy.supplierHelp}
                      {selected?.supplierCode ? (
                        <span className="block">
                          {copy.supplierCodeHint} <strong>{selected.supplierCode}</strong>
                        </span>
                      ) : null}
                    </p>
                    {!suppliersLoading && suppliers.length === 0 && (
                      <p className="text-xs text-amber-600">{copy.supplierEmpty}</p>
                    )}
                  </div>
                )}
                <div className="space-y-2">
                  <Label>{copy.containerNumber}</Label>
                  <Input
                    value={containerNumber}
                    onChange={(e) => {
                      setContainerNumber(e.target.value);
                      invalidateValidation();
                    }}
                    data-testid="input-container-number"
                  />
                </div>
                <div className="space-y-2">
                  <Label>{copy.invoiceDate}</Label>
                  <Input
                    type="date"
                    value={invoiceDate}
                    onChange={(e) => {
                      setInvoiceDate(e.target.value);
                      invalidateValidation();
                    }}
                    data-testid="input-import-date"
                  />
                </div>
                <div className="space-y-2">
                  <Label>{copy.invoiceNumber}</Label>
                  <Input
                    value={invoiceNumber}
                    onChange={(e) => {
                      setInvoiceNumber(e.target.value);
                      invalidateValidation();
                    }}
                    data-testid="input-invoice-number"
                  />
                </div>
              </div>
              {!companyMatches && <p className="text-sm text-destructive">{copy.companyChanged}</p>}
            </div>
          )}
        </CardContent>
      </Card>
      {selected && (
        <Card>
          <CardHeader>
            <CardTitle>{copy.previewHeading}</CardTitle>
            <CardDescription>{copy.previewDescription}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {validation && (
              <div
                className={
                  validation.errors.length ? "rounded-md border border-destructive p-3" : "rounded-md border p-3"
                }
              >
                <div className="flex items-center gap-2 font-semibold">
                  {validation.errors.length ? (
                    <XCircle className="h-4 w-4 text-destructive" />
                  ) : (
                    <CheckCircle className="h-4 w-4 text-green-600" />
                  )}
                  {validation.errors.length ? copy.validationErrors : copy.validationPassed}
                </div>
                {validation.errors.map((e, i) => (
                  <p key={i} className="text-sm text-destructive">
                    {e}
                  </p>
                ))}
                {validation.warnings.map((w, i) => (
                  <p key={i} className="text-sm text-amber-600">
                    {w}
                  </p>
                ))}
              </div>
            )}
            <div className="flex flex-wrap gap-4 text-sm">
              <span>
                {copy.container} <strong>{selected.containerNumber}</strong>
              </span>
              <span>
                {selected.itemsCount} {copy.items}
              </span>
              <span>
                {selected.poNumbers.length} {copy.poCount}
              </span>
            </div>
            <div className="rounded-md border overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{copy.poNumber}</TableHead>
                    <TableHead>{copy.itemName}</TableHead>
                    <TableHead className="text-right">{copy.quantity}</TableHead>
                    <TableHead className="text-right">{copy.rate}</TableHead>
                    <TableHead className="text-right">{copy.lineTotal}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {selected.lines.map((line, index) => (
                    <TableRow key={index} className={isDiscountOrNegativeLine(line) ? "text-red-500" : undefined}>
                      <TableCell>{line.poNumber}</TableCell>
                      <TableCell>{line.description}</TableCell>
                      <TableCell className="text-right">{line.qty}</TableCell>
                      <TableCell className="text-right">{money(line.unitRateUsd)}</TableCell>
                      <TableCell className="text-right">{money(line.lineTotal)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 rounded-md bg-muted p-4">
              <div>
                <p className="text-xs text-muted-foreground">{copy.itemsTotal}</p>
                <p className="font-semibold">{money(selected.itemsTotal)}</p>
              </div>
              {selected.charges.freight !== 0 && (
                <div className={selected.charges.freight < 0 ? "text-red-500" : undefined}>
                  <p className="text-xs">{copy.freight}</p>
                  <p>{money(selected.charges.freight)}</p>
                </div>
              )}
              {selected.charges.surcharge !== 0 && (
                <div className={selected.charges.surcharge < 0 ? "text-red-500" : undefined}>
                  <p className="text-xs">{copy.surcharge}</p>
                  <p>{money(selected.charges.surcharge)}</p>
                </div>
              )}
              {selected.charges.fumigation !== 0 && (
                <div className={selected.charges.fumigation < 0 ? "text-red-500" : undefined}>
                  <p className="text-xs">{copy.fumigation}</p>
                  <p>{money(selected.charges.fumigation)}</p>
                </div>
              )}
              {selected.charges.documentCharges !== 0 && (
                <div className={selected.charges.documentCharges < 0 ? "text-red-500" : undefined}>
                  <p className="text-xs">{copy.documents}</p>
                  <p>{money(selected.charges.documentCharges)}</p>
                </div>
              )}
              {selected.charges.discount !== 0 && (
                <div className="text-red-500">
                  <p className="text-xs">{copy.discount}</p>
                  <p>{money(-Math.abs(selected.charges.discount))}</p>
                </div>
              )}
              <div>
                <p className="text-xs text-muted-foreground">{copy.grandTotal}</p>
                <p className="text-xl font-bold">{money(selected.grandTotal)}</p>
              </div>
            </div>
            <div className="flex flex-wrap justify-end gap-2">
              <Button variant="outline" onClick={() => navigate("/containers")}>
                {copy.cancel}
              </Button>
              <Button
                data-testid="button-validate"
                onClick={() => validateMutation.mutate(payload())}
                disabled={!canValidate}
              >
                {validateMutation.isPending ? copy.validating : copy.validate}
              </Button>
              <Button data-testid="button-import" onClick={() => importMutation.mutate()} disabled={!canImport}>
                <Upload className="h-4 w-4 mr-2" />
                {importMutation.isPending ? copy.importing : copy.import}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
