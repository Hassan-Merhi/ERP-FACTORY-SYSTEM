import type { ApplicationLanguage } from "@shared/applicationLanguageContract";

export const FACTORY_TRACKING_STATUSES = {
  present: "Present",
  absent: "Absent",
  new: "New",
} as const;

const factoryStaffTrackingTranslations = {
  productionTargets: {
    en: "Production Targets",
    ar: "أهداف الإنتاج",
    fr: "Objectifs de production",
  },
  attendanceRegister: {
    en: "Attendance Register",
    ar: "سجل الحضور",
    fr: "Registre de présence",
  },
  hubDescription: {
    en: "Workers, employees, production targets, attendance and insurance",
    ar: "العمال والموظفون وأهداف الإنتاج والحضور والتأمين",
    fr: "Ouvriers, employés, objectifs de production, présence et assurance",
  },
  productionSubtitle: {
    en: "Set bale targets and compare them with production recorded automatically from factory data.",
    ar: "حدد أهداف البالات وقارنها بالإنتاج المسجل تلقائياً من بيانات المصنع.",
    fr: "Définissez les objectifs de balles et comparez-les à la production enregistrée automatiquement depuis les données de l’usine.",
  },
  attendanceSubtitle: {
    en: "Only absent workers from your saved production groups are shown below.",
    ar: "يظهر أدناه فقط العمال الغائبون من مجموعات الإنتاج المحفوظة لديك.",
    fr: "Seuls les ouvriers absents de vos groupes de production enregistrés sont affichés ci-dessous.",
  },
  period: { en: "Period", ar: "الفترة", fr: "Période" },
  daily: { en: "Daily", ar: "يومي", fr: "Quotidien" },
  weekly: { en: "Weekly", ar: "أسبوعي", fr: "Hebdomadaire" },
  monthly: { en: "Monthly", ar: "شهري", fr: "Mensuel" },
  referenceDate: { en: "Reference date", ar: "التاريخ المرجعي", fr: "Date de référence" },
  markAllPresent: { en: "Mark all present", ar: "تحديد الجميع كحاضرين", fr: "Marquer tous présents" },
  saving: { en: "Saving...", ar: "جارٍ الحفظ...", fr: "Enregistrement..." },
  save: { en: "Save", ar: "حفظ", fr: "Enregistrer" },
  refreshing: { en: "Refreshing…", ar: "جارٍ التحديث…", fr: "Actualisation…" },
  totalTarget: { en: "Total Target", ar: "إجمالي الهدف", fr: "Objectif total" },
  balesProduced: { en: "Bales Produced", ar: "البالات المنتجة", fr: "Balles produites" },
  difference: { en: "Difference", ar: "الفرق", fr: "Écart" },
  people: { en: "People", ar: "الأشخاص", fr: "Personnes" },
  totalPeople: { en: "Total People", ar: "إجمالي الأشخاص", fr: "Total personnes" },
  present: { en: "Present", ar: "حاضر", fr: "Présent" },
  absent: { en: "Absent", ar: "غائب", fr: "Absent" },
  new: { en: "New", ar: "جديد", fr: "Nouveau" },
  searchPlaceholder: {
    en: "Search name, code or group...",
    ar: "ابحث بالاسم أو الرمز أو المجموعة...",
    fr: "Rechercher par nom, code ou groupe...",
  },
  person: { en: "Person", ar: "الشخص", fr: "Personne" },
  code: { en: "Code", ar: "الرمز", fr: "Code" },
  category: { en: "Category", ar: "الفئة", fr: "Catégorie" },
  target: { en: "Target", ar: "الهدف", fr: "Objectif" },
  produced: { en: "Produced", ar: "المنتج", fr: "Produit" },
  status: { en: "Status", ar: "الحالة", fr: "Statut" },
  notes: { en: "Notes", ar: "ملاحظات", fr: "Notes" },
  loadingStaff: {
    en: "Loading factory staff…",
    ar: "جارٍ تحميل موظفي المصنع…",
    fr: "Chargement du personnel de l’usine…",
  },
  noMatchingStaff: {
    en: "No matching factory staff.",
    ar: "لا يوجد موظفون مطابقون في المصنع.",
    fr: "Aucun membre du personnel correspondant.",
  },
  noAbsentWorkers: {
    en: "No absent workers in the selected groups.",
    ar: "لا يوجد عمال غائبون في المجموعات المحددة.",
    fr: "Aucun ouvrier absent dans les groupes sélectionnés.",
  },
  worker: { en: "Worker", ar: "عامل", fr: "Ouvrier" },
  employee: { en: "Employee", ar: "موظف", fr: "Employé" },
  inactive: { en: "Inactive", ar: "غير نشط", fr: "Inactif" },
  categoryStation: { en: "Category / station", ar: "الفئة / المحطة", fr: "Catégorie / poste" },
  productionSaved: {
    en: "Production targets saved",
    ar: "تم حفظ أهداف الإنتاج",
    fr: "Objectifs de production enregistrés",
  },
  attendanceSaved: { en: "Attendance register saved", ar: "تم حفظ سجل الحضور", fr: "Registre de présence enregistré" },
  saveFailed: { en: "Save failed", ar: "فشل الحفظ", fr: "Échec de l’enregistrement" },
  loadFailed: {
    en: "Failed to load factory tracking data",
    ar: "تعذر تحميل بيانات متابعة المصنع",
    fr: "Impossible de charger les données de suivi de l’usine",
  },
  saveDataFailed: {
    en: "Failed to save factory tracking data",
    ar: "تعذر حفظ بيانات متابعة المصنع",
    fr: "Impossible d’enregistrer les données de suivi de l’usine",
  },
  copyYesterday: { en: "Copy Yesterday", ar: "نسخ أمس", fr: "Copier hier" },
  copyingYesterday: { en: "Copying…", ar: "جارٍ النسخ…", fr: "Copie…" },
  yesterdayCopied: {
    en: "Yesterday's production targets copied",
    ar: "تم نسخ أهداف إنتاج أمس",
    fr: "Objectifs de production d’hier copiés",
  },
  noYesterdayProduction: {
    en: "No saved production targets were found for yesterday",
    ar: "لم يتم العثور على أهداف إنتاج محفوظة لأمس",
    fr: "Aucun objectif de production enregistré n’a été trouvé pour hier",
  },
  copyYesterdayFailed: {
    en: "Could not copy yesterday's production",
    ar: "تعذر نسخ إنتاج أمس",
    fr: "Impossible de copier la production d’hier",
  },
  endProduction: { en: "End Production", ar: "إنهاء الإنتاج", fr: "Terminer la production" },
  endingProduction: { en: "Ending…", ar: "جارٍ الإنهاء…", fr: "Finalisation…" },
  productionEnded: {
    en: "Production ended and this day is locked",
    ar: "تم إنهاء الإنتاج وتم قفل هذا اليوم",
    fr: "Production terminée et journée verrouillée",
  },
  productionLocked: { en: "Production Ended", ar: "تم إنهاء الإنتاج", fr: "Production terminée" },
  productionLockedDetail: {
    en: "This day is frozen. Any production recorded after the cutoff rolls into the next production day.",
    ar: "تم تجميد هذا اليوم. أي إنتاج يُسجل بعد وقت الإغلاق يُرحّل إلى يوم الإنتاج التالي.",
    fr: "Cette journée est figée. Toute production enregistrée après la clôture passe au jour de production suivant.",
  },
  endProductionFailed: {
    en: "Could not end production",
    ar: "تعذر إنهاء الإنتاج",
    fr: "Impossible de terminer la production",
  },
  attendanceReport: {
    en: "Attendance Absence Report",
    ar: "تقرير الغياب",
    fr: "Rapport des absences",
  },
  sendWhatsappImage: {
    en: "Send WhatsApp Image",
    ar: "إرسال صورة عبر واتساب",
    fr: "Envoyer l’image WhatsApp",
  },
  sendingWhatsappImage: {
    en: "Sending image…",
    ar: "جارٍ إرسال الصورة…",
    fr: "Envoi de l’image…",
  },
  whatsappImageSent: {
    en: "Attendance image sent to WhatsApp group",
    ar: "تم إرسال صورة الحضور إلى مجموعة واتساب",
    fr: "Image de présence envoyée au groupe WhatsApp",
  },
  whatsappImageFailed: {
    en: "Failed to send attendance image",
    ar: "تعذر إرسال صورة الحضور",
    fr: "Impossible d’envoyer l’image de présence",
  },
  dailyTotal: { en: "Daily Total", ar: "الإجمالي اليومي", fr: "Total du jour" },
} as const;

export type FactoryStaffTrackingTranslationKey = keyof typeof factoryStaffTrackingTranslations;

export function translateFactoryStaffTrackingText(
  key: FactoryStaffTrackingTranslationKey,
  language: ApplicationLanguage
): string {
  const entry = factoryStaffTrackingTranslations[key];
  return entry[language] || entry.en;
}
