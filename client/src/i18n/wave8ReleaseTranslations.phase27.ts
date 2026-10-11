import type { Phase3SharedUiEntry } from "./sharedUiPhase3TranslationTypes";

// Accounting audit phase 27 (reporting pages and exports) and the phases 23–29 integration
// (allocation enablement, realized FX history, G17 parent freight, phase 29 Reverse action).
export const wave8ReleaseTranslationsPhase27: readonly Phase3SharedUiEntry[] = [
  {
    en: "Aging",
    ar: "أعمار الذمم",
    fr: "Balance âgée",
  },
  {
    en: "Ratios",
    ar: "النسب",
    fr: "Ratios",
  },
  {
    en: "Consolidation",
    ar: "التوحيد",
    fr: "Consolidation",
  },
  {
    en: "Party",
    ar: "الطرف",
    fr: "Tiers",
  },
  {
    en: "Current assets",
    ar: "الأصول المتداولة",
    fr: "Actifs courants",
  },
  {
    en: "Non-current assets",
    ar: "الأصول غير المتداولة",
    fr: "Actifs non courants",
  },
  {
    en: "Current liabilities",
    ar: "الخصوم المتداولة",
    fr: "Passifs courants",
  },
  {
    en: "Non-current liabilities",
    ar: "الخصوم غير المتداولة",
    fr: "Passifs non courants",
  },
  {
    en: "Unclassified",
    ar: "غير مصنف",
    fr: "Non classé",
  },
  {
    en: "Operating activities",
    ar: "الأنشطة التشغيلية",
    fr: "Activités opérationnelles",
  },
  {
    en: "Investing activities",
    ar: "الأنشطة الاستثمارية",
    fr: "Activités d’investissement",
  },
  {
    en: "Financing activities",
    ar: "الأنشطة التمويلية",
    fr: "Activités de financement",
  },
  {
    en: "Cash and bank accounts",
    ar: "حسابات النقد والبنوك",
    fr: "Comptes de caisse et de banque",
  },
  {
    en: "Indirect method. Cash is the bank accounts and the Cash/Bank ledger accounts.",
    ar: "الطريقة غير المباشرة. النقد هو الحسابات البنكية وحسابات الأستاذ من نوع نقد/بنك.",
    fr: "Méthode indirecte. La trésorerie comprend les comptes bancaires et les comptes du grand livre de type Caisse/Banque.",
  },
  {
    en: "Eliminations",
    ar: "الاستبعادات",
    fr: "Éliminations",
  },
  {
    en: "Choose a start date on or before the end date",
    ar: "اختر تاريخ بداية في تاريخ النهاية أو قبله",
    fr: "Choisissez une date de début antérieure ou égale à la date de fin",
  },
  {
    en: "Underlying figures",
    ar: "الأرقام الأساسية",
    fr: "Chiffres sous-jacents",
  },
  {
    en: "Comparative",
    ar: "المقارنة",
    fr: "Comparatif",
  },
  {
    en: "No comparative",
    ar: "بدون مقارنة",
    fr: "Sans comparatif",
  },
  {
    en: "Prior period",
    ar: "الفترة السابقة",
    fr: "Période précédente",
  },
  {
    en: "Same period last year",
    ar: "نفس الفترة من العام الماضي",
    fr: "Même période l’an dernier",
  },
  {
    en: "Opening Dr",
    ar: "مدين افتتاحي",
    fr: "Débit d’ouverture",
  },
  {
    en: "Opening Cr",
    ar: "دائن افتتاحي",
    fr: "Crédit d’ouverture",
  },
  {
    en: "Period Dr",
    ar: "مدين الفترة",
    fr: "Débit de la période",
  },
  {
    en: "Period Cr",
    ar: "دائن الفترة",
    fr: "Crédit de la période",
  },
  {
    en: "Closing Dr",
    ar: "مدين ختامي",
    fr: "Débit de clôture",
  },
  {
    en: "Closing Cr",
    ar: "دائن ختامي",
    fr: "Crédit de clôture",
  },
  {
    en: "Comparative Dr",
    ar: "مدين المقارنة",
    fr: "Débit comparatif",
  },
  {
    en: "Comparative Cr",
    ar: "دائن المقارنة",
    fr: "Crédit comparatif",
  },
  {
    en: "Line",
    ar: "السطر",
    fr: "Ligne",
  },
  {
    en: "No lines",
    ar: "لا توجد أسطر",
    fr: "Aucune ligne",
  },
  {
    en: "The report could not be loaded",
    ar: "تعذر تحميل التقرير",
    fr: "Le rapport n’a pas pu être chargé",
  },
  {
    en: "Other Income",
    ar: "إيرادات أخرى",
    fr: "Autres produits",
  },
  {
    en: "${line.name} (${line.accountType ?? line.kind})",
    ar: "{{0}} ({{1}})",
    fr: "{{0}} ({{1}})",
  },
  {
    en: "Unexplained Difference",
    ar: "فرق غير مفسر",
    fr: "Écart inexpliqué",
  },
  {
    en: "Cash at Start",
    ar: "النقد في البداية",
    fr: "Trésorerie au début",
  },
  {
    en: "Operating Activities",
    ar: "الأنشطة التشغيلية",
    fr: "Activités opérationnelles",
  },
  {
    en: "Investing Activities",
    ar: "الأنشطة الاستثمارية",
    fr: "Activités d’investissement",
  },
  {
    en: "Financing Activities",
    ar: "الأنشطة التمويلية",
    fr: "Activités de financement",
  },
  {
    en: "Net Change in Cash",
    ar: "صافي التغير في النقد",
    fr: "Variation nette de la trésorerie",
  },
  {
    en: "Cash at End",
    ar: "النقد في النهاية",
    fr: "Trésorerie à la fin",
  },
  {
    en: "Ledger: ${account.name}",
    ar: "الأستاذ: {{0}}",
    fr: "Grand livre : {{0}}",
  },
  {
    en: "Each action needs a bale id and assign, writeOff or accept",
    ar: "يحتاج كل إجراء إلى رقم بالة و assign أو writeOff أو accept",
    fr: "Chaque action nécessite un identifiant de balle et assign, writeOff ou accept",
  },
  {
    en: "Invalid mix",
    ar: "خلطة غير صالحة",
    fr: "Mélange invalide",
  },
  {
    en: "unmatched must be writeOff or accept",
    ar: "يجب أن تكون قيمة unmatched إما writeOff أو accept",
    fr: "unmatched doit valoir writeOff ou accept",
  },
  {
    en: 'families must be among ${LEGACY_POSTING_FAMILIES.join(", ")}',
    ar: "يجب أن تكون families من بين {{0}}",
    fr: "families doit faire partie de {{0}}",
  },
  {
    en: "startDate is after endDate",
    ar: "تاريخ البداية بعد تاريخ النهاية",
    fr: "La date de début est postérieure à la date de fin",
  },
  {
    en: "The first allocation run of a company is the Owner's, after reviewing its preview.",
    ar: "أول تشغيل لتخصيص البنود المفتوحة لشركة يقوم به المالك بعد مراجعة المعاينة.",
    fr: "La première affectation d’une société est effectuée par le propriétaire, après examen de son aperçu.",
  },
  {
    en: "The allocation plan changed. Review the preview again.",
    ar: "تغيرت خطة التخصيص. راجع المعاينة مرة أخرى.",
    fr: "Le plan d’affectation a changé. Examinez à nouveau l’aperçu.",
  },
  {
    en: "Unknown report",
    ar: "تقرير غير معروف",
    fr: "Rapport inconnu",
  },
  {
    en: "format must be xlsx or pdf",
    ar: "يجب أن تكون الصيغة xlsx أو pdf",
    fr: "Le format doit être xlsx ou pdf",
  },
  {
    en: "The allocation enablement was not recorded",
    ar: "لم يتم تسجيل تفعيل التخصيص",
    fr: "L’activation de l’affectation n’a pas été enregistrée",
  },
  {
    en: "Supplier-partner equity included in the net position",
    ar: "حقوق ملكية المورد الشريك المضمنة في صافي المركز",
    fr: "Capitaux propres du fournisseur partenaire inclus dans la position nette",
  },
  {
    en: "Aging (${report.kind})",
    ar: "أعمار الذمم ({{0}})",
    fr: "Balance âgée ({{0}})",
  },
  {
    en: "Financial Ratios",
    ar: "النسب المالية",
    fr: "Ratios financiers",
  },
  {
    en: "Ratio",
    ar: "النسبة",
    fr: "Ratio",
  },
  {
    en: "Cash Flow Statement",
    ar: "قائمة التدفقات النقدية",
    fr: "Tableau des flux de trésorerie",
  },
  {
    en: "Duties for container ${container.containerNumber} (accrued)",
    ar: "رسوم جمركية للحاوية {{0}} (مستحقة)",
    fr: "Droits de douane du conteneur {{0}} (à payer)",
  },
  {
    en: "Office charges for container ${container.containerNumber} (accrued)",
    ar: "رسوم المكتب للحاوية {{0}} (مستحقة)",
    fr: "Frais de bureau du conteneur {{0}} (à payer)",
  },
  {
    en: '${voucher?.description ?? item.reference} (re-posted with its ${kind === "OC" ? "charge" : "freight"} expense account)',
    ar: "{{0}} (أعيد ترحيله على حساب مصروف {{1}} الخاص به)",
    fr: "{{0}} (recomptabilisé sur son compte de charges {{1}})",
  },
  {
    en: "Goods import - container ${item.reference} (reviewed back-fill)",
    ar: "استيراد بضائع - الحاوية {{0}} (استكمال تمت مراجعته)",
    fr: "Importation de marchandises - conteneur {{0}} (rattrapage examiné)",
  },
  {
    en: "Factory opening receivable at the cut-over ${plan.effectiveFrom} (${total.invoices} invoices)",
    ar: "ذمم المصنع الافتتاحية عند الانتقال {{0}} ({{1}} فواتير)",
    fr: "Créances d’ouverture de l’usine à la bascule {{0}} ({{1}} factures)",
  },
  {
    en: "Parent freight - ${created.poNumber}${containerSuffix}",
    ar: "شحن الشركة الأم - {{0}}{{1}}",
    fr: "Fret de la société mère - {{0}}{{1}}",
  },
  {
    en: "The realized exchange difference plan changed. Review it again.",
    ar: "تغيرت خطة فروق الصرف المحققة. راجعها مرة أخرى.",
    fr: "Le plan des écarts de change réalisés a changé. Examinez-le à nouveau.",
  },
  {
    en: "There is no realized exchange difference to post.",
    ar: "لا توجد فروق صرف محققة للترحيل.",
    fr: "Il n’y a aucun écart de change réalisé à comptabiliser.",
  },
];
