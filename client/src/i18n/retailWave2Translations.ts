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
  { en: "Open POS", ar: "فتح نقطة البيع", fr: "Ouvrir le PDV" },
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
  {
    en: "Scan barcode or search product / SKU / brand / color / size",
    ar: "امسح الباركود أو ابحث عن المنتج / SKU / العلامة / اللون / المقاس",
    fr: "Scannez le code-barres ou recherchez produit / SKU / marque / couleur / taille",
  },
  {
    en: "Choose exact product + color + size",
    ar: "اختر المنتج واللون والمقاس المحددين",
    fr: "Choisissez le produit + la couleur + la taille exacts",
  },
  {
    en: "Scan a barcode or search by name, SKU, barcode, brand, color, or size.",
    ar: "امسح باركودًا أو ابحث بالاسم أو SKU أو الباركود أو العلامة أو اللون أو المقاس.",
    fr: "Scannez un code-barres ou recherchez par nom, SKU, code-barres, marque, couleur ou taille.",
  },
  {
    en: "Scan or select an exact color and size to start a sale.",
    ar: "امسح أو اختر اللون والمقاس المحددين لبدء البيع.",
    fr: "Scannez ou sélectionnez une couleur et une taille exactes pour commencer une vente.",
  },
  {
    en: "${item.name} · ${item.color} · ${item.size}",
    ar: "{{0}} · {{1}} · {{2}}",
    fr: "{{0}} · {{1}} · {{2}}",
  },
  {
    en: "The exact color and size were restored to this location.",
    ar: "تمت إعادة اللون والمقاس المحددين إلى هذا الموقع.",
    fr: "La couleur et la taille exactes ont été rétablies à cet emplacement.",
  },
  { en: "Walk-in customer", ar: "عميل عابر", fr: "Client de passage" },
  { en: "Add customer", ar: "إضافة عميل", fr: "Ajouter un client" },
  {
    en: "Search name, phone or code",
    ar: "ابحث بالاسم أو الهاتف أو الرمز",
    fr: "Rechercher par nom, téléphone ou code",
  },
  { en: "Searching…", ar: "جارٍ البحث…", fr: "Recherche…" },
  { en: "No customer matches.", ar: "لا يوجد عميل مطابق.", fr: "Aucun client correspondant." },
  { en: "Customer name", ar: "اسم العميل", fr: "Nom du client" },
  { en: "Phone (optional)", ar: "الهاتف (اختياري)", fr: "Téléphone (facultatif)" },
  { en: "Create customer", ar: "إنشاء عميل", fr: "Créer le client" },
  { en: "Customer created", ar: "تم إنشاء العميل", fr: "Client créé" },
  { en: "Could not create customer", ar: "تعذّر إنشاء العميل", fr: "Impossible de créer le client" },
  { en: "Line discount / price override", ar: "حسم السطر / تجاوز السعر", fr: "Remise de ligne / modification du prix" },
  { en: "Discount percent", ar: "نسبة الحسم", fr: "Pourcentage de remise" },
  { en: "Discount per unit", ar: "حسم لكل وحدة", fr: "Remise par unité" },
  { en: "New unit price", ar: "سعر الوحدة الجديد", fr: "Nouveau prix unitaire" },
  { en: "No discount", ar: "بدون حسم", fr: "Sans remise" },
  { en: "Price override", ar: "تجاوز السعر", fr: "Modification du prix" },
  { en: "Reason (required)", ar: "السبب (مطلوب)", fr: "Motif (obligatoire)" },
  { en: "Why this discount is given", ar: " سبب منح هذا الحسم", fr: "Motif de cette remise" },
  { en: "Apply", ar: "تطبيق", fr: "Appliquer" },
  { en: "Manager approval required", ar: "مطلوب موافقة المدير", fr: "Approbation du responsable requise" },
  { en: "Manager username", ar: "اسم مستخدم المدير", fr: "Nom d'utilisateur du responsable" },
  { en: "Manager password", ar: "كلمة مرور المدير", fr: "Mot de passe du responsable" },
  { en: "Approve", ar: "موافقة", fr: "Approuver" },
  { en: "Approving…", ar: "جارٍ الموافقة…", fr: "Approbation…" },
  {
    en: "This discount or price override needs a manager.",
    ar: "يحتاج هذا الحسم أو تجاوز السعر إلى موافقة مدير.",
    fr: "Cette remise ou modification de prix nécessite un responsable.",
  },
  {
    en: "Line discount or price override",
    ar: "حسم السطر أو تجاوز السعر",
    fr: "Remise de ligne ou modification du prix",
  },
  { en: "Whole-sale discount", ar: "حسم على كامل البيع", fr: "Remise sur la vente entière" },
  { en: "Fixed amount", ar: "مبلغ ثابت", fr: "Montant fixe" },
  {
    en: "Manager approval will be requested when the sale is completed.",
    ar: "سيُطلب اعتماد المدير عند إتمام البيع.",
    fr: "L'approbation du responsable sera demandée à la validation de la vente.",
  },
  { en: "Discount approved", ar: "تم اعتماد الحسم", fr: "Remise approuvée" },
  {
    en: "Manager approval for this sale",
    ar: "موافقة المدير على هذا البيع",
    fr: "Approbation du responsable pour cette vente",
  },
  { en: "Subtotal", ar: "المجموع الفرعي", fr: "Sous-total" },
  { en: "Discount", ar: "الحسم", fr: "Remise" },
  { en: "Net", ar: "الصافي", fr: "Net" },
  { en: "Physical stock count", ar: "الجرد الفعلي للمخزون", fr: "Comptage physique du stock" },
  { en: "Sessions", ar: "الجلسات", fr: "Sessions" },
  {
    en: "No stock counts yet at this location.",
    ar: "لا توجد جلسات جرد في هذا الموقع بعد.",
    fr: "Aucun comptage de stock à cet emplacement.",
  },
  {
    en: "Start a count or pick a session to continue.",
    ar: "ابدأ جردًا أو اختر جلسة للمتابعة.",
    fr: "Démarrez un comptage ou choisissez une session.",
  },
  { en: "Start counting", ar: "بدء العدّ", fr: "Commencer le comptage" },
  { en: "Send to review", ar: "إرسال للمراجعة", fr: "Envoyer en revue" },
  { en: "Recount flagged", ar: "إعادة عدّ السطور المعلّمة", fr: "Recompter les lignes signalées" },
  { en: "Finalize", ar: "إنهاء", fr: "Finaliser" },
  { en: "Finalized", ar: "منتهٍ", fr: "Finalisé" },
  { en: "Draft", ar: "مسودة", fr: "Brouillon" },
  { en: "Counting", ar: "جارٍ العدّ", fr: "Comptage" },
  { en: "Review", ar: "مراجعة", fr: "Revue" },
  { en: "Canceled", ar: "ملغى", fr: "Annulé" },
  { en: "Counted", ar: "تم عدّه", fr: "Compté" },
  { en: "Uncounted", ar: "لم يُعدّ", fr: "Non compté" },
  { en: "Variance", ar: "فرق", fr: "Écart" },
  { en: "Unexpected", ar: "غير متوقع", fr: "Inattendu" },
  {
    en: "Scan a barcode to add one unit",
    ar: "امسح باركودًا لإضافة وحدة واحدة",
    fr: "Scannez un code-barres pour ajouter une unité",
  },
  { en: "Count 1", ar: "عدّ 1", fr: "Compter 1" },
  { en: "Product", ar: "المنتج", fr: "Produit" },
  { en: "Size", ar: "المقاس", fr: "Taille" },
  { en: "Barcode", ar: "الباركود", fr: "Code-barres" },
  { en: "Expected", ar: "المتوقع", fr: "Attendu" },
  { en: "Difference", ar: "الفرق", fr: "Différence" },
  { en: "Recount", ar: "إعادة العدّ", fr: "Recompter" },
  { en: "History & variance", ar: "السجل والفروقات", fr: "Historique et écarts" },
  { en: "Export CSV", ar: "تصدير CSV", fr: "Exporter CSV" },
  { en: "Net variance (units)", ar: "صافي الفرق (وحدات)", fr: "Écart net (unités)" },
  { en: "Variance value", ar: "قيمة الفرق", fr: "Valeur de l'écart" },
  { en: "New count", ar: "جرد جديد", fr: "Nouveau comptage" },
  {
    en: "Include variants with no stock here",
    ar: "تضمين المتغيرات التي لا مخزون لها هنا",
    fr: "Inclure les variantes sans stock ici",
  },
  { en: "Finalize count", ar: "إنهاء الجرد", fr: "Finaliser le comptage" },
  { en: "Notes (optional)", ar: "ملاحظات (اختياري)", fr: "Notes (facultatif)" },
  { en: "Recount required", ar: "مطلوب إعادة عدّ", fr: "Recomptage requis" },
  { en: "Selling settings", ar: "إعدادات البيع", fr: "Paramètres de vente" },
  {
    en: "Charge tax on retail sales",
    ar: "تحصيل الضريبة على مبيعات التجزئة",
    fr: "Appliquer la taxe aux ventes de détail",
  },
  { en: "Tax label", ar: "اسم الضريبة", fr: "Libellé de la taxe" },
  { en: "Rate %", ar: "النسبة %", fr: "Taux %" },
  { en: "Discount limits & approvals", ar: "حدود الحسم والموافقات", fr: "Limites de remise et approbations" },
  { en: "Discount limit %", ar: "حد الحسم %", fr: "Limite de remise %" },
  {
    en: "Require manager approval above the limit",
    ar: "طلب موافقة المدير فوق الحد",
    fr: "Exiger l'approbation du responsable au-delà de la limite",
  },
  {
    en: "Manual price overrides always need a manager",
    ar: "تجاوز السعر اليدوي يحتاج دائمًا إلى مدير",
    fr: "La modification manuelle du prix exige un responsable",
  },
  { en: "Save settings", ar: "حفظ الإعدادات", fr: "Enregistrer les paramètres" },
  { en: "Settings saved", ar: "تم حفظ الإعدادات", fr: "Paramètres enregistrés" },
  { en: "Promotions", ar: "العروض", fr: "Promotions" },
  { en: "Create promotion", ar: "إنشاء عرض", fr: "Créer une promotion" },
  { en: "Promotion created", ar: "تم إنشاء العرض", fr: "Promotion créée" },
  { en: "Deactivate", ar: "إلغاء التنشيط", fr: "Désactiver" },
  { en: "Active", ar: "نشط", fr: "Actif" },
  { en: "Inactive", ar: "غير نشط", fr: "Inactif" },
  {
    en: "No promotions yet. Active promotions apply automatically to matching lines.",
    ar: "لا توجد عروض بعد. تُطبَّق العروض النشطة تلقائيًا على الأسطر المطابقة.",
    fr: "Aucune promotion. Les promotions actives s'appliquent automatiquement.",
  },
  { en: "Sales & customer history", ar: "سجل المبيعات والعملاء", fr: "Historique des ventes et clients" },
  { en: "Customer", ar: "العميل", fr: "Client" },
  {
    en: "Search customer by name, phone or code",
    ar: "ابحث عن عميل بالاسم أو الهاتف أو الرمز",
    fr: "Rechercher un client par nom, téléphone ou code",
  },
  { en: "Clear", ar: "مسح", fr: "Effacer" },
  { en: "Purchases", ar: "المشتريات", fr: "Achats" },
  { en: "Total spent", ar: "إجمالي الإنفاق", fr: "Total dépensé" },
  { en: "Refunded", ar: "المبلغ المسترد", fr: "Remboursé" },
  { en: "Last purchase", ar: "آخر عملية شراء", fr: "Dernier achat" },
  { en: "Returns", ar: "المرتجعات", fr: "Retours" },
  { en: "Exchanges", ar: "الاستبدالات", fr: "Échanges" },
  { en: "Find a sale", ar: "البحث عن عملية بيع", fr: "Rechercher une vente" },
  { en: "Receipt #", ar: "رقم الإيصال", fr: "N° de reçu" },
  { en: "Item / name / SKU", ar: "الصنف / الاسم / SKU", fr: "Article / nom / SKU" },
  { en: "All locations", ar: "كل المواقع", fr: "Tous les emplacements" },
  { en: "Search", ar: "بحث", fr: "Rechercher" },
  {
    en: "No sales match those filters.",
    ar: "لا توجد مبيعات مطابقة لهذه المعايير.",
    fr: "Aucune vente ne correspond à ces filtres.",
  },
  {
    en: "Shelf prices already include tax (tax is carved out of the total instead of added on top)",
    ar: "أسعار الرف تشمل الضريبة (تُستخرج من الإجمالي بدلًا من إضافتها)",
    fr: "Les prix incluent déjà la taxe (extraite du total au lieu d'être ajoutée)",
  },
  {
    en: "Above this, a manager must approve the discount.",
    ar: "فوق هذا الحد، يجب أن يوافق المدير على الحسم.",
    fr: "Au-delà, un responsable doit approuver la remise.",
  },
  {
    en: "Leave uncounted lines untouched",
    ar: "اترك السطور غير المعدودة دون تغيير",
    fr: "Laisser les lignes non comptées inchangées",
  },
  { en: "Confirm variance lines", ar: "تأكيد سطور الفرق", fr: "Confirmer les lignes d'écart" },
  { en: "Tax / VAT", ar: "الضريبة / ضريبة القيمة المضافة", fr: "Taxe / TVA" },
  { en: "Item", ar: "الصنف", fr: "Article" },
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
