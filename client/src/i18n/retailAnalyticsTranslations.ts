import type { ApplicationLanguage } from "@shared/applicationLanguageContract";
import { createPhase3TemplateTranslator } from "./phase3TemplateTranslationRuntime";
import type { Phase3SharedUiEntry } from "./sharedUiPhase3TranslationTypes";

export const retailWave3Translations: readonly Phase3SharedUiEntry[] = [
  { en: "Retail Dashboard", ar: "لوحة تحكم التجزئة", fr: "Tableau de bord de détail" },
  {
    en: "Sales, margin, inventory health, and variant-level reconciliation from the retail movement ledger.",
    ar: "المبيعات والهامش وسلامة المخزون والتسوية على مستوى المتغير من سجل حركة التجزئة.",
    fr: "Ventes, marge, santé du stock et rapprochement au niveau des variantes à partir du journal des mouvements de détail.",
  },
  {
    en: "Retail reporting is only available for Retail / Variant Inventory companies",
    ar: "تقارير التجزئة متاحة فقط لشركات مخزون التجزئة / المتغيرات",
    fr: "Les rapports de détail sont disponibles uniquement pour les sociétés Stock détail / variantes",
  },
  {
    en: "Retail reporting is only available for Retail / Variant Inventory companies.",
    ar: "تقارير التجزئة متاحة فقط لشركات مخزون التجزئة / المتغيرات.",
    fr: "Les rapports de détail sont disponibles uniquement pour les sociétés Stock détail / variantes.",
  },
  {
    en: "Retail catalog is only available for Retail / Variant Inventory companies",
    ar: "كتالوج التجزئة متاح فقط لشركات مخزون التجزئة / المتغيرات",
    fr: "Le catalogue de détail est disponible uniquement pour les sociétés Stock détail / variantes",
  },
  { en: "Gross profit", ar: "إجمالي الربح", fr: "Bénéfice brut" },
  { en: "Inventory value", ar: "قيمة المخزون", fr: "Valeur du stock" },
  { en: "Units sold", ar: "الوحدات المباعة", fr: "Unités vendues" },
  { en: "Best-selling products", ar: "المنتجات الأكثر مبيعًا", fr: "Produits les plus vendus" },
  { en: "Best-selling brands", ar: "العلامات الأكثر مبيعًا", fr: "Marques les plus vendues" },
  { en: "Best-selling sizes", ar: "المقاسات الأكثر مبيعًا", fr: "Tailles les plus vendues" },
  { en: "Sales by location", ar: "المبيعات حسب الموقع", fr: "Ventes par emplacement" },
  { en: "Low-stock items", ar: "أصناف منخفضة المخزون", fr: "Articles en stock faible" },
  { en: "Out-of-stock products", ar: "منتجات نفد مخزونها", fr: "Produits en rupture de stock" },
  { en: "Slow-moving inventory", ar: "مخزون بطيء الحركة", fr: "Stock à rotation lente" },
  { en: "Low at", ar: "منخفض في", fr: "Faible à" },
  { en: "Last sale", ar: "آخر عملية بيع", fr: "Dernière vente" },
  { en: "Loading retail reporting…", ar: "جارٍ تحميل تقارير التجزئة…", fr: "Chargement des rapports de détail…" },
  { en: "Nothing to review.", ar: "لا يوجد ما يمكن مراجعته.", fr: "Rien à examiner." },
  {
    en: "Could not load retail reporting.",
    ar: "تعذر تحميل تقارير التجزئة.",
    fr: "Impossible de charger les rapports de détail.",
  },
  {
    en: "Report start date must be before end date",
    ar: "يجب أن يكون تاريخ بداية التقرير قبل تاريخ النهاية",
    fr: "La date de début du rapport doit précéder la date de fin",
  },
  {
    en: "Retail report location is not active or does not belong to the selected company",
    ar: "موقع تقرير التجزئة غير نشط أو لا ينتمي إلى الشركة المحددة",
    fr: "L’emplacement du rapport de détail n’est pas actif ou n’appartient pas à la société sélectionnée",
  },
  // Retail ERP integration and product-entry UX (#1476): brand creation,
  // image uploads and the simplified product form.
  { en: "Search product or brand…", ar: "ابحث عن منتج أو علامة…", fr: "Rechercher un produit ou une marque…" },
  { en: "Add brand", ar: "إضافة علامة", fr: "Ajouter une marque" },
  { en: "New brand name", ar: "اسم العلامة الجديدة", fr: "Nom de la nouvelle marque" },
  { en: "Brand added", ar: "تمت إضافة العلامة", fr: "Marque ajoutée" },
  { en: "Could not add brand", ar: "تعذر إضافة العلامة", fr: "Impossible d’ajouter la marque" },
  { en: "Product images", ar: "صور المنتج", fr: "Images du produit" },
  {
    en: "Upload JPG, PNG, WEBP or GIF images. Up to 8 images.",
    ar: "ارفع صور JPG أو PNG أو WEBP أو GIF. حتى 8 صور.",
    fr: "Téléversez des images JPG, PNG, WEBP ou GIF. Jusqu’à 8 images.",
  },
  { en: "Uploading image…", ar: "جارٍ رفع الصورة…", fr: "Téléversement de l’image…" },
  { en: "Image limit reached", ar: "تم بلوغ حد الصور", fr: "Limite d’images atteinte" },
  {
    en: "You can upload up to ${MAX_PRODUCT_IMAGES} images.",
    ar: "يمكنك رفع حتى {{0}} صورة.",
    fr: "Vous pouvez téléverser jusqu’à {{0}} images.",
  },
  { en: "Unsupported image", ar: "صورة غير مدعومة", fr: "Image non prise en charge" },
  {
    en: "Use JPG, PNG, WEBP or GIF images.",
    ar: "استخدم صور JPG أو PNG أو WEBP أو GIF.",
    fr: "Utilisez des images JPG, PNG, WEBP ou GIF.",
  },
  { en: "Image too large", ar: "الصورة كبيرة جدًا", fr: "Image trop volumineuse" },
  {
    en: "${tooLarge.name} is larger than 10 MB.",
    ar: "{{0}} أكبر من 10 ميغابايت.",
    fr: "{{0}} dépasse 10 Mo.",
  },
  { en: "Image upload failed", ar: "فشل رفع الصورة", fr: "Échec du téléversement de l’image" },
  { en: "Could not upload image", ar: "تعذر رفع الصورة", fr: "Impossible de téléverser l’image" },
  {
    en: "Each size has its own barcode, selling price, cost and location stock.",
    ar: "لكل مقاس باركود وسعر بيع وتكلفة ومخزون موقع خاص به.",
    fr: "Chaque taille a son propre code-barres, prix de vente, coût et stock par emplacement.",
  },
  { en: "Item name is required", ar: "اسم الصنف مطلوب", fr: "Le nom de l’article est requis" },
  {
    en: "Every size needs a size value and barcode",
    ar: "كل مقاس يحتاج إلى قيمة مقاس وباركود",
    fr: "Chaque taille nécessite une valeur de taille et un code-barres",
  },
  {
    en: "Row ${badIndex + 2} is missing Name, Size, Barcode or Location",
    ar: "الصف {{0}} ينقصه الاسم أو المقاس أو الباركود أو الموقع",
    fr: "La ligne {{0}} n’a pas de nom, taille, code-barres ou emplacement",
  },

  // Payroll employee-management refresh (#1511). These entries are part of
  // the exact-string application translator used by the shared UI runtime.
  { en: "Employee details", ar: "تفاصيل الموظف", fr: "Détails de l’employé" },
  { en: "e.g. Warehouse", ar: "مثال: المستودع", fr: "ex. Entrepôt" },
  { en: "Employment settings", ar: "إعدادات التوظيف", fr: "Paramètres d’emploi" },
  { en: "Sales bonus", ar: "مكافأة المبيعات", fr: "Prime sur les ventes" },
  { en: "Location bonus rules", ar: "قواعد المكافآت حسب الموقع", fr: "Règles de prime par emplacement" },
  { en: "Remove bale rate", ar: "إزالة معدل البالات", fr: "Supprimer le tarif des balles" },
  {
    en: "Remove percentage bale rate",
    ar: "إزالة نسبة مكافأة البالات",
    fr: "Supprimer le pourcentage de prime des balles",
  },
  { en: "Bale Bonus Rates", ar: "معدلات مكافأة البالات", fr: "Tarifs de prime des balles" },
  { en: "Fixed amount per bale.", ar: "مبلغ ثابت لكل بالة.", fr: "Montant fixe par balle." },
  { en: "Add Location", ar: "إضافة موقع", fr: "Ajouter un emplacement" },
  {
    en: "Percentage-based bale bonus.",
    ar: "مكافأة بالات على أساس النسبة المئوية.",
    fr: "Prime de balles basée sur un pourcentage.",
  },
  {
    en: "Changes are saved to this employee only.",
    ar: "تُحفظ التغييرات لهذا الموظف فقط.",
    fr: "Les modifications sont enregistrées uniquement pour cet employé.",
  },
  {
    en: "No fixed bale rates configured.",
    ar: "لا توجد معدلات ثابتة للبالات.",
    fr: "Aucun tarif fixe de balles n’est configuré.",
  },
  {
    en: "No percentage bale rates configured.",
    ar: "لا توجد نسب مكافآت بالات مهيأة.",
    fr: "Aucun pourcentage de prime des balles n’est configuré.",
  },
  {
    en: "Search by employee name, code, or department...",
    ar: "ابحث باسم الموظف أو الرمز أو القسم...",
    fr: "Rechercher par nom, code ou service...",
  },
  { en: "Monthly payroll", ar: "الرواتب الشهرية", fr: "Paie mensuelle" },
  { en: "No employees yet", ar: "لا يوجد موظفون بعد", fr: "Aucun employé pour le moment" },
  { en: "No matching employees", ar: "لا يوجد موظفون مطابقون", fr: "Aucun employé correspondant" },
  {
    en: "Try a different search or status filter.",
    ar: "جرّب بحثًا أو عامل تصفية حالة مختلفًا.",
    fr: "Essayez une autre recherche ou un autre filtre d’état.",
  },
  {
    en: "All employee details were saved successfully.",
    ar: "تم حفظ جميع تفاصيل الموظف بنجاح.",
    fr: "Tous les détails de l’employé ont été enregistrés avec succès.",
  },
  { en: "Invalid employee group", ar: "مجموعة الموظف غير صالحة", fr: "Groupe d’employé non valide" },

  // Current-main user-facing validation messages surfaced by the same full
  // classified audit. Cover them rather than loosening the reviewed baseline.
  {
    en: "voucherDate must be a valid YYYY-MM-DD date",
    ar: "يجب أن يكون تاريخ القسيمة تاريخًا صالحًا بالتنسيق YYYY-MM-DD",
    fr: "La date du justificatif doit être une date valide au format YYYY-MM-DD",
  },
  {
    en: "Deleted stock adjustments cannot be changed",
    ar: "لا يمكن تغيير تسويات المخزون المحذوفة",
    fr: "Les ajustements de stock supprimés ne peuvent pas être modifiés",
  },
  {
    en: "Invalid stock adjustment data",
    ar: "بيانات تسوية المخزون غير صالحة",
    fr: "Données d’ajustement de stock non valides",
  },
];

const exactTranslations = new Map<string, Phase3SharedUiEntry>();
for (const entry of retailWave3Translations) {
  if (!entry.en.includes("${")) exactTranslations.set(entry.en, entry);
}
const templateTranslator = createPhase3TemplateTranslator(retailWave3Translations);

export function isRetailWave3Text(value: string): boolean {
  const normalized = value.trim();
  return exactTranslations.has(normalized) || templateTranslator.matches(normalized);
}

export function translateRetailWave3Text(value: string, language: ApplicationLanguage): string | null {
  const leading = value.match(/^\s*/)?.[0] ?? "";
  const trailing = value.match(/\s*$/)?.[0] ?? "";
  const normalized = value.trim();
  const exact = exactTranslations.get(normalized);
  if (exact) return `${leading}${exact[language]}${trailing}`;
  return templateTranslator.translate(value, language, (capture) => capture);
}
