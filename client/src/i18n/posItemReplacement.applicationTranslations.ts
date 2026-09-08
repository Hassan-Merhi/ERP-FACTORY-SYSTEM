import type { ApplicationLanguage } from "@shared/applicationLanguageContract";

type Translation = Record<ApplicationLanguage, string>;

export const posItemReplacementTranslations = {
  title: {
    en: "POS Item Replacement",
    ar: "استبدال أصناف نقاط البيع",
    fr: "Remplacement d’articles POS",
  },
  subtitle: {
    en: "Correct items entered on POS sales in bulk without opening each sale one by one",
    ar: "صحّح الأصناف المسجلة في مبيعات نقاط البيع دفعة واحدة دون فتح كل عملية بيع على حدة",
    fr: "Corrigez en lot les articles saisis dans les ventes POS sans ouvrir chaque vente une par une",
  },
  correctionOnly: { en: "Correction only", ar: "تصحيح فقط", fr: "Correction uniquement" },
  correctionDescription: {
    en: "The original selling price and sale total stay unchanged. The tool replaces only the quantity you enter, returns that quantity to the wrong item, deducts it from the correct item, and recalculates item cost/profit through the normal POS edit flow.",
    ar: "يبقى سعر البيع الأصلي وإجمالي البيع دون تغيير. تستبدل الأداة الكمية التي تُدخلها فقط، وتعيدها إلى الصنف الخاطئ، وتخصمها من الصنف الصحيح، ثم تعيد احتساب تكلفة الصنف وربحه عبر مسار تعديل نقاط البيع المعتاد.",
    fr: "Le prix de vente d’origine et le total de la vente restent inchangés. L’outil remplace uniquement la quantité saisie, la restitue à l’article erroné, la déduit de l’article correct et recalcule le coût et le bénéfice via le flux normal de modification POS.",
  },
  chooseWhatToReplace: {
    en: "Choose what to replace",
    ar: "اختر ما تريد استبداله",
    fr: "Choisir ce qu’il faut remplacer",
  },
  location: { en: "Location", ar: "الموقع", fr: "Emplacement" },
  chooseLocation: { en: "Choose location", ar: "اختر الموقع", fr: "Choisir l’emplacement" },
  wrongItem: { en: "Wrong item in POS", ar: "الصنف الخاطئ في نقطة البيع", fr: "Article erroné dans le POS" },
  correctItem: { en: "Correct item", ar: "الصنف الصحيح", fr: "Article correct" },
  from: { en: "From", ar: "من", fr: "Du" },
  to: { en: "To", ar: "إلى", fr: "Au" },
  refreshSales: { en: "Refresh sales", ar: "تحديث المبيعات", fr: "Actualiser les ventes" },
  matchingLines: {
    en: "{count} matching POS line(s)",
    ar: "{count} سطر مطابق في نقاط البيع",
    fr: "{count} ligne(s) POS correspondante(s)",
  },
  newest500: {
    en: "Showing newest 500 rows — narrow the date range",
    ar: "يتم عرض أحدث 500 صف — ضيّق نطاق التاريخ",
    fr: "Affichage des 500 lignes les plus récentes — réduisez la période",
  },
  matchingSales: { en: "Matching sales", ar: "المبيعات المطابقة", fr: "Ventes correspondantes" },
  matchingSalesHint: {
    en: "Enter a replacement quantity only on the POS lines that were wrong. Leave the rest blank.",
    ar: "أدخل كمية الاستبدال فقط في أسطر نقاط البيع الخاطئة واترك البقية فارغة.",
    fr: "Saisissez une quantité de remplacement uniquement sur les lignes POS erronées. Laissez les autres vides.",
  },
  clearQuantities: { en: "Clear quantities", ar: "مسح الكميات", fr: "Effacer les quantités" },
  chooseSourceHint: {
    en: "Choose a location and the wrong item to load matching POS sales.",
    ar: "اختر موقعًا والصنف الخاطئ لتحميل مبيعات نقاط البيع المطابقة.",
    fr: "Choisissez un emplacement et l’article erroné pour charger les ventes POS correspondantes.",
  },
  loadingSales: {
    en: "Loading matching POS sales…",
    ar: "جارٍ تحميل مبيعات نقاط البيع المطابقة…",
    fr: "Chargement des ventes POS correspondantes…",
  },
  noSales: {
    en: "No matching sales found for this item, location, and date range.",
    ar: "لم يتم العثور على مبيعات مطابقة لهذا الصنف والموقع ونطاق التاريخ.",
    fr: "Aucune vente correspondante trouvée pour cet article, cet emplacement et cette période.",
  },
  date: { en: "Date", ar: "التاريخ", fr: "Date" },
  posVoucher: { en: "POS / Voucher", ar: "نقطة البيع / السند", fr: "POS / Pièce" },
  soldQty: { en: "Sold Qty", ar: "الكمية المباعة", fr: "Qté vendue" },
  rate: { en: "Rate", ar: "السعر", fr: "Prix" },
  replaceQty: { en: "Replace Qty", ar: "كمية الاستبدال", fr: "Qté à remplacer" },
  oldItemLeft: { en: "Old Item Left", ar: "المتبقي من الصنف القديم", fr: "Ancien article restant" },
  posSale: { en: "POS Sale", ar: "بيع نقطة بيع", fr: "Vente POS" },
  all: { en: "All", ar: "الكل", fr: "Tout" },
  max: { en: "Max {qty}", ar: "الحد الأقصى {qty}", fr: "Max {qty}" },
  chooseCorrectItem: { en: "choose correct item", ar: "اختر الصنف الصحيح", fr: "choisir l’article correct" },
  selectionSummary: {
    en: "Replace {qty} qty from {source} → {target}",
    ar: "استبدال كمية {qty} من {source} ← {target}",
    fr: "Remplacer {qty} de {source} → {target}",
  },
  selectionDetails: {
    en: "{lines} sale line(s) across {sales} POS sale(s). Original sale prices stay unchanged.",
    ar: "{lines} سطر بيع ضمن {sales} عملية بيع في نقاط البيع. تبقى أسعار البيع الأصلية دون تغيير.",
    fr: "{lines} ligne(s) sur {sales} vente(s) POS. Les prix de vente d’origine restent inchangés.",
  },
  applyReplacements: {
    en: "Apply {count} replacement(s)",
    ar: "تطبيق {count} عملية استبدال",
    fr: "Appliquer {count} remplacement(s)",
  },
  correctedTitle: { en: "POS items corrected", ar: "تم تصحيح أصناف نقاط البيع", fr: "Articles POS corrigés" },
  correctedDescription: {
    en: "{qty} qty replaced across {sales} sale(s).",
    ar: "تم استبدال كمية {qty} عبر {sales} عملية بيع.",
    fr: "{qty} remplacé sur {sales} vente(s).",
  },
  replacementFailed: { en: "Replacement failed", ar: "فشل الاستبدال", fr: "Échec du remplacement" },
} as const satisfies Record<string, Translation>;

