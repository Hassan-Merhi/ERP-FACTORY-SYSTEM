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
import {
  SP_CONTAINER_EXCEL_IMPORT_PARSE_PATH,
  type SpExcelImportContainer,
  type SpExcelImportLine,
} from "@shared/spContainerExcelImport";
import type { Supplier } from "@shared/schema";


const spImportWords = {
  "en": {
    "pageHeading": "PO Import (Excel)",
    "downloadTemplate": "Download Template",
    "uploadHeading": "Upload Purchase Order Excel File",
    "instructions": "Three-step process: Parse → Validate → Import. Uses the normal ERP Excel template and the Supplier Payable accounting flow.",
    "stepOne": "Step 1: Select & Parse Excel File (.xlsx)",
    "parse": "Parse",
    "parsing": "Parsing...",
    "stepTwo": "Step 2: Configure Import Details",
    "fromFile": "Container from file",
    "supplier": "Supplier *",
    "supplierSelect": "Select supplier",
    "supplierLoading": "Loading...",
    "supplierHelp": "Select the vendor who issued the invoice and should be paid for this container.",
    "supplierCodeHint": "Excel supplier code:",
    "supplierEmpty": "No suppliers set up for this company. Add the invoicing vendor in Suppliers before importing.",
    "containerNumber": "Container Number *",
    "invoiceDate": "Invoice Date *",
    "invoiceNumber": "Invoice / PO Number *",
    "companyChanged": "Company changed since parsing. Parse again under the selected company.",
    "previewHeading": "Preview & Validation",
    "previewDescription": "Review the line items and amounts before importing. Nothing posts until Import is confirmed.",
    "validationErrors": "Validation Errors",
    "validationPassed": "Validation Passed",
    "container": "Container:",
    "items": "items",
    "poCount": "PO(s)",
    "poNumber": "PO Number",
    "itemCode": "Item Code",
    "itemName": "Item Name",
    "quantity": "Quantity",
    "rate": "Rate",
    "lineTotal": "Line Total",
    "itemsTotal": "Items Total",
    "freight": "Freight",
    "surcharge": "Surcharge",
    "fumigation": "Fumigation",
    "documents": "Documents",
    "discount": "Discount",
    "grandTotal": "Grand Total (USD)",
    "cancel": "Cancel",
    "validate": "Validate",
    "validating": "Validating...",
    "import": "Import",
    "importing": "Importing...",
    "requestFailed": "Request failed",
    "firstParse": "Parse a file first",
    "chooseFile": "Select an Excel file first",
    "excelReadError": "Could not parse Excel",
    "emptyFile": "No containers found",
    "fileParsed": "File parsed",
    "parsedHint": "Review the preview, then click Validate.",
    "excelParseFailed": "Excel parse failed",
    "validationFailed": "Validation failed",
    "validationPassedToast": "Validation passed",
    "ready": "Ready to import.",
    "containerImported": "Container imported",
    "posted": "Supplier Payable accounting posted automatically.",
    "importFailed": "Import failed",
    "unnamed": "Unnamed"
  },
  "fr": {
    "pageHeading": "Importation de commande (Excel)",
    "downloadTemplate": "Télécharger le modèle",
    "uploadHeading": "Importer un fichier Excel de commande",
    "instructions": "Trois étapes : analyser → valider → importer. Utilise le modèle ERP normal avec la comptabilité des fournisseurs.",
    "stepOne": "Étape 1 : choisir et analyser le fichier Excel (.xlsx)",
    "parse": "Analyser",
    "parsing": "Analyse...",
    "stepTwo": "Étape 2 : renseigner les détails",
    "fromFile": "Conteneur du fichier",
    "supplier": "Fournisseur *",
    "supplierSelect": "Choisir un fournisseur",
    "supplierLoading": "Chargement...",
    "supplierHelp": "Sélectionnez le fournisseur ayant émis la facture et à qui le paiement est dû.",
    "supplierCodeHint": "Code fournisseur du fichier Excel :",
    "supplierEmpty": "Aucun fournisseur défini pour cette société. Ajoutez le fournisseur avant l’importation.",
    "containerNumber": "Numéro du conteneur *",
    "invoiceDate": "Date de facture *",
    "invoiceNumber": "Numéro de facture / commande *",
    "companyChanged": "La société a changé. Analysez de nouveau le fichier pour la société sélectionnée.",
    "previewHeading": "Aperçu et validation",
    "previewDescription": "Vérifiez les articles et montants. Rien ne sera comptabilisé avant l'importation.",
    "validationErrors": "Erreurs de validation",
    "validationPassed": "Validation réussie",
    "container": "Conteneur :",
    "items": "articles",
    "poCount": "commande(s)",
    "poNumber": "N° commande",
    "itemCode": "Code article",
    "itemName": "Désignation",
    "quantity": "Quantité",
    "rate": "Prix",
    "lineTotal": "Montant ligne",
    "itemsTotal": "Total articles",
    "freight": "Fret",
    "surcharge": "Supplément",
    "fumigation": "Fumigation",
    "documents": "Documents",
    "discount": "Remise",
    "grandTotal": "Total général (USD)",
    "cancel": "Annuler",
    "validate": "Valider",
    "validating": "Validation...",
    "import": "Importer",
    "importing": "Importation...",
    "requestFailed": "Échec de la requête",
    "firstParse": "Analysez d'abord un fichier",
    "chooseFile": "Choisissez un fichier Excel",
    "excelReadError": "Impossible de lire le fichier Excel",
    "emptyFile": "Aucun conteneur trouvé",
    "fileParsed": "Fichier analysé",
    "parsedHint": "Vérifiez l'aperçu, puis cliquez sur Valider.",
    "excelParseFailed": "Échec de l'analyse Excel",
    "validationFailed": "Validation échouée",
    "validationPassedToast": "Validation réussie",
    "ready": "Prêt à importer.",
    "containerImported": "Conteneur importé",
    "posted": "Écriture comptable fournisseur créée automatiquement.",
    "importFailed": "Échec de l'importation",
    "unnamed": "Sans nom"
  },
  "ar": {
    "pageHeading": "استيراد أمر شراء (إكسل)",
    "downloadTemplate": "تنزيل القالب",
    "uploadHeading": "استيراد ملف إكسل لأمر الشراء",
    "instructions": "ثلاث خطوات: تحليل ثم تحقق ثم استيراد. يستخدم قالب ERP العادي مع محاسبة الموردين.",
    "stepOne": "الخطوة ١: اختيار ملف إكسل وتحليله",
    "parse": "تحليل",
    "parsing": "جارٍ التحليل...",
    "stepTwo": "الخطوة ٢: تحديد تفاصيل الاستيراد",
    "fromFile": "الحاوية من الملف",
    "supplier": "المورد *",
    "supplierSelect": "اختر المورد",
    "supplierLoading": "جارٍ التحميل...",
    "supplierHelp": "اختر المورد الذي أصدر الفاتورة والذي يستحق الدفع مقابل هذه الحاوية.",
    "supplierCodeHint": "رمز المورد في ملف إكسل:",
    "supplierEmpty": "لا يوجد موردون لهذه الشركة. أضف المورد الذي أصدر الفاتورة قبل الاستيراد.",
    "containerNumber": "رقم الحاوية *",
    "invoiceDate": "تاريخ الفاتورة *",
    "invoiceNumber": "رقم الفاتورة / أمر الشراء *",
    "companyChanged": "تغيرت الشركة. أعد تحليل الملف ضمن الشركة المحددة.",
    "previewHeading": "المعاينة والتحقق",
    "previewDescription": "راجع الأصناف والمبالغ قبل الاستيراد. لن تُسجل قيود حتى تأكيد الاستيراد.",
    "validationErrors": "أخطاء التحقق",
    "validationPassed": "تم التحقق بنجاح",
    "container": "الحاوية:",
    "items": "صنف",
    "poCount": "أمر شراء",
    "poNumber": "رقم أمر الشراء",
    "itemCode": "رمز الصنف",
    "itemName": "اسم الصنف",
    "quantity": "الكمية",
    "rate": "السعر",
    "lineTotal": "إجمالي السطر",
    "itemsTotal": "إجمالي الأصناف",
    "freight": "الشحن",
    "surcharge": "رسوم إضافية",
    "fumigation": "تبخير",
    "documents": "المستندات",
    "discount": "خصم",
    "grandTotal": "الإجمالي (دولار)",
    "cancel": "إلغاء",
    "validate": "تحقق",
    "validating": "جارٍ التحقق...",
    "import": "استيراد",
    "importing": "جارٍ الاستيراد...",
    "requestFailed": "فشل الطلب",
    "firstParse": "حلل الملف أولاً",
    "chooseFile": "اختر ملف إكسل أولاً",
    "excelReadError": "تعذر قراءة ملف إكسل",
    "emptyFile": "لم يتم العثور على حاويات",
    "fileParsed": "تم تحليل الملف",
    "parsedHint": "راجع المعاينة ثم انقر على تحقق.",
    "excelParseFailed": "فشل تحليل إكسل",
    "validationFailed": "فشل التحقق",
    "validationPassedToast": "نجح التحقق",
    "ready": "جاهز للاستيراد.",
    "containerImported": "تم استيراد الحاوية",
    "posted": "تم تسجيل القيود المحاسبية للمورد تلقائياً.",
    "importFailed": "فشل الاستيراد",
    "unnamed": "بدون اسم"
  }
} as const;

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
  const amount = Number(value || 0);
  const formatted = Math.abs(amount).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return (amount < 0 ? "-$" : "$") + formatted;
}

