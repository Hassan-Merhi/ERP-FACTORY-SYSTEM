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
  "Save this preview": {
    en: "Save this preview",
    ar: "حفظ هذه المعاينة",
    fr: "Enregistrer cet aperçu",
  },
  "Saving creates a planning draft only. Physical bales and customer loading remain untouched.": {
    en: "Saving creates a planning draft only. Physical bales and customer loading remain untouched.",
    ar: "الحفظ ينشئ مسودة تخطيط فقط. البالات الفعلية وتحميل العملاء لا يتغيران.",
    fr: "L’enregistrement crée uniquement un brouillon de planification. Les balles physiques et les chargements clients restent inchangés.",
  },
  "Optional plan name": {
    en: "Optional plan name",
    ar: "اسم الخطة اختياري",
    fr: "Nom du plan facultatif",
  },
  "Save Plan": { en: "Save Plan", ar: "حفظ الخطة", fr: "Enregistrer le plan" },
  "Saved container plans": {
    en: "Saved container plans",
    ar: "خطط الحاويات المحفوظة",
    fr: "Plans de conteneurs enregistrés",
  },
  "Edit quantities by moving bales between unlocked containers. Lock containers you do not want rebalanced.": {
    en: "Edit quantities by moving bales between unlocked containers. Lock containers you do not want rebalanced.",
    ar: "عدّل الكميات بنقل البالات بين الحاويات غير المقفلة. اقفل الحاويات التي لا تريد إعادة موازنتها.",
    fr: "Modifiez les quantités en déplaçant les balles entre les conteneurs déverrouillés. Verrouillez ceux qui ne doivent pas être rééquilibrés.",
  },
  "No saved container plans yet.": {
    en: "No saved container plans yet.",
    ar: "لا توجد خطط حاويات محفوظة بعد.",
    fr: "Aucun plan de conteneurs enregistré pour le moment.",
  },
  "Rebalance Unlocked": {
    en: "Rebalance Unlocked",
    ar: "إعادة موازنة غير المقفل",
    fr: "Rééquilibrer les déverrouillés",
  },
  Delete: { en: "Delete", ar: "حذف", fr: "Supprimer" },
  "Confirm Delete": { en: "Confirm Delete", ar: "تأكيد الحذف", fr: "Confirmer la suppression" },
  Cancel: { en: "Cancel", ar: "إلغاء", fr: "Annuler" },
  "Save Name": { en: "Save Name", ar: "حفظ الاسم", fr: "Enregistrer le nom" },
  "Locked · rebalance protected": {
    en: "Locked · rebalance protected",
    ar: "مقفل · محمي من إعادة الموازنة",
    fr: "Verrouillé · protégé du rééquilibrage",
  },
  Unlocked: { en: "Unlocked", ar: "غير مقفل", fr: "Déverrouillé" },
  "Move product": { en: "Move product", ar: "نقل المنتج", fr: "Déplacer le produit" },
  Quantity: { en: "Quantity", ar: "الكمية", fr: "Quantité" },
  Destination: { en: "Destination", ar: "الوجهة", fr: "Destination" },
  "No unlocked destination has space": {
    en: "No unlocked destination has space",
    ar: "لا توجد حاوية وجهة غير مقفلة بها مساحة",
    fr: "Aucun conteneur de destination déverrouillé n’a de place",
  },
  Move: { en: "Move", ar: "نقل", fr: "Déplacer" },
  "Plan already saved": {
    en: "Plan already saved",
    ar: "الخطة محفوظة بالفعل",
    fr: "Plan déjà enregistré",
  },
  "Container plan saved": {
    en: "Container plan saved",
    ar: "تم حفظ خطة الحاويات",
    fr: "Plan de conteneurs enregistré",
  },
  "Plan renamed": { en: "Plan renamed", ar: "تمت إعادة تسمية الخطة", fr: "Plan renommé" },
  "Container lock updated": {
    en: "Container lock updated",
    ar: "تم تحديث قفل الحاوية",
    fr: "Verrouillage du conteneur mis à jour",
  },
  "Bales moved": { en: "Bales moved", ar: "تم نقل البالات", fr: "Balles déplacées" },
  "Unlocked containers rebalanced": {
    en: "Unlocked containers rebalanced",
    ar: "تمت إعادة موازنة الحاويات غير المقفلة",
    fr: "Conteneurs déverrouillés rééquilibrés",
  },
  "Locked containers were left unchanged.": {
    en: "Locked containers were left unchanged.",
    ar: "لم يتم تغيير الحاويات المقفلة.",
    fr: "Les conteneurs verrouillés sont restés inchangés.",
  },
  "Container plan deleted": {
    en: "Container plan deleted",
    ar: "تم حذف خطة الحاويات",
    fr: "Plan de conteneurs supprimé",
  },
  "Could not save plan": {
    en: "Could not save plan",
    ar: "تعذر حفظ الخطة",
    fr: "Impossible d’enregistrer le plan",
  },
  "Could not rename plan": {
    en: "Could not rename plan",
    ar: "تعذرت إعادة تسمية الخطة",
    fr: "Impossible de renommer le plan",
  },
  "Could not update lock": {
    en: "Could not update lock",
    ar: "تعذر تحديث القفل",
    fr: "Impossible de mettre à jour le verrouillage",
  },
  "Could not move bales": {
    en: "Could not move bales",
    ar: "تعذر نقل البالات",
    fr: "Impossible de déplacer les balles",
  },
  "Could not rebalance plan": {
    en: "Could not rebalance plan",
    ar: "تعذرت إعادة موازنة الخطة",
    fr: "Impossible de rééquilibrer le plan",
  },
  "Could not delete plan": {
    en: "Could not delete plan",
    ar: "تعذر حذف الخطة",
    fr: "Impossible de supprimer le plan",
  },
  "Could not load saved plans.": {
    en: "Could not load saved plans.",
    ar: "تعذر تحميل خطط الحاويات المحفوظة.",
    fr: "Impossible de charger les plans de conteneurs enregistrés.",
  },
  "Could not load plan.": {
    en: "Could not load plan.",
    ar: "تعذر تحميل الخطة.",
    fr: "Impossible de charger le plan.",
  },
  "Unlock container": {
    en: "Unlock container",
    ar: "إلغاء قفل الحاوية",
    fr: "Déverrouiller le conteneur",
  },
  "Lock container": {
    en: "Lock container",
    ar: "قفل الحاوية",
    fr: "Verrouiller le conteneur",
  },
  "Move bales to another unlocked container": {
    en: "Move bales to another unlocked container",
    ar: "نقل البالات إلى حاوية أخرى غير مقفلة",
    fr: "Déplacer les balles vers un autre conteneur déverrouillé",
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
