import type { Phase3SharedUiEntry } from "./sharedUiPhase3TranslationTypes";

// Wave 8 release closeout, continued from part 2 (which reached the 900-line limit).
export const wave8ReleaseTranslationsPart3: readonly Phase3SharedUiEntry[] = [
  {
    en: "One or more selected companies could not be found",
    ar: "تعذر العثور على شركة أو أكثر من الشركات المحددة",
    fr: "Une ou plusieurs des sociétés sélectionnées sont introuvables",
  },
  {
    en: "Item Market Analysis can only compare ERP companies",
    ar: "لا يمكن لتحليل سوق الأصناف مقارنة سوى شركات ERP",
    fr: "L’analyse du marché des articles ne peut comparer que des sociétés ERP",
  },
  {
    en: "Load 250 more",
    ar: "تحميل 250 إضافية",
    fr: "Charger 250 de plus",
  },
  {
    en: "All Profit",
    ar: "كل الأرباح",
    fr: "Tous les bénéfices",
  },
  {
    en: "COGS Reconciliation",
    ar: "تسوية تكلفة البضاعة المباعة",
    fr: "Rapprochement du coût des ventes",
  },
  {
    en: "Adjusted Cost Profit",
    ar: "الربح بالتكلفة المعدّلة",
    fr: "Bénéfice au coût ajusté",
  },
  {
    en: "Freight + Charges: Included",
    ar: "الشحن + الرسوم: مشمولة",
    fr: "Fret + frais : inclus",
  },
  {
    en: "Freight + Charges: Excluded",
    ar: "الشحن + الرسوم: مستبعدة",
    fr: "Fret + frais : exclus",
  },
  {
    en: "Invoice Total (With Charges)",
    ar: "إجمالي الفاتورة (مع الرسوم)",
    fr: "Total de la facture (avec frais)",
  },
  {
    en: "Total Cost (With Charges)",
    ar: "إجمالي التكلفة (مع الرسوم)",
    fr: "Coût total (avec frais)",
  },
  {
    en: "Expand a customer to see each loading, verified or finalized invoice. Totals below include freight and extra charges.",
    ar: "وسّع العميل لعرض كل عملية تحميل أو فاتورة متحقق منها أو معتمدة. الإجماليات أدناه تشمل الشحن والرسوم الإضافية.",
    fr: "Développez un client pour voir chaque chargement ou facture vérifiée ou finalisée. Les totaux ci-dessous incluent le fret et les frais supplémentaires.",
  },
  {
    en: "Expand a customer to see each loading, verified or finalized invoice. Totals below exclude freight and extra charges.",
    ar: "وسّع العميل لعرض كل عملية تحميل أو فاتورة متحقق منها أو معتمدة. الإجماليات أدناه تستثني الشحن والرسوم الإضافية.",
    fr: "Développez un client pour voir chaque chargement ou facture vérifiée ou finalisée. Les totaux ci-dessous excluent le fret et les frais supplémentaires.",
  },
  {
    en: "Invalid includeCharges filter",
    ar: "عامل تصفية includeCharges غير صالح",
    fr: "Filtre includeCharges non valide",
  },
  {
    en: "Invalid payroll salary amounts",
    ar: "مبالغ رواتب غير صالحة في كشف الرواتب",
    fr: "Montants de salaire de paie non valides",
  },
  {
    en: "Commission amount must be a number",
    ar: "يجب أن يكون مبلغ العمولة رقماً",
    fr: "Le montant de la commission doit être un nombre",
  },
  {
    en: "Commission FX rate must be a number",
    ar: "يجب أن يكون سعر صرف العمولة رقماً",
    fr: "Le taux de change de la commission doit être un nombre",
  },
  {
    en: "Not changed. Investigate the difference and post a correcting entry.",
    ar: "لم يتم التغيير. تحقق من الفرق وسجّل قيداً تصحيحياً.",
    fr: "Non modifié. Analysez l’écart et passez une écriture de correction.",
  },
  {
    en: "No balances were changed",
    ar: "لم يتم تغيير أي أرصدة",
    fr: "Aucun solde n’a été modifié",
  },
  {
    en: "Equity adjustments are no longer written. The difference is reported as it is; investigate it and post a correcting entry.",
    ar: "لم تعد تسويات حقوق الملكية تُسجَّل. يُعرض الفرق كما هو؛ تحقق منه وسجّل قيداً تصحيحياً.",
    fr: "Les ajustements de capitaux propres ne sont plus enregistrés. L’écart est présenté tel quel ; analysez-le et passez une écriture de correction.",
  },
  {
    en: "This checks each company's Import Cycle difference and shows what a balancing entry would need. No balances are changed: a difference is corrected with a reviewed, posted entry.",
    ar: "يتحقق هذا من فرق دورة الاستيراد لكل شركة ويعرض ما يتطلبه قيد الموازنة. لا يتم تغيير أي أرصدة: يُصحَّح الفرق بقيد مُراجع ومُرحَّل.",
    fr: "Ceci vérifie l’écart du cycle d’importation de chaque société et indique ce qu’exigerait une écriture d’équilibrage. Aucun solde n’est modifié : un écart se corrige par une écriture revue et comptabilisée.",
  },
  {
    en: "Check All Companies",
    ar: "التحقق من جميع الشركات",
    fr: "Vérifier toutes les sociétés",
  },
  {
    en: "Checking...",
    ar: "جارٍ التحقق...",
    fr: "Vérification...",
  },
  {
    en: "Only ledger account entries can be moved",
    ar: "يمكن نقل قيود حسابات الأستاذ فقط",
    fr: "Seules les écritures de comptes du grand livre peuvent être déplacées",
  },
  {
    en: "A legacy line changed during the repair; nothing was applied",
    ar: "تغيّر سطر قديم أثناء الإصلاح؛ لم يُطبَّق أي شيء",
    fr: "Une ligne historique a changé pendant la réparation ; rien n'a été appliqué",
  },
  {
    en: "A required system account is not available",
    ar: "حساب نظام مطلوب غير متاح",
    fr: "Un compte système requis n'est pas disponible",
  },
  {
    en: "Perpetual inventory posting is not complete yet; the cut-over cannot be applied",
    ar: "ترحيل المخزون الدائم لم يكتمل بعد؛ لا يمكن تطبيق التحويل",
    fr: "La comptabilisation de l'inventaire permanent n'est pas encore terminée ; la bascule ne peut pas être appliquée",
  },
  {
    en: "The cut-over can be applied on or after its date",
    ar: "يمكن تطبيق التحويل في تاريخه أو بعده",
    fr: "La bascule peut être appliquée à sa date ou après",
  },
  {
    en: "The cut-over is already applied for this company",
    ar: "تم تطبيق التحويل بالفعل لهذه الشركة",
    fr: "La bascule est déjà appliquée pour cette société",
  },
  {
    en: "Unknown system account code",
    ar: "رمز حساب نظام غير معروف",
    fr: "Code de compte système inconnu",
  },
  {
    en: "Confirmation is required",
    ar: "التأكيد مطلوب",
    fr: "Une confirmation est requise",
  },
];
