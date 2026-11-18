// Extracted from ./SpPOImport.tsx to keep that module under the source-size cap.
import type { SpExcelImportContainer, SpExcelImportLine } from "@shared/spContainerExcelImport";

export const spImportWords = {
  en: {
    pageHeading: "PO Import (Excel)",
    downloadTemplate: "Download Template",
    uploadHeading: "Upload Purchase Order Excel File",
    instructions:
      "Three-step process: Parse → Validate → Import. Uses the normal ERP Excel template and the Supplier Payable accounting flow.",
    stepOne: "Step 1: Select & Parse Excel File (.xlsx)",
    parse: "Parse",
    parsing: "Parsing...",
    stepTwo: "Step 2: Configure Import Details",
    fromFile: "Container from file",
    supplier: "Supplier *",
    supplierSelect: "Select supplier",
    supplierLoading: "Loading...",
    supplierHelp: "Select the vendor who issued the invoice and should be paid for this container.",
    source: "Source",
    freshStartOtw: "Fresh Start FZE (internal Goods OTW)",
    freshStartOtwHint: "No supplier account needed. The import posts Dr Goods OTW / Cr Goods OTW Clearing.",
    supplierCodeHint: "Excel supplier code:",
    supplierEmpty: "No suppliers set up for this company. Add the invoicing vendor in Suppliers before importing.",
    containerNumber: "Container Number *",
    invoiceDate: "Invoice Date *",
    invoiceNumber: "Invoice / PO Number *",
    companyChanged: "Company changed since parsing. Parse again under the selected company.",
    previewHeading: "Preview & Validation",
    previewDescription: "Review the line items and amounts before importing. Nothing posts until Import is confirmed.",
    validationErrors: "Validation Errors",
    validationPassed: "Validation Passed",
    container: "Container:",
    items: "items",
    poCount: "PO(s)",
    poNumber: "PO Number",
    itemCode: "Item Code",
    itemName: "Item Name",
    quantity: "Quantity",
    rate: "Rate",
    lineTotal: "Line Total",
    itemsTotal: "Items Total",
    freight: "Freight",
    surcharge: "Surcharge",
    fumigation: "Fumigation",
    documents: "Documents",
    discount: "Discount",
    grandTotal: "Grand Total (USD)",
    cancel: "Cancel",
    validate: "Validate",
    validating: "Validating...",
    import: "Import",
    importing: "Importing...",
    requestFailed: "Request failed",
    firstParse: "Parse a file first",
    chooseFile: "Select an Excel file first",
    excelReadError: "Could not parse Excel",
    emptyFile: "No containers found",
    fileParsed: "File parsed",
    parsedHint: "Review the preview, then click Validate.",
    excelParseFailed: "Excel parse failed",
    validationFailed: "Validation failed",
    validationPassedToast: "Validation passed",
    ready: "Ready to import.",
    containerImported: "Container imported",
    posted: "Supplier Payable accounting posted automatically.",
    importFailed: "Import failed",
    unnamed: "Unnamed",
  },
  fr: {
    pageHeading: "Importation de commande (Excel)",
    downloadTemplate: "Télécharger le modèle",
    uploadHeading: "Importer un fichier Excel de commande",
    instructions:
      "Trois étapes : analyser → valider → importer. Utilise le modèle ERP normal avec la comptabilité des fournisseurs.",
    stepOne: "Étape 1 : choisir et analyser le fichier Excel (.xlsx)",
    parse: "Analyser",
    parsing: "Analyse...",
    stepTwo: "Étape 2 : renseigner les détails",
    fromFile: "Conteneur du fichier",
    supplier: "Fournisseur *",
    supplierSelect: "Choisir un fournisseur",
    supplierLoading: "Chargement...",
    supplierHelp: "Sélectionnez le fournisseur ayant émis la facture et à qui le paiement est dû.",
    source: "Origine",
    freshStartOtw: "Fresh Start FZE (marchandises en transit internes)",
    freshStartOtwHint: "Aucun compte fournisseur nécessaire. Écriture : débit Goods OTW / crédit Goods OTW Clearing.",
    supplierCodeHint: "Code fournisseur du fichier Excel :",
    supplierEmpty: "Aucun fournisseur défini pour cette société. Ajoutez le fournisseur avant l’importation.",
    containerNumber: "Numéro du conteneur *",
    invoiceDate: "Date de facture *",
    invoiceNumber: "Numéro de facture / commande *",
    companyChanged: "La société a changé. Analysez de nouveau le fichier pour la société sélectionnée.",
    previewHeading: "Aperçu et validation",
    previewDescription: "Vérifiez les articles et montants. Rien ne sera comptabilisé avant l'importation.",
    validationErrors: "Erreurs de validation",
    validationPassed: "Validation réussie",
    container: "Conteneur :",
    items: "articles",
    poCount: "commande(s)",
    poNumber: "N° commande",
    itemCode: "Code article",
    itemName: "Désignation",
    quantity: "Quantité",
    rate: "Prix",
    lineTotal: "Montant ligne",
    itemsTotal: "Total articles",
    freight: "Fret",
    surcharge: "Supplément",
    fumigation: "Fumigation",
    documents: "Documents",
    discount: "Remise",
    grandTotal: "Total général (USD)",
    cancel: "Annuler",
    validate: "Valider",
    validating: "Validation...",
    import: "Importer",
    importing: "Importation...",
    requestFailed: "Échec de la requête",
    firstParse: "Analysez d'abord un fichier",
    chooseFile: "Choisissez un fichier Excel",
    excelReadError: "Impossible de lire le fichier Excel",
    emptyFile: "Aucun conteneur trouvé",
    fileParsed: "Fichier analysé",
    parsedHint: "Vérifiez l'aperçu, puis cliquez sur Valider.",
    excelParseFailed: "Échec de l'analyse Excel",
    validationFailed: "Validation échouée",
    validationPassedToast: "Validation réussie",
    ready: "Prêt à importer.",
    containerImported: "Conteneur importé",
    posted: "Écriture comptable fournisseur créée automatiquement.",
    importFailed: "Échec de l'importation",
    unnamed: "Sans nom",
  },
  ar: {
    pageHeading: "استيراد أمر شراء (إكسل)",
    downloadTemplate: "تنزيل القالب",
    uploadHeading: "استيراد ملف إكسل لأمر الشراء",
    instructions: "ثلاث خطوات: تحليل ثم تحقق ثم استيراد. يستخدم قالب ERP العادي مع محاسبة الموردين.",
    stepOne: "الخطوة ١: اختيار ملف إكسل وتحليله",
    parse: "تحليل",
    parsing: "جارٍ التحليل...",
    stepTwo: "الخطوة ٢: تحديد تفاصيل الاستيراد",
    fromFile: "الحاوية من الملف",
    supplier: "المورد *",
    supplierSelect: "اختر المورد",
    supplierLoading: "جارٍ التحميل...",
    supplierHelp: "اختر المورد الذي أصدر الفاتورة والذي يستحق الدفع مقابل هذه الحاوية.",
    source: "المصدر",
    freshStartOtw: "Fresh Start FZE (بضاعة في الطريق داخلية)",
    freshStartOtwHint: "لا حاجة إلى حساب مورد. القيد: مدين Goods OTW / دائن Goods OTW Clearing.",
    supplierCodeHint: "رمز المورد في ملف إكسل:",
    supplierEmpty: "لا يوجد موردون لهذه الشركة. أضف المورد الذي أصدر الفاتورة قبل الاستيراد.",
    containerNumber: "رقم الحاوية *",
    invoiceDate: "تاريخ الفاتورة *",
    invoiceNumber: "رقم الفاتورة / أمر الشراء *",
    companyChanged: "تغيرت الشركة. أعد تحليل الملف ضمن الشركة المحددة.",
    previewHeading: "المعاينة والتحقق",
    previewDescription: "راجع الأصناف والمبالغ قبل الاستيراد. لن تُسجل قيود حتى تأكيد الاستيراد.",
    validationErrors: "أخطاء التحقق",
    validationPassed: "تم التحقق بنجاح",
    container: "الحاوية:",
    items: "صنف",
    poCount: "أمر شراء",
    poNumber: "رقم أمر الشراء",
    itemCode: "رمز الصنف",
    itemName: "اسم الصنف",
    quantity: "الكمية",
    rate: "السعر",
    lineTotal: "إجمالي السطر",
    itemsTotal: "إجمالي الأصناف",
    freight: "الشحن",
    surcharge: "رسوم إضافية",
    fumigation: "تبخير",
    documents: "المستندات",
    discount: "خصم",
    grandTotal: "الإجمالي (دولار)",
    cancel: "إلغاء",
    validate: "تحقق",
    validating: "جارٍ التحقق...",
    import: "استيراد",
    importing: "جارٍ الاستيراد...",
    requestFailed: "فشل الطلب",
    firstParse: "حلل الملف أولاً",
    chooseFile: "اختر ملف إكسل أولاً",
    excelReadError: "تعذر قراءة ملف إكسل",
    emptyFile: "لم يتم العثور على حاويات",
    fileParsed: "تم تحليل الملف",
    parsedHint: "راجع المعاينة ثم انقر على تحقق.",
    excelParseFailed: "فشل تحليل إكسل",
    validationFailed: "فشل التحقق",
    validationPassedToast: "نجح التحقق",
    ready: "جاهز للاستيراد.",
    containerImported: "تم استيراد الحاوية",
    posted: "تم تسجيل القيود المحاسبية للمورد تلقائياً.",
    importFailed: "فشل الاستيراد",
    unnamed: "بدون اسم",
  },
} as const;

export interface ParsedFile {
  fileName: string;
  rowCount: number;
  freshStartOtwSource?: boolean;
  containers: SpExcelImportContainer[];
}

export interface Validation {
  errors: string[];
  warnings: string[];
}

export function money(value: number) {
  const amount = Number(value || 0);
  const formatted = Math.abs(amount).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return (amount < 0 ? "-$" : "$") + formatted;
}

/** Visual highlighting only; never changes the imported price or accounting. */
export function isDiscountOrNegativeLine(line: SpExcelImportLine): boolean {
  return (
    line.qty < 0 ||
    line.unitRateUsd < 0 ||
    line.lineTotal < 0 ||
    /\b(discount|rebate|remise)\b|خصم/i.test(line.description)
  );
}

export function requestId() {
  return crypto.randomUUID();
}

export async function spPost<T>(url: string, data: unknown, key: string): Promise<T> {
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
