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