export type PosItemReplacementTranslationKey = keyof typeof posItemReplacementTranslations;

export function translatePosItemReplacement(
  key: PosItemReplacementTranslationKey,
  language: ApplicationLanguage,
  variables: Record<string, string | number> = {}
): string {
  const template = posItemReplacementTranslations[key][language] ?? posItemReplacementTranslations[key].en;
  return template.replace(/\{(\w+)\}/g, (_match, name: string) => String(variables[name] ?? `{${name}}`));
}

const serverMessageTranslations = [
  {
    en: "POS item replacement is available from ERP only",
    ar: "استبدال أصناف نقاط البيع متاح من نظام ERP فقط",
    fr: "Le remplacement d’articles POS est disponible uniquement depuis l’ERP",
  },
  {
    en: "You do not have access to POS item replacement",
    ar: "ليس لديك صلاحية الوصول إلى استبدال أصناف نقاط البيع",
    fr: "Vous n’avez pas accès au remplacement d’articles POS",
  },
  { en: "No company selected", ar: "لم يتم اختيار شركة", fr: "Aucune société sélectionnée" },
  { en: "Invalid filters", ar: "عوامل التصفية غير صالحة", fr: "Filtres non valides" },
  { en: "Invalid replacement request", ar: "طلب الاستبدال غير صالح", fr: "Demande de remplacement non valide" },
  {
    en: "At least one replacement is required",
    ar: "يلزم تحديد عملية استبدال واحدة على الأقل",
    fr: "Au moins un remplacement est requis",
  },
  {
    en: "One or more selected POS sale items no longer exist",
    ar: "صنف واحد أو أكثر من أصناف مبيعات نقاط البيع المحددة لم يعد موجودًا",
    fr: "Un ou plusieurs articles de vente POS sélectionnés n’existent plus",
  },
  {
    en: "Sale item ${saleItemId} changed while the correction was loading",
    ar: "تغير صنف البيع ${saleItemId} أثناء تحميل التصحيح",
    fr: "L’article de vente ${saleItemId} a changé pendant le chargement de la correction",
  },
  {
    en: "Sale item ${saleItemId} was not found in this company",
    ar: "لم يتم العثور على صنف البيع ${saleItemId} في هذه الشركة",
    fr: "L’article de vente ${saleItemId} est introuvable dans cette société",
  },
  {
    en: "Sale item ${saleItemId} does not belong to an active Sales voucher",
    ar: "صنف البيع ${saleItemId} لا ينتمي إلى سند مبيعات نشط",
    fr: "L’article de vente ${saleItemId} n’appartient pas à une pièce de vente active",
  },
  {
    en: "Sale item ${saleItemId} is not from the selected location",
    ar: "صنف البيع ${saleItemId} ليس من الموقع المحدد",
    fr: "L’article de vente ${saleItemId} ne provient pas de l’emplacement sélectionné",
  },
  {
    en: "Replacement stock item ${stockItemId} was not found in this company",
    ar: "لم يتم العثور على صنف المخزون البديل ${stockItemId} في هذه الشركة",
    fr: "L’article de stock de remplacement ${stockItemId} est introuvable dans cette société",
  },
  {
    en: "Replacement quantity must be greater than zero",
    ar: "يجب أن تكون كمية الاستبدال أكبر من صفر",
    fr: "La quantité de remplacement doit être supérieure à zéro",
  },
  {
    en: "Replacement item must be different from the original item",
    ar: "يجب أن يكون الصنف البديل مختلفًا عن الصنف الأصلي",
    fr: "L’article de remplacement doit être différent de l’article d’origine",
  },
  {
    en: "Replacement quantity for sale item ${saleItemId} exceeds the sold quantity ${originalQty}",
    ar: "كمية الاستبدال لصنف البيع ${saleItemId} تتجاوز الكمية المباعة ${originalQty}",
    fr: "La quantité de remplacement de l’article de vente ${saleItemId} dépasse la quantité vendue ${originalQty}",
  },
  {
    en: "Voucher ${voucherId} is missing its location",
    ar: "السند ${voucherId} لا يحتوي على موقع",
    fr: "La pièce ${voucherId} n’a pas d’emplacement",
  },
  {
    en: "Failed to update voucher ${voucherNumber}",
    ar: "تعذر تحديث السند ${voucherNumber}",
    fr: "Échec de la mise à jour de la pièce ${voucherNumber}",
  },
  {
    en: "POS item replacement failed",
    ar: "فشل استبدال أصناف نقاط البيع",
    fr: "Échec du remplacement d’articles POS",
  },
  {
    en: "Updated ${count} POS sale",
    ar: "تم تحديث ${count} عملية بيع في نقطة البيع",
    fr: "${count} vente POS mise à jour",
  },
  {
    en: "Updated ${count} POS sales",
    ar: "تم تحديث ${count} عمليات بيع في نقاط البيع",
    fr: "${count} ventes POS mises à jour",
  },
] as const satisfies readonly Translation[];

