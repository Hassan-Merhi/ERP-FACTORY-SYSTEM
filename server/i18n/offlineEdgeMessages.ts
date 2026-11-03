/**
 * User-facing refusals from the factory LAN server during an outage (offline
 * mode). Kept in the translation source directory with English, Arabic and
 * French text, like the other server message catalogs.
 */
const messages = {
  attachmentTooLarge: {
    en: "Offline uploads are limited to 10 MB.",
    ar: "يقتصر حجم الملفات المرفوعة دون اتصال على 10 ميغابايت.",
    fr: "Les fichiers envoyés hors ligne sont limités à 10 Mo.",
  },
  stockTransferFormCloudOnly: {
    en: "Only new stock transfers can be made on the factory server during an outage.",
    ar: "لا يمكن إنشاء سوى تحويلات مخزون جديدة على خادم المصنع أثناء انقطاع الاتصال.",
    fr: "Seuls de nouveaux transferts de stock peuvent être saisis sur le serveur de l’usine pendant une coupure.",
  },
  voucherDeleteSalesOnly: {
    en: "Only POS sales can be cancelled while the factory is offline.",
    ar: "لا يمكن إلغاء سوى مبيعات نقاط البيع أثناء انقطاع اتصال المصنع.",
    fr: "Seules les ventes au point de vente peuvent être annulées pendant que l’usine est hors ligne.",
  },
  posCompanyOnlineOnly: {
    en: "This company's sales stay online-only.",
    ar: "تبقى مبيعات هذه الشركة متاحة عبر الاتصال فقط.",
    fr: "Les ventes de cette société restent uniquement en ligne.",
  },
} as const;

export type OfflineEdgeMessageKey = keyof typeof messages;

export function offlineEdgeText(key: OfflineEdgeMessageKey, language?: string | string[]): string {
  const value = (Array.isArray(language) ? language[0] : language)?.toLowerCase() ?? "";
  const lang = value.startsWith("ar") ? "ar" : value.startsWith("fr") ? "fr" : "en";
  return messages[key][lang];
}
