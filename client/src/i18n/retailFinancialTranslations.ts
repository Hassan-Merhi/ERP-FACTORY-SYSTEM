import type { ApplicationLanguage } from "@shared/applicationLanguageContract";
import { createPhase3TemplateTranslator } from "./phase3TemplateTranslationRuntime";
import type { Phase3SharedUiEntry } from "./sharedUiPhase3TranslationTypes";

/** Retail Wave 1 payments, cashier shifts and accounting copy. */
export const retailFinancialTranslations: readonly Phase3SharedUiEntry[] = [
  {
    en: "Open a cashier shift before completing this sale.",
    ar: "افتح وردية أمين الصندوق قبل إتمام هذا البيع.",
    fr: "Ouvrez une session de caisse avant de finaliser cette vente.",
  },
  {
    en: "Open a cashier shift before completing a sale",
    ar: "افتح وردية أمين الصندوق قبل إتمام أي بيع",
    fr: "Ouvrez une session de caisse avant de finaliser une vente",
  },
  {
    en: "Payments must equal the sale total",
    ar: "يجب أن تساوي الدفعات إجمالي البيع",
    fr: "Les paiements doivent être égaux au total de la vente",
  },
  {
    en: "Cash tendered cannot be less than the cash payment",
    ar: "لا يمكن أن يكون النقد المقدم أقل من الدفعة النقدية",
    fr: "Les espèces remises ne peuvent pas être inférieures au paiement en espèces",
  },
  { en: "Remove payment", ar: "إزالة الدفعة", fr: "Supprimer le paiement" },
  {
    en: "Cash, card, bank, mobile, other or split payment.",
    ar: "نقدًا أو بطاقة أو تحويل بنكي أو محفظة جوال أو طريقة أخرى أو دفع مقسم.",
    fr: "Espèces, carte, banque, mobile, autre ou paiement fractionné.",
  },
  { en: "Split", ar: "تقسيم", fr: "Fractionner" },
  { en: "Tendered", ar: "المبلغ المقدم", fr: "Remis" },
  { en: "Due", ar: "المستحق", fr: "Dû" },
  { en: "Card", ar: "بطاقة", fr: "Carte" },
  { en: "Bank / Transfer", ar: "بنك / تحويل", fr: "Banque / Virement" },
  { en: "Cash in/out reason", ar: "سبب الإيداع/السحب النقدي", fr: "Motif de l’entrée/sortie d’espèces" },
  { en: "Cashier shift", ar: "وردية أمين الصندوق", fr: "Session de caisse" },
  { en: "Opening cash", ar: "النقد الافتتاحي", fr: "Fonds de caisse d’ouverture" },
  { en: "Open shift", ar: "فتح الوردية", fr: "Ouvrir la session" },
  { en: "Cash sales", ar: "المبيعات النقدية", fr: "Ventes en espèces" },
  { en: "Cash refunds", ar: "المبالغ المستردة نقدًا", fr: "Remboursements en espèces" },
  { en: "Expected cash", ar: "النقد المتوقع", fr: "Espèces attendues" },
  { en: "Cash In", ar: "إيداع نقدي", fr: "Entrée d’espèces" },
  { en: "Cash Out", ar: "سحب نقدي", fr: "Sortie d’espèces" },
  { en: "Actual closing cash", ar: "النقد الفعلي عند الإغلاق", fr: "Espèces réelles à la clôture" },
  { en: "Close shift", ar: "إغلاق الوردية", fr: "Clôturer la session" },
  { en: "Recent shifts", ar: "الورديات الأخيرة", fr: "Sessions récentes" },
  { en: "Cashier shift opened", ar: "تم فتح وردية أمين الصندوق", fr: "Session de caisse ouverte" },
  { en: "Could not open shift", ar: "تعذر فتح الوردية", fr: "Impossible d’ouvrir la session" },
  { en: "Cash drawer movement recorded", ar: "تم تسجيل حركة درج النقد", fr: "Mouvement du tiroir-caisse enregistré" },
  { en: "Cash movement failed", ar: "فشلت الحركة النقدية", fr: "Échec du mouvement d’espèces" },
  { en: "Cashier shift closed", ar: "تم إغلاق وردية أمين الصندوق", fr: "Session de caisse clôturée" },
  { en: "Could not close shift", ar: "تعذر إغلاق الوردية", fr: "Impossible de clôturer la session" },
  { en: "Open a shift first", ar: "افتح وردية أولًا", fr: "Ouvrez d’abord une session" },
  { en: "Enter an amount and reason", ar: "أدخل مبلغًا وسببًا", fr: "Saisissez un montant et un motif" },
  { en: "No open shift", ar: "لا توجد وردية مفتوحة", fr: "Aucune session ouverte" },
  { en: "Retail accounting mapping", ar: "ربط حسابات التجزئة", fr: "Correspondance comptable du détail" },
  { en: "Scope", ar: "النطاق", fr: "Portée" },
  { en: "Company default", ar: "الافتراضي للشركة", fr: "Valeur par défaut de la société" },
  { en: "Bank account (optional)", ar: "الحساب البنكي (اختياري)", fr: "Compte bancaire (facultatif)" },
  {
    en: "Use bank clearing ledger",
    ar: "استخدام حساب المقاصة البنكية",
    fr: "Utiliser le compte de compensation bancaire",
  },
  {
    en: "Loading accounting mapping…",
    ar: "جارٍ تحميل ربط الحسابات…",
    fr: "Chargement de la correspondance comptable…",
  },
  { en: "Save mapping", ar: "حفظ الربط", fr: "Enregistrer la correspondance" },
  { en: "Retail financial reconciliation", ar: "التسوية المالية للتجزئة", fr: "Rapprochement financier du détail" },
  { en: "Sales checked", ar: "المبيعات المفحوصة", fr: "Ventes vérifiées" },
  { en: "Payment mismatches", ar: "فروقات الدفعات", fr: "Écarts de paiement" },
  { en: "Missing accounting", ar: "قيود محاسبية مفقودة", fr: "Comptabilisation manquante" },
  {
    en: "Retail sales, payments and accounting are reconciled.",
    ar: "مبيعات التجزئة والدفعات والقيود المحاسبية متطابقة.",
    fr: "Les ventes, paiements et écritures du détail sont rapprochés.",
  },
  { en: "Loading reconciliation…", ar: "جارٍ تحميل التسوية…", fr: "Chargement du rapprochement…" },
  {
    en: "Retail accounting settings saved",
    ar: "تم حفظ إعدادات محاسبة التجزئة",
    fr: "Paramètres comptables du détail enregistrés",
  },
  {
    en: "Could not save Retail accounting",
    ar: "تعذر حفظ محاسبة التجزئة",
    fr: "Impossible d’enregistrer la comptabilité du détail",
  },
  {
    en: "Retail accounting settings are not loaded",
    ar: "لم يتم تحميل إعدادات محاسبة التجزئة",
    fr: "Les paramètres comptables du détail ne sont pas chargés",
  },
  { en: "Invalid shift", ar: "وردية غير صالحة", fr: "Session invalide" },
  {
    en: "Cash movement idempotency key was reused with different data",
    ar: "أُعيد استخدام مفتاح عدم التكرار للحركة النقدية مع بيانات مختلفة",
    fr: "La clé d’idempotence du mouvement d’espèces a été réutilisée avec des données différentes",
  },
  {
    en: "One or more Retail ledger accounts belong to another company",
    ar: "حساب أو أكثر من حسابات دفتر التجزئة يتبع شركة أخرى",
    fr: "Un ou plusieurs comptes du grand livre du détail appartiennent à une autre société",
  },
  {
    en: "Retail bank account belongs to another company",
    ar: "الحساب البنكي للتجزئة يتبع شركة أخرى",
    fr: "Le compte bancaire du détail appartient à une autre société",
  },
  {
    en: "You can only access your own shift",
    ar: "يمكنك الوصول إلى ورديتك فقط",
    fr: "Vous ne pouvez accéder qu’à votre propre session",
  },
  { en: "Invalid reconciliation date", ar: "تاريخ تسوية غير صالح", fr: "Date de rapprochement invalide" },
  {
    en: "Cash movement retry could not be resolved",
    ar: "تعذر حل إعادة محاولة الحركة النقدية",
    fr: "Impossible de résoudre la nouvelle tentative du mouvement d’espèces",
  },
  {
    en: "Retail POS sale #${input.saleId}",
    ar: "بيع نقطة بيع التجزئة رقم {{0}}",
    fr: "Vente PDV de détail n° {{0}}",
  },
  {
    en: "Retail cancellation for sale #${input.saleId}",
    ar: "إلغاء تجزئة للبيع رقم {{0}}",
    fr: "Annulation de détail pour la vente n° {{0}}",
  },
  {
    en: "Retail return for sale #${input.saleId}",
    ar: "مرتجع تجزئة للبيع رقم {{0}}",
    fr: "Retour de détail pour la vente n° {{0}}",
  },
  {
    en: "Could not resolve Retail accounting account ${code}",
    ar: "تعذر تحديد حساب محاسبة التجزئة {{0}}",
    fr: "Impossible de résoudre le compte comptable du détail {{0}}",
  },
  {
    en: "Retail accounting settings could not be created",
    ar: "تعذر إنشاء إعدادات محاسبة التجزئة",
    fr: "Impossible de créer les paramètres comptables du détail",
  },
  {
    en: "Retail accounting settings could not be resolved",
    ar: "تعذر تحديد إعدادات محاسبة التجزئة",
    fr: "Impossible de résoudre les paramètres comptables du détail",
  },
  {
    en: "Retail cashier shift is not open for this location",
    ar: "وردية أمين صندوق التجزئة غير مفتوحة لهذا الموقع",
    fr: "La session de caisse du détail n’est pas ouverte pour cet emplacement",
  },
  {
    en: "Retail cashier shift belongs to another user",
    ar: "وردية أمين صندوق التجزئة تتبع مستخدمًا آخر",
    fr: "La session de caisse du détail appartient à un autre utilisateur",
  },
  {
    en: "Retail sale total cannot be negative",
    ar: "لا يمكن أن يكون إجمالي بيع التجزئة سالبًا",
    fr: "Le total de la vente au détail ne peut pas être négatif",
  },
  {
    en: "Unsupported Retail payment method: ${payment.method}",
    ar: "طريقة دفع تجزئة غير مدعومة: {{0}}",
    fr: "Mode de paiement du détail non pris en charge : {{0}}",
  },
  {
    en: "Every Retail payment amount must be positive",
    ar: "يجب أن يكون كل مبلغ دفع في التجزئة موجبًا",
    fr: "Chaque montant de paiement du détail doit être positif",
  },
  {
    en: "Cash tendered cannot be less than the cash payment amount",
    ar: "لا يمكن أن يكون النقد المقدم أقل من مبلغ الدفعة النقدية",
    fr: "Les espèces remises ne peuvent pas être inférieures au montant du paiement en espèces",
  },
  {
    en: "Retail payments (${sum.toFixed(2)}) must equal sale total (${total.toFixed(2)})",
    ar: "يجب أن تساوي دفعات التجزئة ({{0}}) إجمالي البيع ({{1}})",
    fr: "Les paiements du détail ({{0}}) doivent être égaux au total de la vente ({{1}})",
  },
  {
    en: "Retail payment could not be persisted",
    ar: "تعذر حفظ دفعة التجزئة",
    fr: "Impossible d’enregistrer le paiement du détail",
  },
  {
    en: "Original Retail sale does not have enough paid value to refund",
    ar: "لا يحتوي بيع التجزئة الأصلي على قيمة مدفوعة كافية للاسترداد",
    fr: "La vente au détail d’origine n’a pas assez de montant payé à rembourser",
  },
  {
    en: "Retail refund payment could not be persisted",
    ar: "تعذر حفظ دفعة استرداد التجزئة",
    fr: "Impossible d’enregistrer le remboursement du détail",
  },
  {
    en: "Refund exceeds the remaining paid amount by ${remaining.toFixed(2)}",
    ar: "يتجاوز الاسترداد المبلغ المدفوع المتبقي بمقدار {{0}}",
    fr: "Le remboursement dépasse le montant payé restant de {{0}}",
  },
];

const exactTranslations = new Map<string, Phase3SharedUiEntry>();
for (const entry of retailFinancialTranslations) {
  if (!entry.en.includes("${")) exactTranslations.set(entry.en, entry);
}

const templateTranslator = createPhase3TemplateTranslator(retailFinancialTranslations);

export function isRetailFinancialText(value: string): boolean {
  const normalized = value.trim();
  return exactTranslations.has(normalized) || templateTranslator.matches(normalized);
}

export function translateRetailFinancialText(value: string, language: ApplicationLanguage): string | null {
  const leading = value.match(/^\s*/)?.[0] ?? "";
  const trailing = value.match(/\s*$/)?.[0] ?? "";
  const normalized = value.trim();
  const exact = exactTranslations.get(normalized);
  if (exact) return `${leading}${exact[language]}${trailing}`;
  return templateTranslator.translate(value, language, (capture) => capture);
}
