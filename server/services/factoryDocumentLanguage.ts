import ExcelJS from "exceljs";
import fs from "fs";
import path from "path";
import {
  parseFactoryCatalogLanguage,
  resolveFactoryProductName,
  type FactoryCatalogLanguage,
} from "@shared/factoryBilingualContract";
import { FACTORY_INVOICE_EXTRA_LABELS } from "./factoryInvoiceTranslations";

export type FactoryDocumentLanguage = FactoryCatalogLanguage;

export const FACTORY_DOCUMENT_LABELS = {
  en: {
    invoice: "INVOICE",
    commercialInvoice: "Commercial Invoice",
    loadingList: "Loading List",
    invoiceNo: "Invoice No.",
    customer: "Customer",
    date: "Date",
    container: "Container",
    destination: "Destination",
    articleCode: "Article Code",
    product: "Product",
    category: FACTORY_INVOICE_EXTRA_LABELS.en.category,
    quantity: "Qty",
    weightPerBale: "Wt/Bale",
    totalWeight: "Total Wt",
    pricePerBale: "Price/Bale",
    pricePerKg: "Price/KG",
    unitPrice: FACTORY_INVOICE_EXTRA_LABELS.en.unitPrice,
    total: "Total",
    totals: "Totals",
    subtotal: "Subtotal",
    freight: "Freight",
    otherCharges: "Other Charges",
    grandTotal: "Grand Total",
    name: FACTORY_INVOICE_EXTRA_LABELS.en.name,
    amount: FACTORY_INVOICE_EXTRA_LABELS.en.amount,
    notes: "Notes",
    reference: "Ref Code",
    weightKg: "Weight (kg)",
    cumulativeWeight: "Total Weight (kg)",
    status: "Status",
  },
  ar: {
    invoice: "فاتورة",
    commercialInvoice: "فاتورة تجارية",
    loadingList: "قائمة التحميل",
    invoiceNo: "رقم الفاتورة",
    customer: "العميل",
    date: "التاريخ",
    container: "الحاوية",
    destination: "الوجهة",
    articleCode: "رمز الصنف",
    product: "المنتج",
    category: FACTORY_INVOICE_EXTRA_LABELS.ar.category,
    quantity: "الكمية",
    weightPerBale: "وزن البالة",
    totalWeight: "الوزن الإجمالي",
    pricePerBale: "سعر البالة",
    pricePerKg: "سعر الكيلو",
    unitPrice: FACTORY_INVOICE_EXTRA_LABELS.ar.unitPrice,
    total: "الإجمالي",
    totals: "الإجماليات",
    subtotal: "المجموع الفرعي",
    freight: "الشحن",
    otherCharges: "رسوم أخرى",
    grandTotal: "المجموع الكلي",
    name: FACTORY_INVOICE_EXTRA_LABELS.ar.name,
    amount: FACTORY_INVOICE_EXTRA_LABELS.ar.amount,
    notes: "ملاحظات",
    reference: "المرجع",
    weightKg: "الوزن (كغ)",
    cumulativeWeight: "الوزن التراكمي (كغ)",
    status: "الحالة",
  },
  fr: {
    invoice: "FACTURE",
    commercialInvoice: "Facture commerciale",
    loadingList: "Liste de chargement",
    invoiceNo: "N° de facture",
    customer: "Client",
    date: "Date",
    container: "Conteneur",
    destination: "Destination",
    articleCode: "Code article",
    product: "Produit",
    category: FACTORY_INVOICE_EXTRA_LABELS.fr.category,
    quantity: "Qté",
    weightPerBale: "Poids/balle",
    totalWeight: "Poids total",
    pricePerBale: "Prix/balle",
    pricePerKg: "Prix/kg",
    unitPrice: FACTORY_INVOICE_EXTRA_LABELS.fr.unitPrice,
    total: "Total",
    totals: "Totaux",
    subtotal: "Sous-total",
    freight: "Fret",
    otherCharges: "Autres frais",
    grandTotal: "Total général",
    name: FACTORY_INVOICE_EXTRA_LABELS.fr.name,
    amount: FACTORY_INVOICE_EXTRA_LABELS.fr.amount,
    notes: "Notes",
    reference: "Code réf.",
    weightKg: "Poids (kg)",
    cumulativeWeight: "Poids total (kg)",
    status: "Statut",
  },
} as const;

