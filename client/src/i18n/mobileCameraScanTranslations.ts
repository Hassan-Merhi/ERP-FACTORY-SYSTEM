import type { ApplicationLanguage } from "@shared/applicationLanguageContract";
import type { CameraScanFeedback } from "@/components/MobileBarcodeScanner";

/** Headings for the server-confirmed mobile camera scan result popup. */
const cameraScanTitles: Record<CameraScanFeedback["type"], Record<ApplicationLanguage, string>> = {
  success: {
    en: "Scanned successfully",
    ar: "تم المسح بنجاح",
    fr: "Scan réussi",
  },
  duplicate: {
    en: "Already scanned",
    ar: "تم مسحها بالفعل",
    fr: "Déjà scannée",
  },
  warn: {
    en: "Check scan",
    ar: "تحقق من المسح",
    fr: "Vérifiez le scan",
  },
  error: {
    en: "Scan failed",
    ar: "فشل المسح",
    fr: "Échec du scan",
  },
};

export function translateCameraScanTitle(type: CameraScanFeedback["type"], language: ApplicationLanguage): string {
  return cameraScanTitles[type][language];
}

/** Short explanatory messages for camera confirmations and proforma exceptions. */
const cameraScanMessages = {
  loadingSuccess: {
    en: "Bale added to the loading.",
    ar: "تمت إضافة البالة إلى التحميل.",
    fr: "Balle ajoutée au chargement.",
  },
  invoiceSuccess: {
    en: "Bale added to the invoice loading session.",
    ar: "تمت إضافة البالة إلى جلسة تحميل الفاتورة.",
    fr: "Balle ajoutée à la session de chargement de la facture.",
  },
  overload: {
    en: "Quantity exceeded. Scan this bale again to confirm the override.",
    ar: "تم تجاوز الكمية. امسح هذه البالة مرة أخرى لتأكيد التجاوز.",
    fr: "Quantité dépassée. Scannez cette balle à nouveau pour confirmer.",
  },
  notRequested: {
    en: "Item not requested on the proforma. Scan again to confirm the override.",
    ar: "الصنف غير مطلوب في البروفرما. امسحه مجددًا لتأكيد التجاوز.",
    fr: "Article non demandé sur la proforma. Scannez à nouveau pour confirmer.",
  },
  unableToAdd: {
    en: "Unable to add this bale.",
    ar: "تعذرت إضافة هذه البالة.",
    fr: "Impossible d'ajouter cette balle.",
  },
} as const;

export function translateCameraScanMessage(key: keyof typeof cameraScanMessages, language: ApplicationLanguage): string {
  return cameraScanMessages[key][language];
}
