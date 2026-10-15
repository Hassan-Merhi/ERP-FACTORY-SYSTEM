import type { ApplicationLanguage } from "@shared/applicationLanguageContract";

const messages = {
  title: { en: "Fixed Production Planner", ar: "مخطط الإنتاج الثابت", fr: "Planificateur de production fixe" },
  description: {
    en: "In Hand comes from Raw Materials; OTW is the live Pending / In Transit / Arrived stock from Factory Containers. Edit only the 20-ton column; all other quantities are calculated automatically.",
    ar: "المخزون المتاح يأتي من المواد الخام، والشحنات في الطريق من الحاويات المعلقة أو العابرة أو الواصلة. عمود 20 طن فقط قابل للتعديل، وبقية القيم تُحسب تلقائيًا.",
    fr: "Le stock disponible provient des matières premières et le stock en route des conteneurs en attente, en transit ou arrivés. Seule la colonne 20 tonnes est modifiable ; le reste est calculé.",
  },
  savedAndLocked: { en: "Saved and locked", ar: "محفوظ ومقفل", fr: "Enregistré et verrouillé" },
  unlockedForEditing: { en: "Unlocked for editing", ar: "مفتوح للتعديل", fr: "Déverrouillé pour modification" },
  lastSaved: { en: "Last saved: {date}", ar: "آخر حفظ: {date}", fr: "Dernier enregistrement : {date}" },
  refresh: { en: "Refresh", ar: "تحديث", fr: "Actualiser" },
  downloadPng: { en: "Download PNG", ar: "تنزيل صورة PNG", fr: "Télécharger PNG" },
  sendWhatsapp: { en: "Send WhatsApp", ar: "إرسال واتساب", fr: "Envoyer sur WhatsApp" },
  sending: { en: "Sending...", ar: "جارٍ الإرسال...", fr: "Envoi en cours..." },
  saveAndLock: { en: "Save & Lock", ar: "حفظ وقفل", fr: "Enregistrer et verrouiller" },
  saving: { en: "Saving...", ar: "جارٍ الحفظ...", fr: "Enregistrement..." },
  unlockToEdit: { en: "Unlock to Edit", ar: "فتح للتعديل", fr: "Déverrouiller pour modifier" },
  unlocking: { en: "Unlocking...", ar: "جارٍ فتح القفل...", fr: "Déverrouillage..." },
  loadError: {
    en: "Unable to load the saved plan, Raw Materials stock, or incoming containers. Use Refresh to retry.",
    ar: "تعذر تحميل الخطة أو المواد الخام أو الحاويات القادمة. حاول التحديث.",
    fr: "Impossible de charger le plan, le stock de matières premières ou les conteneurs entrants. Réessayez avec Actualiser.",
  },
  loading: { en: "Loading live supplier stock and plan...", ar: "جارٍ تحميل المخزون والخطة...", fr: "Chargement du stock et du plan..." },
  origin: { en: "Origin / Supplier", ar: "المصدر / المورد", fr: "Origine / Fournisseur" },
  inHand: { en: "In Hand (kg)", ar: "المتوفر (كغ)", fr: "En stock (kg)" },
  otw: { en: "OTW (kg)", ar: "في الطريق (كغ)", fr: "En route (kg)" },
  total: { en: "Total (kg)", ar: "الإجمالي (كغ)", fr: "Total (kg)" },
  fifteenTons: { en: "15 Tons (kg)", ar: "15 طن (كغ)", fr: "15 tonnes (kg)" },
  seventeenTons: { en: "17.5 Tons (kg)", ar: "17.5 طن (كغ)", fr: "17,5 tonnes (kg)" },
  twentyTons: { en: "20 Tons (kg)", ar: "20 طن (كغ)", fr: "20 tonnes (kg)" },
  withOtw: { en: "With OTW Stock (17.5 Ton)", ar: "مع المخزون القادم (17.5 طن)", fr: "Avec stock en route (17,5 t)" },
  withoutOtw: { en: "Without OTW (17.5 Ton)", ar: "دون المخزون القادم (17.5 طن)", fr: "Sans stock en route (17,5 t)" },
  containersToOrder: { en: "# of Container to Order", ar: "عدد الحاويات المطلوب طلبها", fr: "Nombre de conteneurs à commander" },
  planFor: { en: "PLAN FOR", ar: "إجمالي الخطة", fr: "TOTAL DU PLAN" },
  noSuppliers: { en: "No suppliers with stock in hand or on the way.", ar: "لا يوجد موردون لديهم مخزون متاح أو قادم.", fr: "Aucun fournisseur avec stock disponible ou en route." },
  allocationLabel: { en: "20-ton allocation for {name}", ar: "حصة 20 طن للمورد {name}", fr: "Répartition 20 tonnes pour {name}" },
  footerFormula: {
    en: "Coverage = stock ÷ daily 17.5t allocation; containers = daily 17.5t × 26 ÷ 20,000. Any 20t total may be saved.",
    ar: "التغطية = المخزون ÷ حصة 17.5 طن اليومية؛ الحاويات = الحصة اليومية × 26 ÷ 20,000. يمكن حفظ أي إجمالي.",
    fr: "Couverture = stock ÷ répartition quotidienne à 17,5 t ; conteneurs = répartition × 26 ÷ 20 000. Tout total peut être enregistré.",
  },
  allocationTotal: { en: "20t allocation total: {kg} kg", ar: "إجمالي توزيع 20 طن: {kg} كغ", fr: "Total de répartition 20 t : {kg} kg" },
  savedTitle: { en: "Production plan saved and locked", ar: "تم حفظ خطة الإنتاج وقفلها", fr: "Plan de production enregistré et verrouillé" },
  savedInfo: {
    en: "Unlock the plan before editing the 20-ton allocation again.",
    ar: "افتح قفل الخطة قبل تعديل توزيع 20 طن مجددًا.",
    fr: "Déverrouillez le plan avant de modifier la répartition des 20 tonnes.",
  },
  saveError: { en: "Could not save plan", ar: "تعذر حفظ الخطة", fr: "Impossible d'enregistrer le plan" },
  unlockedTitle: { en: "Production plan unlocked", ar: "تم فتح قفل خطة الإنتاج", fr: "Plan de production déverrouillé" },
  unlockedInfo: {
    en: "You may now edit the 20-ton allocations. Save to lock the plan again.",
    ar: "يمكنك تعديل توزيع 20 طن الآن. احفظ الخطة لقفلها مجددًا.",
    fr: "Vous pouvez modifier la répartition de 20 tonnes. Enregistrez pour verrouiller de nouveau.",
  },
  unlockError: { en: "Could not unlock plan", ar: "تعذر فتح قفل الخطة", fr: "Impossible de déverrouiller le plan" },
  invalidQuantity: { en: "Invalid 20-ton quantity", ar: "كمية 20 طن غير صالحة", fr: "Quantité de 20 tonnes invalide" },
  invalidQuantityInfo: {
    en: "Enter a nonnegative kg value (up to three decimals) for {name}.",
    ar: "أدخل كمية غير سالبة بالكيلوغرام (حتى 3 منازل عشرية) للمورد {name}.",
    fr: "Saisissez une quantité non négative (3 décimales maximum) pour {name}.",
  },
  imageNotReady: { en: "Production planner image is not ready", ar: "صورة خطة الإنتاج غير جاهزة", fr: "L'image du plan n'est pas prête" },
  sendError: { en: "WhatsApp send failed", ar: "فشل إرسال واتساب", fr: "Échec de l'envoi WhatsApp" },
  sendErrorInfo: { en: "Could not send Fixed Production Planner image", ar: "تعذر إرسال صورة خطة الإنتاج", fr: "Impossible d'envoyer l'image du plan" },
  sendSuccess: { en: "Fixed Production Plan sent to WhatsApp group", ar: "تم إرسال خطة الإنتاج إلى مجموعة واتساب", fr: "Plan de production envoyé au groupe WhatsApp" },
  downloadError: { en: "Could not generate image", ar: "تعذر إنشاء الصورة", fr: "Impossible de générer l'image" },
  unknownError: { en: "Unknown error", ar: "خطأ غير معروف", fr: "Erreur inconnue" },
  reportTitle: { en: "FIXED PRODUCTION PLAN", ar: "خطة الإنتاج الثابتة", fr: "PLAN DE PRODUCTION FIXE" },
  reportOrigin: { en: "ORIGIN", ar: "المصدر", fr: "ORIGINE" },
  reportFifteenTons: { en: "15 TONS", ar: "15 طن", fr: "15 TONNES" },
  reportSeventeenTons: { en: "17.5 TONS", ar: "17.5 طن", fr: "17,5 TONNES" },
  reportTwentyTons: { en: "20 TONS", ar: "20 طن", fr: "20 TONNES" },
  reportWithOtw: { en: "WITH OTW STOCK (17.5 Ton)", ar: "مع المخزون القادم (17.5 طن)", fr: "AVEC STOCK EN ROUTE (17,5 t)" },
  reportWithoutOtw: { en: "WITHOUT OTW (17.5 Ton)", ar: "دون المخزون القادم (17.5 طن)", fr: "SANS STOCK EN ROUTE (17,5 t)" },
  reportContainers: { en: "# OF CONTAINER TO ORDER", ar: "عدد الحاويات للطلب", fr: "CONTENEURS À COMMANDER" },
  reportFoot: {
    en: "In Hand and OTW reflect live inventory at the time the report was generated. Working days: 26. Container size: 20,000 kg.",
    ar: "المخزون والشحنات القادمة حسب البيانات المباشرة وقت إنشاء التقرير. أيام العمل: 26. سعة الحاوية: 20,000 كغ.",
    fr: "Stock et arrivages selon l'inventaire au moment du rapport. Jours ouvrés : 26. Conteneur : 20 000 kg.",
  },
  reportCaption: { en: "Fixed Production Plan — {date}", ar: "خطة الإنتاج الثابتة — {date}", fr: "Plan de production fixe — {date}" },
  noCompany: { en: "No company selected", ar: "لم يتم تحديد شركة", fr: "Aucune société sélectionnée" },
  invalidAllocations: { en: "Invalid allocations or plan revision", ar: "توزيعات أو إصدار خطة غير صالح", fr: "Répartition ou version du plan invalide" },
  tooManySuppliers: { en: "Too many supplier allocations", ar: "عدد توزيعات الموردين كبير جدًا", fr: "Trop de répartitions de fournisseurs" },
  invalidSupplierAllocation: { en: "Invalid 20-ton quantity for supplier ${supplierId}", ar: "كمية 20 طن غير صالحة للمورد ${supplierId}", fr: "Quantité de 20 tonnes invalide pour le fournisseur ${supplierId}" },
  wrongCompanySupplier: {
    en: "One or more suppliers do not belong to this company",
    ar: "مورد واحد أو أكثر لا ينتمي إلى هذه الشركة",
    fr: "Un ou plusieurs fournisseurs n'appartiennent pas à cette société",
  },
  lockedConflict: {
    en: "Planner was locked or edited elsewhere. Refresh before saving.",
    ar: "تم قفل المخطط أو تعديله من مكان آخر. حدّث الصفحة قبل الحفظ.",
    fr: "Le plan a été verrouillé ou modifié ailleurs. Actualisez avant d'enregistrer.",
  },
  invalidRevision: { en: "Invalid plan revision", ar: "إصدار الخطة غير صالح", fr: "Version du plan invalide" },
  changedConflict: {
    en: "Plan already changed. Refresh before unlocking.",
    ar: "تم تعديل الخطة مسبقًا. حدّث الصفحة قبل فتح القفل.",
    fr: "Le plan a déjà changé. Actualisez avant de le déverrouiller.",
  },

} as const;

export type FixedProductionPlannerTranslationKey = keyof typeof messages;

export function translateFixedProductionPlanner(
  key: FixedProductionPlannerTranslationKey,
  language: ApplicationLanguage,
  params?: Record<string, string | number>,
): string {
  const entry = messages[key];
  const template: string = entry[language] || entry.en;
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (token, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : token);
}

/** Translate the exact planner API validation/conflict messages without changing the API contract. */
export function translateFixedPlannerApiMessage(raw: string, language: ApplicationLanguage): string {
  const match = /^Invalid 20-ton quantity for supplier (\d+)$/.exec(raw);
  if (match) return messages.invalidSupplierAllocation[language].replace("${supplierId}", match[1]);
  const keys = [
    "noCompany", "invalidAllocations", "tooManySuppliers", "wrongCompanySupplier",
    "lockedConflict", "invalidRevision", "changedConflict",
  ] as const;
  for (const key of keys) {
    if (messages[key].en === raw) return messages[key][language];
  }
  return raw;
}