export function parseFactoryDocumentLanguage(value: unknown): FactoryDocumentLanguage {
  return parseFactoryCatalogLanguage(value, "en");
}

export function isArabicFactoryDocument(language: FactoryDocumentLanguage): boolean {
  return language === "ar";
}

export function resolveFactoryDocumentProductName(
  source: {
    articleCode?: string | null;
    baleName?: string | null;
    baleNameAr?: string | null;
    baleNameFr?: string | null;
    productName?: string | null;
    productNameAr?: string | null;
    productNameFr?: string | null;
    name?: string | null;
    nameAr?: string | null;
    nameFr?: string | null;
  },
  language: FactoryDocumentLanguage
): string {
  const englishSnapshot = source.baleName ?? source.productName ?? source.name ?? null;
  const arabicSnapshot = source.baleNameAr ?? source.productNameAr ?? source.nameAr ?? null;
  const frenchSnapshot = source.baleNameFr ?? source.productNameFr ?? source.nameFr ?? null;
  return resolveFactoryProductName(
    {
      articleCode: source.articleCode,
      name: englishSnapshot,
      nameAr: arabicSnapshot,
      nameFr: frenchSnapshot,
    },
    language
  );
}

export function translateFactoryDocumentStatus(status: unknown, language: FactoryDocumentLanguage): string {
  const raw = typeof status === "string" ? status : "";
  const normalized = raw.toUpperCase();
  if (language === "ar") {
    const map: Record<string, string> = {
      DRAFT: "مسودة",
      PENDING: "قيد الانتظار",
      PENDING_LOADING: "بانتظار التحميل",
      LOADING: "قيد التحميل",
      LOADED: "تم التحميل",
      VERIFIED: "تم التحقق",
      FINALIZED: "نهائي",
      COMPLETED: "مكتمل",
      INVOICED: "تمت الفوترة",
      CANCELLED: "ملغى",
      DISPATCHED: "تم الإرسال",
    };
    return map[normalized] ?? raw.replaceAll("_", " ");
  }
  if (language === "fr") {
    const map: Record<string, string> = {
      DRAFT: "Brouillon",
      PENDING: "En attente",
      PENDING_LOADING: "En attente de chargement",
      LOADING: "Chargement",
      LOADED: "Chargé",
      VERIFIED: "Vérifié",
      FINALIZED: "Finalisé",
      COMPLETED: "Terminé",
      INVOICED: "Facturé",
      CANCELLED: "Annulé",
      DISPATCHED: "Expédié",
    };
    return map[normalized] ?? raw.replaceAll("_", " ");
  }
  return raw.replaceAll("_", " ");
}

export function configureFactoryArabicWorksheet(sheet: ExcelJS.Worksheet, language: FactoryDocumentLanguage): void {
  if (language !== "ar") return;
  sheet.views = [{ rightToLeft: true, showGridLines: false }];
  sheet.eachRow((row: ExcelJS.Row) => {
    row.eachCell((cell: ExcelJS.Cell) => {
      cell.alignment = {
        ...(cell.alignment ?? {}),
        horizontal: "right",
        readingOrder: "rtl",
        vertical: cell.alignment?.vertical ?? "middle",
      };
    });
  });
}

export function findArabicPdfFont(): string | null {
  const candidates = [
    path.join(process.cwd(), "server", "fonts", "NotoNaskhArabic-Regular.ttf"),
    path.join(process.cwd(), "server", "fonts", "NotoSansArabic-Regular.ttf"),
    path.join(process.cwd(), "assets", "fonts", "NotoNaskhArabic-Regular.ttf"),
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
}

export function applyFactoryPdfLanguage(doc: PDFKit.PDFDocument, language: FactoryDocumentLanguage): void {
  if (language !== "ar") return;
  const font = findArabicPdfFont();
  if (font) doc.font(font);
}
