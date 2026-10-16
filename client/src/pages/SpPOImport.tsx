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
import {
  SP_CONTAINER_EXCEL_IMPORT_PARSE_PATH,
  type SpExcelImportContainer,
} from "@shared/spContainerExcelImport";
import type { Supplier } from "@shared/schema";

interface ParsedFile {
  fileName: string;
  rowCount: number;
  containers: SpExcelImportContainer[];
}
interface Validation {
  errors: string[];
  warnings: string[];
}

function money(value: number) {
  return "$" + Number(value || 0).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}
function requestId() {
  return crypto.randomUUID();
}
async function spPost<T>(url: string, data: unknown, key: string): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json", "X-Idempotency-Key": key },
    body: JSON.stringify(data),
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(json.message || json.errors?.join("; ") || "Request failed");
  }
  return json as T;
}

/** ERP-style three-step import for Supplier Payable companies.
 * The write stays on /api/sp/containers; it does not create an ERP PO or an ERP voucher.
 */
export default function SpPOImport() {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const { selectedCompany } = useCompany();
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
    if (!selected) throw new Error("Parse a file first");
    const supplier = suppliers.find((s) => String(s.id) === supplierId);
    return {
      importSource: "excel",
      supplierId: Number(supplierId),
      supplierName: supplier?.legalName ?? "",
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
      if (!file) throw new Error("Select an Excel file first");
      const form = new FormData();
      form.append("file", file);
      const response = await fetch(SP_CONTAINER_EXCEL_IMPORT_PARSE_PATH, {
        method: "POST",
        credentials: "include",
        headers: { "X-Idempotency-Key": parseKey },
        body: form,
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.message || data.errors?.join("; ") || "Could not parse Excel");
      return data as ParsedFile;
    },
    onSuccess: (data) => {
      if (!data.containers.length) {
        toast({ title: "No containers found", variant: "destructive" });
        return;
      }
      setParsed(data);
      setParsedCompanyId(selectedCompany?.id ?? null);
      selectContainer(0, data.containers);
      toast({ title: "File parsed", description: "Review the preview, then click Validate." });
    },
    onError: (error: Error) => toast({ title: "Excel parse failed", description: error.message, variant: "destructive" }),
  });

  const validateMutation = useMutation({
    mutationFn: async (request: ReturnType<typeof payload>) => spPost<Validation>("/api/sp/containers/import-excel/validate", request, requestId()),
    onSuccess: (data, request) => {
      // An older response must not validate changed supplier, date, or amounts.
      if (JSON.stringify(request) !== JSON.stringify(payload())) return;
      setValidation(data);
      toast({
        title: data.errors.length ? "Validation failed" : "Validation passed",
        description: data.errors.length ? data.errors.join("; ") : "Ready to import.",
        variant: data.errors.length ? "destructive" : "default",
      });
    },
    onError: (error: Error) => toast({ title: "Validation failed", description: error.message, variant: "destructive" }),
  });
  const importMutation = useMutation({
    mutationFn: async () => spPost<{ id: number }>("/api/sp/containers", payload(), importKey),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/sp/containers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/sp/report/payable"] });
      queryClient.invalidateQueries({ queryKey: ["/api/vouchers"] });
      toast({ title: "Container imported", description: "Supplier Payable accounting posted automatically." });
      navigate("/containers");
    },
    onError: (error: Error) => toast({ title: "Import failed", description: error.message, variant: "destructive" }),
  });

  const canValidate = !!selected && !!supplierId && !!containerNumber.trim() &&
    !!invoiceNumber.trim() && !!invoiceDate && companyMatches && !validateMutation.isPending;
  const canImport = canValidate && validation !== null && validation.errors.length === 0 &&
    !importMutation.isPending;

  return (
    <div className="space-y-4">
      <PageHeader title="PO Import (Excel)">
        <Button variant="outline" onClick={() => window.open("/api/po-import/template", "_blank")}>
          <Download className="h-4 w-4 mr-2" /> Download Template
        </Button>
      </PageHeader>
      <Card>
        <CardHeader>
          <CardTitle>Upload Purchase Order Excel File</CardTitle>
          <CardDescription>Three-step process: Parse → Validate → Import. Uses the normal ERP Excel template and the Supplier Payable accounting flow.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Label htmlFor="sp-po-file">Step 1: Select &amp; Parse Excel File (.xlsx)</Label>
          <div className="flex flex-col sm:flex-row gap-2">
            <Input
              id="sp-po-file"
              type="file"
              disabled={parseMutation.isPending || importMutation.isPending}
              accept=".xlsx,.xls"
              data-testid="input-file-upload"
              onChange={(event) => {
                setFile(event.target.files?.[0] ?? null);
                setParseKey(requestId());
                setParsed(null);
                setParsedCompanyId(null);
                invalidateValidation();
              }}
            />
            <Button data-testid="button-parse" disabled={!file || parseMutation.isPending} onClick={() => parseMutation.mutate()}>
              <FileSpreadsheet className="h-4 w-4 mr-2" />
              {parseMutation.isPending ? "Parsing..." : "Parse"}
            </Button>
          </div>
          {parsed && (
            <div className="space-y-3">
              <Label>Step 2: Configure Import Details</Label>
              {parsed.containers.length > 1 && (
                <div className="space-y-2">
                  <Label>Container from file</Label>
                  <Select value={String(selectedIndex)} onValueChange={(value) => selectContainer(Number(value), parsed.containers)}>
                    <SelectTrigger data-testid="select-sp-excel-container"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {parsed.containers.map((c, index) => (
                        <SelectItem key={index} value={String(index)}>{c.containerNumber || "Unnamed"} — {c.itemsCount} items</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="space-y-2">
                  <Label>Supplier *</Label>
                  <Select value={supplierId} onValueChange={(v) => { setSupplierId(v); invalidateValidation(); }}>
                    <SelectTrigger data-testid="select-supplier"><SelectValue placeholder={suppliersLoading ? "Loading..." : "Select supplier"} /></SelectTrigger>
                    <SelectContent>
                      {suppliers.map((s) => <SelectItem key={s.id} value={String(s.id)}>{s.legalName}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>Container Number *</Label>
                  <Input value={containerNumber} onChange={(e) => { setContainerNumber(e.target.value); invalidateValidation(); }} data-testid="input-container-number" />
                </div>
                <div className="space-y-2">
                  <Label>Invoice Date *</Label>
                  <Input type="date" value={invoiceDate} onChange={(e) => { setInvoiceDate(e.target.value); invalidateValidation(); }} data-testid="input-import-date" />
                </div>
                <div className="space-y-2">
                  <Label>Invoice / PO Number *</Label>
                  <Input value={invoiceNumber} onChange={(e) => { setInvoiceNumber(e.target.value); invalidateValidation(); }} data-testid="input-invoice-number" />
                </div>
              </div>
              {!companyMatches && <p className="text-sm text-destructive">Company changed since parsing. Parse again under the selected company.</p>}
            </div>
          )}
        </CardContent>
      </Card>
      {selected && (
        <Card>
          <CardHeader>
            <CardTitle>Preview &amp; Validation</CardTitle>
            <CardDescription>Review the line items and amounts before importing. Nothing posts until Import is confirmed.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {validation && (
              <div className={validation.errors.length ? "rounded-md border border-destructive p-3" : "rounded-md border p-3"}>
                <div className="flex items-center gap-2 font-semibold">
                  {validation.errors.length ? <XCircle className="h-4 w-4 text-destructive" /> : <CheckCircle className="h-4 w-4 text-green-600" />}
                  {validation.errors.length ? "Validation Errors" : "Validation Passed"}
                </div>
                {validation.errors.map((e, i) => <p key={i} className="text-sm text-destructive">{e}</p>)}
                {validation.warnings.map((w, i) => <p key={i} className="text-sm text-amber-600">{w}</p>)}
              </div>
            )}
            <div className="flex flex-wrap gap-4 text-sm">
              <span>Container: <strong>{selected.containerNumber}</strong></span>
              <span>{selected.itemsCount} items</span>
              <span>{selected.poNumbers.length} PO(s)</span>
            </div>
            <div className="rounded-md border overflow-x-auto">
              <Table>
                <TableHeader><TableRow>
                  <TableHead>PO Number</TableHead><TableHead>Item Code</TableHead><TableHead>Item Name</TableHead>
                  <TableHead className="text-right">Quantity</TableHead>
                  <TableHead className="text-right">Rate</TableHead>
                  <TableHead className="text-right">Line Total</TableHead>
                </TableRow></TableHeader>
                <TableBody>{selected.lines.map((line, index) => (
                  <TableRow key={index}>
                    <TableCell>{line.poNumber}</TableCell>
                    <TableCell>{line.articleCode}</TableCell>
                    <TableCell>{line.description}</TableCell>
                    <TableCell className="text-right">{line.qty}</TableCell>
                    <TableCell className="text-right">{money(line.unitRateUsd)}</TableCell>
                    <TableCell className="text-right">{money(line.lineTotal)}</TableCell>
                  </TableRow>
                ))}</TableBody>
              </Table>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 rounded-md bg-muted p-4">
              <div><p className="text-xs text-muted-foreground">Items Total</p><p className="font-semibold">{money(selected.itemsTotal)}</p></div>
              <div><p className="text-xs text-muted-foreground">Freight</p><p>{money(selected.charges.freight)}</p></div>
              <div><p className="text-xs text-muted-foreground">Surcharge</p><p>{money(selected.charges.surcharge)}</p></div>
              <div><p className="text-xs text-muted-foreground">Fumigation</p><p>{money(selected.charges.fumigation)}</p></div>
              <div><p className="text-xs text-muted-foreground">Documents</p><p>{money(selected.charges.documentCharges)}</p></div>
              <div><p className="text-xs text-muted-foreground">Discount</p><p>-{money(selected.charges.discount)}</p></div>
              <div><p className="text-xs text-muted-foreground">Grand Total (USD)</p><p className="text-xl font-bold">{money(selected.grandTotal)}</p></div>
            </div>
            <div className="flex flex-wrap justify-end gap-2">
              <Button variant="outline" onClick={() => navigate("/containers")}>Cancel</Button>
              <Button data-testid="button-validate" onClick={() => validateMutation.mutate(payload())} disabled={!canValidate}>
                {validateMutation.isPending ? "Validating..." : "Validate"}
              </Button>
              <Button data-testid="button-import" onClick={() => importMutation.mutate()} disabled={!canImport}>
                <Upload className="h-4 w-4 mr-2" />{importMutation.isPending ? "Importing..." : "Import"}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