/** Visual highlighting only; never changes the imported price or accounting. */
function isDiscountOrNegativeLine(line: SpExcelImportLine): boolean {
  return line.qty < 0 || line.unitRateUsd < 0 || line.lineTotal < 0 ||
    /\b(discount|rebate|remise)\b|خصم/i.test(line.description);
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
    onError: (error: Error) => toast({ title: copy.excelParseFailed, description: error.message, variant: "destructive" }),
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
    onError: (error: Error) => toast({ title: copy.validationFailed, description: error.message, variant: "destructive" }),
  });
  const importMutation = useMutation({
    mutationFn: async () => {
      return spPost<{ id: number }>("/api/sp/containers", payload(), importKey);
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

  const canValidate = !!selected && !!supplierId && !!containerNumber.trim() &&
    !!invoiceNumber.trim() && !!invoiceDate && companyMatches && !validateMutation.isPending;
  const canImport = canValidate && validation !== null && validation.errors.length === 0 &&
    !importMutation.isPending;

  return (
    <div className="space-y-4">
      <PageHeader title={copy.pageHeading}>
        <Button variant="outline" onClick={() => window.open("/api/po-import/template", "_blank")}>
          <Download className="h-4 w-4 mr-2" /> {copy.downloadTemplate}
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
                setParseKey(requestId());
                setParsed(null);
                setParsedCompanyId(null);
                invalidateValidation();
              }}
            />
            <Button data-testid="button-parse" disabled={!file || parseMutation.isPending} onClick={() => parseMutation.mutate()}>
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
                  <Select value={String(selectedIndex)} onValueChange={(value) => selectContainer(Number(value), parsed.containers)}>
                    <SelectTrigger data-testid="select-sp-excel-container"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {parsed.containers.map((c, index) => (
                        <SelectItem key={index} value={String(index)}>{c.containerNumber || copy.unnamed} — {c.itemsCount} items</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="space-y-2">
                  <Label>{copy.supplier}</Label>
                  <Select value={supplierId} onValueChange={(v) => { setSupplierId(v); invalidateValidation(); }}>
                    <SelectTrigger data-testid="select-supplier"><SelectValue placeholder={suppliersLoading ? copy.supplierLoading : copy.supplierSelect} /></SelectTrigger>
                    <SelectContent>
                      {suppliers.map((s) => <SelectItem key={s.id} value={String(s.id)}>{s.legalName}</SelectItem>)}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    {copy.supplierHelp}
                    {selected?.supplierCode ? (
                      <span className="block">{copy.supplierCodeHint} <strong>{selected.supplierCode}</strong></span>
                    ) : null}
                  </p>
                  {!suppliersLoading && suppliers.length === 0 && (
                    <p className="text-xs text-amber-600">{copy.supplierEmpty}</p>
                  )}
                </div>
                <div className="space-y-2">
                  <Label>{copy.containerNumber}</Label>
                  <Input value={containerNumber} onChange={(e) => { setContainerNumber(e.target.value); invalidateValidation(); }} data-testid="input-container-number" />
                </div>
                <div className="space-y-2">
                  <Label>{copy.invoiceDate}</Label>
                  <Input type="date" value={invoiceDate} onChange={(e) => { setInvoiceDate(e.target.value); invalidateValidation(); }} data-testid="input-import-date" />
                </div>
                <div className="space-y-2">
                  <Label>{copy.invoiceNumber}</Label>
                  <Input value={invoiceNumber} onChange={(e) => { setInvoiceNumber(e.target.value); invalidateValidation(); }} data-testid="input-invoice-number" />
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
              <div className={validation.errors.length ? "rounded-md border border-destructive p-3" : "rounded-md border p-3"}>
                <div className="flex items-center gap-2 font-semibold">
                  {validation.errors.length ? <XCircle className="h-4 w-4 text-destructive" /> : <CheckCircle className="h-4 w-4 text-green-600" />}
                  {validation.errors.length ? copy.validationErrors : copy.validationPassed}
                </div>
                {validation.errors.map((e, i) => <p key={i} className="text-sm text-destructive">{e}</p>)}
                {validation.warnings.map((w, i) => <p key={i} className="text-sm text-amber-600">{w}</p>)}
              </div>
            )}
            <div className="flex flex-wrap gap-4 text-sm">
              <span>{copy.container} <strong>{selected.containerNumber}</strong></span>
              <span>{selected.itemsCount} {copy.items}</span>
              <span>{selected.poNumbers.length} {copy.poCount}</span>
            </div>
            <div className="rounded-md border overflow-x-auto">
              <Table>
                <TableHeader><TableRow>
                  <TableHead>{copy.poNumber}</TableHead><TableHead>{copy.itemName}</TableHead>
                  <TableHead className="text-right">{copy.quantity}</TableHead>
                  <TableHead className="text-right">{copy.rate}</TableHead>
                  <TableHead className="text-right">{copy.lineTotal}</TableHead>
                </TableRow></TableHeader>
                <TableBody>{selected.lines.map((line, index) => (
                  <TableRow key={index} className={isDiscountOrNegativeLine(line) ? "text-red-500" : undefined}>
                    <TableCell>{line.poNumber}</TableCell>
                    <TableCell>{line.description}</TableCell>
                    <TableCell className="text-right">{line.qty}</TableCell>
                    <TableCell className="text-right">{money(line.unitRateUsd)}</TableCell>
                    <TableCell className="text-right">{money(line.lineTotal)}</TableCell>
                  </TableRow>
                ))}</TableBody>
              </Table>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 rounded-md bg-muted p-4">
              <div><p className="text-xs text-muted-foreground">{copy.itemsTotal}</p><p className="font-semibold">{money(selected.itemsTotal)}</p></div>
              {selected.charges.freight !== 0 && (
                <div className={selected.charges.freight < 0 ? "text-red-500" : undefined}>
                  <p className="text-xs">{copy.freight}</p><p>{money(selected.charges.freight)}</p>
                </div>
              )}
              {selected.charges.surcharge !== 0 && (
                <div className={selected.charges.surcharge < 0 ? "text-red-500" : undefined}>
                  <p className="text-xs">{copy.surcharge}</p><p>{money(selected.charges.surcharge)}</p>
                </div>
              )}
              {selected.charges.fumigation !== 0 && (
                <div className={selected.charges.fumigation < 0 ? "text-red-500" : undefined}>
                  <p className="text-xs">{copy.fumigation}</p><p>{money(selected.charges.fumigation)}</p>
                </div>
              )}
              {selected.charges.documentCharges !== 0 && (
                <div className={selected.charges.documentCharges < 0 ? "text-red-500" : undefined}>
                  <p className="text-xs">{copy.documents}</p><p>{money(selected.charges.documentCharges)}</p>
                </div>
              )}
              {selected.charges.discount !== 0 && (
                <div className="text-red-500">
                  <p className="text-xs">{copy.discount}</p><p>{money(-Math.abs(selected.charges.discount))}</p>
                </div>
              )}
              <div><p className="text-xs text-muted-foreground">{copy.grandTotal}</p><p className="text-xl font-bold">{money(selected.grandTotal)}</p></div>
            </div>
            <div className="flex flex-wrap justify-end gap-2">
              <Button variant="outline" onClick={() => navigate("/containers")}>{copy.cancel}</Button>
              <Button data-testid="button-validate" onClick={() => validateMutation.mutate(payload())} disabled={!canValidate}>
                {validateMutation.isPending ? copy.validating : copy.validate}
              </Button>
              <Button data-testid="button-import" onClick={() => importMutation.mutate()} disabled={!canImport}>
                <Upload className="h-4 w-4 mr-2" />{importMutation.isPending ? copy.importing : copy.import}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
