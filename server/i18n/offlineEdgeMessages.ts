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
    en: "Only POS sales, payments and receipts can be deleted while the factory is offline.",
    ar: "لا يمكن حذف سوى مبيعات نقاط البيع والمدفوعات والمقبوضات أثناء انقطاع اتصال المصنع.",
    fr: "Seuls les ventes au point de vente, les paiements et les encaissements peuvent être supprimés pendant que l’usine est hors ligne.",
  },
  voucherFinalizeTransfersOnly: {
    en: "Only stock transfers can be finalized while the factory is offline.",
    ar: "لا يمكن اعتماد سوى تحويلات المخزون أثناء انقطاع اتصال المصنع.",
    fr: "Seuls les transferts de stock peuvent être finalisés pendant que l’usine est hors ligne.",
  },
  inventoryImportUnknownItem: {
    en: "This code is not a stock item yet. While the factory is offline, add the item on the Stock Items page first, then import again.",
    ar: "هذا الرمز ليس صنفًا بعد. أثناء انقطاع اتصال المصنع، أضف الصنف من صفحة الأصناف أولًا ثم أعد الاستيراد.",
    fr: "Ce code n’est pas encore un article. Pendant que l’usine est hors ligne, ajoutez d’abord l’article dans la page Articles, puis réimportez.",
  },
  inventoryImportNeedsAdjustRight: {
    en: "Importing stock while the factory is offline needs the stock adjustment permission.",
    ar: "يتطلب استيراد المخزون أثناء انقطاع اتصال المصنع صلاحية تعديل المخزون.",
    fr: "L’import de stock pendant que l’usine est hors ligne nécessite le droit d’ajuster le stock.",
  },
  paymentIntercompanyOnlineOnly: {
    en: "This payment is one side of an intercompany transfer, so it can only be changed online.",
    ar: "هذه الدفعة طرف في تحويل بين الشركات، لذا لا يمكن تعديلها إلا عند الاتصال.",
    fr: "Ce paiement est un côté d’un transfert interentreprises ; il ne peut être modifié qu’en ligne.",
  },
  stockItemHasMovements: {
    en: "This stock item has stock movements, so it can only be deleted online.",
    ar: "لهذا الصنف حركات مخزون، لذا لا يمكن حذفه إلا عند الاتصال.",
    fr: "Cet article a des mouvements de stock ; il ne peut être supprimé qu’en ligne.",
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
