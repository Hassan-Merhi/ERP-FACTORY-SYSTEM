import type { ApplicationLanguage } from "@shared/applicationLanguageContract";
import { createPhase3TemplateTranslator } from "./phase3TemplateTranslationRuntime";
import type { Phase3SharedUiEntry } from "./sharedUiPhase3TranslationTypes";

export const retailWave1Translations: readonly Phase3SharedUiEntry[] = [
  { en: "Retail", ar: "التجزئة", fr: "Vente au détail" },
  { en: "Retail / Variant Inventory", ar: "مخزون التجزئة / المتغيرات", fr: "Stock détail / variantes" },
  {
    en: "Leave empty for Other / No Brand",
    ar: "اتركه فارغًا لاختيار أخرى / بدون علامة",
    fr: "Laissez vide pour Autre / Sans marque",
  },
  {
    en: "One image URL per line (up to 8)",
    ar: "رابط صورة واحد في كل سطر (حتى 8)",
    fr: "Une URL d’image par ligne (jusqu’à 8)",
  },
  {
    en: "Search product, code or brand…",
    ar: "ابحث عن منتج أو رمز أو علامة…",
    fr: "Rechercher un produit, un code ou une marque…",
  },
  { en: "Item name *", ar: "اسم الصنف *", fr: "Nom de l’article *" },
  { en: "SKU / Item code *", ar: "SKU / رمز الصنف *", fr: "SKU / Code article *" },
  { en: "Brand", ar: "العلامة التجارية", fr: "Marque" },
  {
    en: "Other / No Brand or custom brand",
    ar: "أخرى / بدون علامة أو علامة مخصصة",
    fr: "Autre / Sans marque ou marque personnalisée",
  },
  { en: "Custom brand (optional)", ar: "علامة مخصصة (اختياري)", fr: "Marque personnalisée (facultatif)" },
  { en: "Product image URLs", ar: "روابط صور المنتج", fr: "URL des images du produit" },
  { en: "Sizes / Variants", ar: "المقاسات / المتغيرات", fr: "Tailles / Variantes" },
  {
    en: "Each size has its own barcode, price, cost and location stock.",
    ar: "لكل مقاس باركود وسعر وتكلفة ومخزون مواقع مستقل.",
    fr: "Chaque taille possède son propre code-barres, prix, coût et stock par emplacement.",
  },
  { en: "Add size", ar: "إضافة مقاس", fr: "Ajouter une taille" },
  { en: "Size *", ar: "المقاس *", fr: "Taille *" },
  { en: "Selling price", ar: "سعر البيع", fr: "Prix de vente" },
  { en: "Last sold", ar: "آخر سعر بيع", fr: "Dernier prix de vente" },
  { en: "Low stock", ar: "مخزون منخفض", fr: "Stock faible" },
  { en: "Stock by location", ar: "المخزون حسب الموقع", fr: "Stock par emplacement" },
  { en: "Import Retail Products", ar: "استيراد منتجات التجزئة", fr: "Importer les produits de détail" },
  { en: "Download template", ar: "تنزيل القالب", fr: "Télécharger le modèle" },
  { en: "rows ready", ar: "صفوف جاهزة", fr: "lignes prêtes" },
  {
    en: "Retail inventory is only available when a Retail / Variant Inventory company is selected.",
    ar: "يتوفر مخزون التجزئة فقط عند اختيار شركة من نوع مخزون التجزئة / المتغيرات.",
    fr: "Le stock de détail est disponible uniquement lorsqu’une société Stock détail / variantes est sélectionnée.",
  },
  { en: "Loading product…", ar: "جارٍ تحميل المنتج…", fr: "Chargement du produit…" },
  { en: "Edit product", ar: "تعديل المنتج", fr: "Modifier le produit" },
  { en: "Stock by size", ar: "المخزون حسب المقاس", fr: "Stock par taille" },
  { en: "Retail Inventory", ar: "مخزون التجزئة", fr: "Stock de détail" },
  {
    en: "Products grouped by brand with independent stock and barcodes for every size.",
    ar: "منتجات مجمعة حسب العلامة مع مخزون وباركود مستقلين لكل مقاس.",
    fr: "Produits regroupés par marque avec un stock et un code-barres indépendants pour chaque taille.",
  },
  { en: "All brands", ar: "كل العلامات", fr: "Toutes les marques" },
  { en: "All sizes", ar: "كل المقاسات", fr: "Toutes les tailles" },
  { en: "All stock", ar: "كل المخزون", fr: "Tous les stocks" },
  { en: "In stock", ar: "متوفر", fr: "En stock" },
  { en: "Out of stock", ar: "نفد المخزون", fr: "Rupture de stock" },
  { en: "Image", ar: "الصورة", fr: "Image" },
  { en: "Available sizes", ar: "المقاسات المتاحة", fr: "Tailles disponibles" },
  { en: "Total quantity", ar: "إجمالي الكمية", fr: "Quantité totale" },
  { en: "Loading retail inventory…", ar: "جارٍ تحميل مخزون التجزئة…", fr: "Chargement du stock de détail…" },
  {
    en: "No products match these filters.",
    ar: "لا توجد منتجات تطابق عوامل التصفية.",
    fr: "Aucun produit ne correspond à ces filtres.",
  },
  { en: "Remove size", ar: "إزالة المقاس", fr: "Supprimer la taille" },
  { en: "Could not save product", ar: "تعذر حفظ المنتج", fr: "Impossible d’enregistrer le produit" },
  { en: "Retail import complete", ar: "اكتمل استيراد التجزئة", fr: "Import de détail terminé" },
  {
    en: "${result.rowsProcessed} rows · ${result.productsCreated} new products · ${result.variantsCreated} new variants",
    ar: "{{0}} صف · {{1}} منتج جديد · {{2}} متغير جديد",
    fr: "{{0}} lignes · {{1}} nouveaux produits · {{2}} nouvelles variantes",
  },
  { en: "File ready", ar: "الملف جاهز", fr: "Fichier prêt" },
  {
    en: "${mapped.length} rows validated for import",
    ar: "تم التحقق من {{0}} صف للاستيراد",
    fr: "{{0}} lignes validées pour l’importation",
  },
  { en: "Invalid Excel file", ar: "ملف Excel غير صالح", fr: "Fichier Excel non valide" },
  {
    en: "Product code and name are required",
    ar: "رمز المنتج واسمه مطلوبان",
    fr: "Le code et le nom du produit sont requis",
  },
  {
    en: "Every variant needs a size and barcode",
    ar: "كل متغير يحتاج إلى مقاس وباركود",
    fr: "Chaque variante doit avoir une taille et un code-barres",
  },
  {
    en: "Choose a populated Excel file first",
    ar: "اختر أولًا ملف Excel يحتوي على بيانات",
    fr: "Choisissez d’abord un fichier Excel contenant des données",
  },
  {
    en: "Row ${badIndex + 2} is missing Code, Name, Size, Barcode or Location",
    ar: "الصف {{0}} يفتقد الرمز أو الاسم أو المقاس أو الباركود أو الموقع",
    fr: "La ligne {{0}} ne contient pas le code, le nom, la taille, le code-barres ou l’emplacement",
  },
  {
    en: "Retail inventory is only available for Retail / Variant Inventory companies",
    ar: "مخزون التجزئة متاح فقط لشركات مخزون التجزئة / المتغيرات",
    fr: "Le stock de détail est disponible uniquement pour les sociétés Stock détail / variantes",
  },
  { en: "Brand name is required", ar: "اسم العلامة التجارية مطلوب", fr: "Le nom de la marque est requis" },
  { en: "Retail product not found", ar: "لم يتم العثور على منتج التجزئة", fr: "Produit de détail introuvable" },
  { en: "No import rows supplied", ar: "لم يتم توفير صفوف للاستيراد", fr: "Aucune ligne d’importation fournie" },
  {
    en: "Import is limited to 5,000 rows per file",
    ar: "الاستيراد محدود بـ 5,000 صف لكل ملف",
    fr: "L’importation est limitée à 5 000 lignes par fichier",
  },
  {
    en: "Brand not found for this company",
    ar: "لم يتم العثور على العلامة لهذه الشركة",
    fr: "Marque introuvable pour cette société",
  },
  {
    en: "Duplicate barcode in product: ${variant.barcode}",
    ar: "باركود مكرر في المنتج: {{0}}",
    fr: "Code-barres dupliqué dans le produit : {{0}}",
  },
  {
    en: "Duplicate size in product: ${variant.size}",
    ar: "مقاس مكرر في المنتج: {{0}}",
    fr: "Taille dupliquée dans le produit : {{0}}",
  },
  {
    en: "Location ${stock.locationId} is repeated for size ${variant.size}",
    ar: "الموقع {{0}} مكرر للمقاس {{1}}",
    fr: "L’emplacement {{0}} est répété pour la taille {{1}}",
  },
  {
    en: "Location ${invalid} does not belong to the selected company",
    ar: "الموقع {{0}} لا ينتمي إلى الشركة المحددة",
    fr: "L’emplacement {{0}} n’appartient pas à la société sélectionnée",
  },
  {
    en: "Barcode already exists: ${row.barcode}",
    ar: "الباركود موجود بالفعل: {{0}}",
    fr: "Le code-barres existe déjà : {{0}}",
  },
  {
    en: "Product code already exists: ${input.code}",
    ar: "رمز المنتج موجود بالفعل: {{0}}",
    fr: "Le code produit existe déjà : {{0}}",
  },
  {
    en: "Variant does not belong to this product",
    ar: "المتغير لا ينتمي إلى هذا المنتج",
    fr: "La variante n’appartient pas à ce produit",
  },
  {
    en: "Barcode ${row.barcode} is assigned to more than one product/size in the file",
    ar: "الباركود {{0}} مخصص لأكثر من منتج/مقاس في الملف",
    fr: "Le code-barres {{0}} est attribué à plusieurs produits/tailles dans le fichier",
  },
  {
    en: "Duplicate product/size/location row: ${row.code} / ${row.size} / ${row.location}",
    ar: "صف منتج/مقاس/موقع مكرر: {{0}} / {{1}} / {{2}}",
    fr: "Ligne produit/taille/emplacement dupliquée : {{0}} / {{1}} / {{2}}",
  },
  {
    en: "Unknown location for this company: ${row.location}",
    ar: "موقع غير معروف لهذه الشركة: {{0}}",
    fr: "Emplacement inconnu pour cette société : {{0}}",
  },
  {
    en: "Size ${row.size} on ${row.code} already uses barcode ${variant.barcode}",
    ar: "المقاس {{0}} في {{1}} يستخدم بالفعل الباركود {{2}}",
    fr: "La taille {{0}} de {{1}} utilise déjà le code-barres {{2}}",
  },
  {
    en: "Barcode already exists on another variant: ${row.barcode}",
    ar: "الباركود موجود بالفعل في متغير آخر: {{0}}",
    fr: "Le code-barres existe déjà sur une autre variante : {{0}}",
  },
];

const exactTranslations = new Map<string, Phase3SharedUiEntry>();
for (const entry of retailWave1Translations) {
  if (!entry.en.includes("${")) exactTranslations.set(entry.en, entry);
}
const templateTranslator = createPhase3TemplateTranslator(retailWave1Translations);

export function isRetailWave1Text(value: string): boolean {
  const normalized = value.trim();
  return exactTranslations.has(normalized) || templateTranslator.matches(normalized);
}

export function translateRetailWave1Text(value: string, language: ApplicationLanguage): string | null {
  const leading = value.match(/^\s*/)?.[0] ?? "";
  const trailing = value.match(/\s*$/)?.[0] ?? "";
  const normalized = value.trim();
  const exact = exactTranslations.get(normalized);
  if (exact) return `${leading}${exact[language]}${trailing}`;
  return templateTranslator.translate(value, language, (capture) => capture);
}
