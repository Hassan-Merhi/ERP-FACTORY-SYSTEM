import type { ApplicationLanguage } from "@shared/applicationLanguageContract";
import type { Phase3SharedUiEntry } from "./sharedUiPhase3TranslationTypes";

const payrollUiTranslations: readonly Phase3SharedUiEntry[] = [
  { en: "Selected", ar: "المحدد", fr: "Sélectionné" },
  {
    en: "Search workers by name, code, or department...",
    ar: "ابحث عن العمال بالاسم أو الرمز أو القسم...",
    fr: "Rechercher des ouvriers par nom, code ou service...",
  },
  { en: "Total workers", ar: "إجمالي العمال", fr: "Total des ouvriers" },
  { en: "Active workers", ar: "العمال النشطون", fr: "Ouvriers actifs" },
  { en: "Selected to pay", ar: "المحددون للدفع", fr: "Sélectionnés pour paiement" },
  {
    en: "Review individual pay amounts below before processing.",
    ar: "راجع مبالغ الدفع الفردية أدناه قبل المعالجة.",
    fr: "Vérifiez les montants de paiement individuels ci-dessous avant le traitement.",
  },
  { en: "No workers yet", ar: "لا يوجد عمال بعد", fr: "Aucun ouvrier pour le moment" },
  { en: "No matching workers", ar: "لا يوجد عمال مطابقون", fr: "Aucun ouvrier correspondant" },
  {
    en: "Try another search or status filter.",
    ar: "جرّب بحثًا أو عامل تصفية حالة آخر.",
    fr: "Essayez une autre recherche ou un autre filtre d’état.",
  },
  {
    en: "Workers that are not assigned to a worker group.",
    ar: "العمال غير المعينين إلى مجموعة عمال.",
    fr: "Ouvriers qui ne sont affectés à aucun groupe d’ouvriers.",
  },
  {
    en: "Workers are separate from Employees. Add a Worker here to manage worker payroll and deductions.",
    ar: "العمال منفصلون عن الموظفين. أضف عاملًا هنا لإدارة رواتب العمال والاستقطاعات.",
    fr: "Les ouvriers sont distincts des employés. Ajoutez un ouvrier ici pour gérer sa paie et ses retenues.",
  },
  { en: "Assign group", ar: "تعيين مجموعة", fr: "Affecter un groupe" },
  { en: "Edit worker", ar: "تعديل العامل", fr: "Modifier l’ouvrier" },
  {
    en: "Use Assign group beside this row on desktop",
    ar: "استخدم تعيين مجموعة بجانب هذا الصف على سطح المكتب",
    fr: "Utilisez Affecter un groupe à côté de cette ligne sur ordinateur",
  },
  { en: "Pay amount", ar: "مبلغ الدفع", fr: "Montant à payer" },
  {
    en: "Amount used for this payment run",
    ar: "المبلغ المستخدم لعملية الدفع هذه",
    fr: "Montant utilisé pour cette opération de paiement",
  },
  { en: "Worker group not found", ar: "لم يتم العثور على مجموعة العمال", fr: "Groupe d’ouvriers introuvable" },
  {
    en: "Worker group not found or access denied",
    ar: "لم يتم العثور على مجموعة العمال أو تم رفض الوصول",
    fr: "Groupe d’ouvriers introuvable ou accès refusé",
  },
  {
    en: "Only Worker records can be added to worker groups",
    ar: "يمكن إضافة سجلات العمال فقط إلى مجموعات العمال",
    fr: "Seuls les enregistrements de type Ouvrier peuvent être ajoutés aux groupes d’ouvriers",
  },
];

const exactTranslations = new Map(payrollUiTranslations.map((entry) => [entry.en, entry] as const));

export function isPayrollUiText(value: string): boolean {
  return exactTranslations.has(value.trim());
}

export function translatePayrollUiText(value: string, language: ApplicationLanguage): string | null {
  const leading = value.match(/^\s*/)?.[0] ?? "";
  const trailing = value.match(/\s*$/)?.[0] ?? "";
  const entry = exactTranslations.get(value.trim());
  return entry ? `${leading}${entry[language]}${trailing}` : null;
}
