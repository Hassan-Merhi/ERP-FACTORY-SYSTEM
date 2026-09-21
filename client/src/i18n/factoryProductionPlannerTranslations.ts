import type { ApplicationLanguage } from "@shared/applicationLanguageContract";

type Translation = Record<ApplicationLanguage, string>;

const translations: Record<string, Translation> = {
  "Search worker…": { en: "Search worker…", ar: "ابحث عن عامل…", fr: "Rechercher un ouvrier…" },
  "e.g. short shift, holiday schedule…": {
    en: "e.g. short shift, holiday schedule…",
    ar: "مثال: وردية قصيرة، جدول عطلة…",
    fr: "ex. : courte équipe, horaire de vacances…",
  },
  "Filter workers by team": {
    en: "Filter workers by team",
    ar: "تصفية العمال حسب الفريق",
    fr: "Filtrer les ouvriers par équipe",
  },
  "All workers": { en: "All workers", ar: "كل العمال", fr: "Tous les ouvriers" },
  "No workers found.": { en: "No workers found.", ar: "لم يتم العثور على عمال.", fr: "Aucun ouvrier trouvé." },
  "Total Target:": { en: "Total Target:", ar: "إجمالي المستهدف:", fr: "Objectif total :" },
  "Total Actual:": { en: "Total Actual:", ar: "إجمالي الفعلي:", fr: "Total réalisé :" },
  "Loading plan…": { en: "Loading plan…", ar: "جارٍ تحميل الخطة…", fr: "Chargement du plan…" },
  Worker: { en: "Worker", ar: "عامل", fr: "Ouvrier" },
  Role: { en: "Role", ar: "الدور", fr: "Rôle" },
  Actual: { en: "Actual", ar: "الفعلي", fr: "Réalisé" },
  Used: { en: "Used", ar: "مستخدم", fr: "Utilisé" },
  "Target Met": { en: "Target Met", ar: "تم تحقيق المستهدف", fr: "Objectif atteint" },
  "No workers in plan. Add workers below or copy from a previous plan.": {
    en: "No workers in plan. Add workers below or copy from a previous plan.",
    ar: "لا يوجد عمال في الخطة. أضف عمالًا أدناه أو انسخ من خطة سابقة.",
    fr: "Aucun ouvrier dans le plan. Ajoutez-en ou copiez un plan précédent.",
  },
  "Plan saved": { en: "Plan saved", ar: "تم حفظ الخطة", fr: "Plan enregistré" },
  "Could not save plan": { en: "Could not save plan", ar: "تعذر حفظ الخطة", fr: "Impossible d’enregistrer le plan" },
  "No previous plan found": {
    en: "No previous plan found",
    ar: "لم يتم العثور على خطة سابقة",
    fr: "Aucun plan précédent trouvé",
  },
  "End Production is only available for a single daily production date": {
    en: "End Production is only available for a single daily production date",
    ar: "إنهاء الإنتاج متاح فقط لتاريخ إنتاج يومي واحد",
    fr: "La fin de production n’est disponible que pour une seule date de production quotidienne",
  },
  "Production has already ended for this day and is locked": {
    en: "Production has already ended for this day and is locked",
    ar: "انتهى الإنتاج بالفعل لهذا اليوم وتم قفله",
    fr: "La production est déjà terminée pour cette journée et est verrouillée",
  },
  "Production Targets only supports factory workers": {
    en: "Production Targets only supports factory workers",
    ar: "أهداف الإنتاج تدعم عمال المصنع فقط",
    fr: "Les objectifs de production prennent uniquement en charge les ouvriers de l’usine",
  },
  "Worker is not assigned to a saved Production Planner group": {
    en: "Worker is not assigned to a saved Production Planner group",
    ar: "العامل غير معيّن إلى مجموعة محفوظة في مخطط الإنتاج",
    fr: "L’ouvrier n’est affecté à aucun groupe enregistré du planificateur de production",
  },
  "Copied plan from ${data.fromDate}": {
    en: "Copied plan from ${data.fromDate}",
    ar: "تم نسخ الخطة من ${data.fromDate}",
    fr: "Plan copié depuis le ${data.fromDate}",
  },
  "Container Planner could not load the complete stock list.": {
    en: "Container Planner could not load the complete stock list.",
    ar: "تعذر على مخطط الحاويات تحميل قائمة المخزون الكاملة.",
    fr: "Le planificateur de conteneurs n’a pas pu charger la liste complète du stock.",
  },
  "Container Planner": {
    en: "Container Planner",
    ar: "مخطط الحاويات",
    fr: "Planificateur de conteneurs",
  },
  "Target capacity (bales)": {
    en: "Target capacity (bales)",
    ar: "السعة المستهدفة (بالات)",
    fr: "Capacité cible (balles)",
  },
  "Physical stock": {
    en: "Physical stock",
    ar: "المخزون الفعلي",
    fr: "Stock physique",
  },
  "Customer committed": {
    en: "Customer committed",
    ar: "محجوز للعملاء",
    fr: "Engagé pour les clients",
  },
  "Already loading": {
    en: "Already loading",
    ar: "قيد التحميل بالفعل",
    fr: "Déjà en chargement",
  },
  "Available to plan": {
    en: "Available to plan",
    ar: "متاح للتخطيط",
    fr: "Disponible à planifier",
  },
  "Planned containers": {
    en: "Planned containers",
    ar: "الحاويات المخططة",
    fr: "Conteneurs planifiés",
  },
  "Average / container": {
    en: "Average / container",
    ar: "المتوسط / حاوية",
    fr: "Moyenne / conteneur",
  },
  "There is no positive uncommitted stock to distribute right now.": {
    en: "There is no positive uncommitted stock to distribute right now.",
    ar: "لا يوجد حالياً مخزون موجب غير محجوز لتوزيعه.",
    fr: "Il n’y a actuellement aucun stock positif non engagé à répartir.",
  },
  "Balanced container totals": {
    en: "Balanced container totals",
    ar: "إجماليات الحاويات المتوازنة",
    fr: "Totaux équilibrés des conteneurs",
  },
  "Free stock": {
    en: "Free stock",
    ar: "المخزون الحر",
    fr: "Stock libre",
  },
  "Container ${index + 1}": {
    en: "Container ${index + 1}",
    ar: "الحاوية ${index + 1}",
    fr: "Conteneur ${index + 1}",
  },
};

export function translateFactoryProductionPlannerText(value: string, language: ApplicationLanguage): string | null {
  if (value.startsWith("Copied plan from ")) {
    const date = value.slice("Copied plan from ".length);
    const translated = translations["Copied plan from ${data.fromDate}"][language];
    return translated.replace("${data.fromDate}", date);
  }

  const containerMatch = value.match(/^Container (\d+)$/);
  if (containerMatch) {
    const translated = translations["Container ${index + 1}"][language];
    return translated.replace("${index + 1}", containerMatch[1]);
  }

  return translations[value]?.[language] ?? null;
}
