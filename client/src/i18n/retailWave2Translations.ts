import type { ApplicationLanguage } from "@shared/applicationLanguageContract";
import { createPhase3TemplateTranslator } from "./phase3TemplateTranslationRuntime";
import type { Phase3SharedUiEntry } from "./sharedUiPhase3TranslationTypes";

export const retailWave2Translations: readonly Phase3SharedUiEntry[] = [
  {
    en: "Scan barcode or search product / SKU / brand / size",
    ar: "امسح الباركود أو ابحث عن المنتج / SKU / العلامة / المقاس",
    fr: "Scannez le code-barres ou recherchez produit / SKU / marque / taille",
  },
  { en: "Retail POS", ar: "نقطة بيع التجزئة", fr: "PDV de détail" },
  { en: "Selling location", ar: "موقع البيع", fr: "Emplacement de vente" },
  { en: "Find item", ar: "البحث عن صنف", fr: "Rechercher un article" },
  { en: "Loading variants…", ar: "جارٍ تحميل المتغيرات…", fr: "Chargement des variantes…" },
  {
    en: "Recent retail sales & returns",
    ar: "مبيعات ومرتجعات التجزئة الأخيرة",
    fr: "Ventes et retours de détail récents",
  },
  {
    en: "No retail sales at this location yet.",
    ar: "لا توجد مبيعات تجزئة في هذا الموقع حتى الآن.",
    fr: "Aucune vente de détail à cet emplacement pour le moment.",
  },
  { en: "Exact-variant transfer", ar: "نقل المتغير المحدد", fr: "Transfert de variante exacte" },
  { en: "Variant", ar: "المتغير", fr: "Variante" },
  {
    en: "Choose exact product + size",
    ar: "اختر المنتج والمقاس المحددين",
    fr: "Choisissez le produit + la taille exacts",
  },
  {
    en: "Scan a barcode or search by name, SKU, barcode, brand, or size.",
    ar: "امسح باركودًا أو ابحث بالاسم أو SKU أو الباركود أو العلامة أو المقاس.",
    fr: "Scannez un code-barres ou recherchez par nom, SKU, code-barres, marque ou taille.",
  },
  {
    en: "No matching retail variants.",
    ar: "لا توجد متغيرات تجزئة مطابقة.",
    fr: "Aucune variante de détail correspondante.",
  },
  {
    en: "Scan or select an exact size to start a sale.",
    ar: "امسح أو اختر المقاس المحدد لبدء البيع.",
    fr: "Scannez ou sélectionnez une taille exacte pour commencer une vente.",
  },
  { en: "Cancel / reverse sale", ar: "إلغاء / عكس البيع", fr: "Annuler / contrepasser la vente" },
  { en: "${item.name} · ${item.size}", ar: "{{0}} · {{1}}", fr: "{{0}} · {{1}}" },
  { en: "Scanned into cart", ar: "تمت الإضافة إلى السلة بالمسح", fr: "Ajouté au panier par scan" },
  { en: "Sale completed", ar: "اكتمل البيع", fr: "Vente terminée" },
  {
    en: "Exact variant stock was deducted.",
    ar: "تم خصم مخزون المتغير المحدد.",
    fr: "Le stock de la variante exacte a été déduit.",
  },
  { en: "Sale failed", ar: "فشل البيع", fr: "Échec de la vente" },
  { en: "Return completed", ar: "اكتمل الإرجاع", fr: "Retour terminé" },
  {
    en: "The exact size was restored to this location.",
    ar: "تمت إعادة المقاس المحدد إلى هذا الموقع.",
    fr: "La taille exacte a été rétablie à cet emplacement.",
  },
  { en: "Return failed", ar: "فشل الإرجاع", fr: "Échec du retour" },
  { en: "Sale canceled", ar: "تم إلغاء البيع", fr: "Vente annulée" },
  {
    en: "Unreturned quantities were restored exactly once.",
    ar: "تمت إعادة الكميات غير المرتجعة مرة واحدة فقط.",
    fr: "Les quantités non retournées ont été rétablies une seule fois.",
  },
  {
    en: "The exact variant moved between locations.",
    ar: "تم نقل المتغير المحدد بين المواقع.",
    fr: "La variante exacte a été déplacée entre les emplacements.",
  },
  {
    en: "Choose an item, destination and quantity",
    ar: "اختر الصنف والوجهة والكمية",
    fr: "Choisissez un article, une destination et une quantité",
  },
  {
    en: "Retail companies must use the exact-variant retail POS endpoint",
    ar: "يجب على شركات التجزئة استخدام نقطة البيع الخاصة بالمتغير المحدد",
    fr: "Les sociétés de détail doivent utiliser le point de vente dédié à la variante exacte",
  },
  {
    en: "Retail POS is only available for Retail / Variant Inventory companies",
    ar: "نقطة بيع التجزئة متاحة فقط لشركات مخزون التجزئة / المتغيرات",
    fr: "Le PDV de détail est disponible uniquement pour les sociétés Stock détail / variantes",
  },
  { en: "Invalid sale", ar: "بيع غير صالح", fr: "Vente invalide" },
  {
    en: "POS users cannot transfer retail stock",
    ar: "لا يمكن لمستخدمي نقطة البيع نقل مخزون التجزئة",
    fr: "Les utilisateurs PDV ne peuvent pas transférer le stock de détail",
  },
  {
    en: "Transfer locations must be different",
    ar: "يجب أن يكون موقعا النقل مختلفين",
    fr: "Les emplacements de transfert doivent être différents",
  },
  {
    en: "POS users cannot make stock adjustments",
    ar: "لا يمكن لمستخدمي نقطة البيع إجراء تعديلات على المخزون",
    fr: "Les utilisateurs PDV ne peuvent pas effectuer d’ajustements de stock",
  },
  {
    en: "Authenticated user is required",
    ar: "يلزم مستخدم مصادق عليه",
    fr: "Un utilisateur authentifié est requis",
  },
  {
    en: "Location is not active or does not belong to the selected company",
    ar: "الموقع غير نشط أو لا ينتمي إلى الشركة المحددة",
    fr: "L’emplacement n’est pas actif ou n’appartient pas à la société sélectionnée",
  },
  {
    en: "Retail variant not found or inactive",
    ar: "لم يتم العثور على متغير التجزئة أو أنه غير نشط",
    fr: "Variante de détail introuvable ou inactive",
  },
  {
    en: "Retail inventory row could not be created",
    ar: "تعذر إنشاء سجل مخزون التجزئة",
    fr: "Impossible de créer la ligne de stock de détail",
  },
  {
    en: "Sale retry could not be resolved",
    ar: "تعذر تسوية إعادة محاولة البيع",
    fr: "Impossible de résoudre la nouvelle tentative de vente",
  },
  {
    en: "Insufficient stock for ${variant.productName} / ${variant.size}. Available: ${stock.quantity}",
    ar: "المخزون غير كافٍ لـ {{0}} / {{1}}. المتاح: {{2}}",
    fr: "Stock insuffisant pour {{0}} / {{1}}. Disponible : {{2}}",
  },
  {
    en: "Return retry could not be resolved",
    ar: "تعذر تسوية إعادة محاولة الإرجاع",
    fr: "Impossible de résoudre la nouvelle tentative de retour",
  },
  { en: "Retail sale not found", ar: "لم يتم العثور على بيع التجزئة", fr: "Vente de détail introuvable" },
  {
    en: "Return location must match the original sale location",
    ar: "يجب أن يطابق موقع الإرجاع موقع البيع الأصلي",
    fr: "L’emplacement du retour doit correspondre à l’emplacement de la vente d’origine",
  },
  {
    en: "Canceled sales cannot receive additional returns",
    ar: "لا يمكن للمبيعات الملغاة تلقي مرتجعات إضافية",
    fr: "Les ventes annulées ne peuvent pas recevoir de retours supplémentaires",
  },
  {
    en: "Sale item ${saleItemId} not found",
    ar: "لم يتم العثور على بند البيع {{0}}",
    fr: "Article de vente {{0}} introuvable",
  },
  {
    en: "Insufficient stock for transfer. Available: ${source.quantity}",
    ar: "المخزون غير كافٍ للنقل. المتاح: {{0}}",
    fr: "Stock insuffisant pour le transfert. Disponible : {{0}}",
  },
  {
    en: "Cancellation location must match the original sale location",
    ar: "يجب أن يطابق موقع الإلغاء موقع البيع الأصلي",
    fr: "L’emplacement de l’annulation doit correspondre à l’emplacement de la vente d’origine",
  },
  {
    en: "Insufficient stock. Available: ${before}",
    ar: "المخزون غير كافٍ. المتاح: {{0}}",
    fr: "Stock insuffisant. Disponible : {{0}}",
  },
  {
    en: "Return quantity exceeds the remaining sold quantity",
    ar: "كمية الإرجاع تتجاوز الكمية المباعة المتبقية",
    fr: "La quantité retournée dépasse la quantité vendue restante",
  },
];

const exactTranslations = new Map<string, Phase3SharedUiEntry>();
for (const entry of retailWave2Translations) {
  if (!entry.en.includes("${")) exactTranslations.set(entry.en, entry);
}
const templateTranslator = createPhase3TemplateTranslator(retailWave2Translations);

export function isRetailWave2Text(value: string): boolean {
  const normalized = value.trim();
  return exactTranslations.has(normalized) || templateTranslator.matches(normalized);
}

export function translateRetailWave2Text(value: string, language: ApplicationLanguage): string | null {
  const leading = value.match(/^\s*/)?.[0] ?? "";
  const trailing = value.match(/\s*$/)?.[0] ?? "";
  const normalized = value.trim();
  const exact = exactTranslations.get(normalized);
  if (exact) return `${leading}${exact[language]}${trailing}`;
  return templateTranslator.translate(value, language, (capture) => capture);
}