const directLiteralTranslations = new Map<string, Translation>();
for (const translation of Object.values(posItemReplacementTranslations)) {
  directLiteralTranslations.set(translation.en, translation);
}
for (const translation of serverMessageTranslations) {
  directLiteralTranslations.set(translation.en, translation);
}

const PLACEHOLDER_PATTERN = /\$\{[^}]+\}/g;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const interpolatedServerMessages = serverMessageTranslations
  .filter((entry) => entry.en.includes("${"))
  .map((entry) => ({
    matcher: new RegExp(
      `^${entry.en
        .split(PLACEHOLDER_PATTERN)
        .map((literal) => escapeRegExp(literal))
        .join("(.*?)")}$`,
      "s"
    ),
    translation: entry,
  }));

function applyCaptures(template: string, captures: string[]): string {
  let index = 0;
  return template.replace(PLACEHOLDER_PATTERN, () => captures[index++] ?? "");
}

export function translatePosItemReplacementLiteral(value: string, language: ApplicationLanguage): string | null {
  const direct = directLiteralTranslations.get(value);
  if (direct) return direct[language];

  for (const entry of interpolatedServerMessages) {
    const match = entry.matcher.exec(value);
    if (match) return applyCaptures(entry.translation[language], match.slice(1));
  }
  return null;
}

export function isPosItemReplacementText(value: string): boolean {
  return translatePosItemReplacementLiteral(value, "en") !== null;
}
