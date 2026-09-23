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
  saveChanges: { en: "Save Changes", ar: "حفظ التغييرات", fr: "Enregistrer les modifications" },
  discardChanges: { en: "Discard Changes", ar: "إلغاء التغييرات", fr: "Annuler les modifications" },
  unsavedChanges: { en: "Unsaved changes", ar: "تغييرات غير محفوظة", fr: "Modifications non enregistrées" },
  editProductionDirectly: {
    en: "Edit category and target directly in the table, then save once.",
    ar: "عدّل الفئة والهدف مباشرةً في الجدول، ثم احفظ مرة واحدة.",
    fr: "Modifiez directement la catégorie et l’objectif dans le tableau, puis enregistrez une seule fois.",
  },
  editTargets: { en: "Edit Targets", ar: "تعديل الأهداف", fr: "Modifier les objectifs" },
  defaultTargets: { en: "Daily Defaults", ar: "الأهداف اليومية الافتراضية", fr: "Objectifs quotidiens par défaut" },
  dailyDefaultTarget: { en: "Daily Default", ar: "الهدف اليومي الافتراضي", fr: "Objectif quotidien par défaut" },
  defaultTargetsDescription: {
    en: "Set each worker's repeating category and daily target from this date forward. A manual Edit Targets change for a specific day always wins for that day and is not changed by later Daily Defaults edits.",
    ar: "حدّد الفئة والهدف اليومي المتكررين لكل عامل ابتداءً من هذا التاريخ. أي تعديل يدوي من «تعديل الأهداف» ليوم محدد تكون له الأولوية في ذلك اليوم ولا تغيّره التعديلات اللاحقة على الإعدادات اليومية الافتراضية.",
    fr: "Définissez la catégorie et l’objectif quotidien récurrents de chaque ouvrier à partir de cette date. Une modification manuelle dans « Modifier les objectifs » pour un jour précis reste prioritaire pour ce jour et n’est pas remplacée par des modifications ultérieures des valeurs quotidiennes par défaut.",
  },
  defaultTargetsSaved: {
    en: "Daily category and target defaults saved",
    ar: "تم حفظ الفئة والهدف اليومي الافتراضيين",
    fr: "Catégorie et objectifs quotidiens par défaut enregistrés",
  },
  productionEditorDescription: {
    en: "Edit the selected day's category and target only. This does not change the worker's repeating daily default.",
    ar: "عدّل فئة وهدف اليوم المحدد فقط. هذا لا يغيّر الهدف اليومي الافتراضي المتكرر للعامل.",
    fr: "Modifiez uniquement la catégorie et l’objectif du jour sélectionné. Cela ne change pas l’objectif quotidien récurrent de l’ouvrier.",
  },
  useEditorToManageTargets: {
    en: "Daily Defaults repeat category and target forward; Edit Targets changes only the selected day.",
    ar: "الإعدادات اليومية الافتراضية تكرر الفئة والهدف للأيام القادمة، بينما تعديل الأهداف يغيّر اليوم المحدد فقط.",
    fr: "Les valeurs quotidiennes par défaut répètent la catégorie et l’objectif à l’avenir ; Modifier les objectifs ne change que le jour sélectionné.",
  },
  searchNameCodeCategory: {
    en: "Search name, code or category...",
    ar: "ابحث بالاسم أو الرمز أو الفئة...",
    fr: "Rechercher par nom, code ou catégorie...",
  },
  allCategories: { en: "All categories", ar: "كل الفئات", fr: "Toutes les catégories" },
  changes: { en: "changes", ar: "تغييرات", fr: "modifications" },
  editorChangesSaveTogether: {
    en: "Changes stay in this editor until you save them together.",
    ar: "تبقى التغييرات داخل هذا المحرر حتى تحفظها معاً.",
    fr: "Les modifications restent dans cet éditeur jusqu’à leur enregistrement groupé.",
  },
  cancel: { en: "Cancel", ar: "إلغاء", fr: "Annuler" },
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
    en: "Search name, code or category...",
    ar: "ابحث بالاسم أو الرمز أو الفئة...",
    fr: "Rechercher par nom, code ou catégorie...",
  },
  person: { en: "Person", ar: "الشخص", fr: "Personne" },
  code: { en: "Code", ar: "الرمز", fr: "Code" },
  linkWorker: { en: "Link worker", ar: "ربط عامل", fr: "Lier un ouvrier" },
  link: { en: "Link", ar: "ربط", fr: "Lier" },
  unlink: { en: "Unlink", ar: "إلغاء الربط", fr: "Dissocier" },
  linkedWith: { en: "Linked with", ar: "مرتبط مع", fr: "Lié avec" },
  chooseWorker: { en: "Choose worker", ar: "اختر عاملاً", fr: "Choisir un ouvrier" },
  workerLinkSaved: { en: "Workers linked", ar: "تم ربط العمال", fr: "Ouvriers liés" },
  workerUnlinked: { en: "Workers unlinked", ar: "تم إلغاء ربط العمال", fr: "Ouvriers dissociés" },
  workerLinkFailed: {
    en: "Could not update worker link",
    ar: "تعذر تحديث ربط العمال",
    fr: "Impossible de modifier le lien entre ouvriers",
  },
  category: { en: "Category", ar: "الفئة", fr: "Catégorie" },
  target: { en: "Target", ar: "الهدف", fr: "Objectif" },
  produced: { en: "Produced", ar: "المنتج", fr: "Produit" },
  status: { en: "Status", ar: "الحالة", fr: "Statut" },
  notes: { en: "Notes", ar: "ملاحظات", fr: "Notes" },
  group: { en: "Group", ar: "المجموعة", fr: "Groupe" },
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
  excelTemplate: { en: "Excel Template", ar: "قالب Excel", fr: "Modèle Excel" },
  importExcel: { en: "Import Excel", ar: "استيراد Excel", fr: "Importer Excel" },
  importing: { en: "Importing…", ar: "جارٍ الاستيراد…", fr: "Importation…" },
  templateDownloadFailed: {
    en: "Template download failed",
    ar: "فشل تنزيل القالب",
    fr: "Échec du téléchargement du modèle",
  },
  couldNotCreateExcelTemplate: {
    en: "Could not create the Excel template",
    ar: "تعذر إنشاء قالب Excel",
    fr: "Impossible de créer le modèle Excel",
  },
  workbookMissingWorksheet: {
    en: "The workbook does not contain a worksheet",
    ar: "لا يحتوي المصنف على ورقة عمل",
    fr: "Le classeur ne contient aucune feuille de calcul",
  },
  missingRequiredColumn: {
    en: "Missing required column",
    ar: "العمود المطلوب مفقود",
    fr: "Colonne requise manquante",
  },
  excelNoWorkerRows: {
    en: "The Excel file does not contain any worker rows",
    ar: "لا يحتوي ملف Excel على صفوف عمال",
    fr: "Le fichier Excel ne contient aucune ligne d’ouvrier",
  },
  duplicateWorkerCodeInExcel: {
    en: "Duplicate worker code in Excel",
    ar: "رمز عامل مكرر في Excel",
    fr: "Code ouvrier en double dans Excel",
  },
  invalidTargetForWorkerCode: {
    en: "Invalid target for worker code",
    ar: "هدف غير صالح لرمز العامل",
    fr: "Objectif invalide pour le code ouvrier",
  },
  noWorkerCodesFound: {
    en: "No worker codes were found in the Excel file",
    ar: "لم يتم العثور على رموز عمال في ملف Excel",
    fr: "Aucun code ouvrier trouvé dans le fichier Excel",
  },
  noMatchingWorkerCodes: {
    en: "None of the worker codes in the Excel file match this Production Targets list",
    ar: "لا يطابق أي رمز عامل في ملف Excel قائمة أهداف الإنتاج هذه",
    fr: "Aucun code ouvrier du fichier Excel ne correspond à cette liste d’objectifs de production",
  },
  couldNotSaveImportedProductionTargets: {
    en: "Could not save imported Production Targets",
    ar: "تعذر حفظ أهداف الإنتاج المستوردة",
    fr: "Impossible d’enregistrer les objectifs de production importés",
  },
  productionTargetsImported: {
    en: "Production targets imported",
    ar: "تم استيراد أهداف الإنتاج",
    fr: "Objectifs de production importés",
  },
  workerCodesNotFoundSkipped: {
    en: "worker code(s) were not found and were skipped.",
    ar: "رمز/رموز عامل لم يتم العثور عليها وتم تجاوزها.",
    fr: "code(s) ouvrier introuvable(s) ont été ignoré(s).",
  },
  categoryTargetSaved: {
    en: "The category and target values were saved.",
    ar: "تم حفظ قيم الفئة والهدف.",
    fr: "Les valeurs de catégorie et d’objectif ont été enregistrées.",
  },
  excelImportFailed: {
    en: "Excel import failed",
    ar: "فشل استيراد Excel",
    fr: "Échec de l’importation Excel",
  },
  couldNotImportProductionTargets: {
    en: "Could not import Production Targets",
    ar: "تعذر استيراد أهداف الإنتاج",
    fr: "Impossible d’importer les objectifs de production",
  },
  statusControlledFromAttendance: {
    en: "Status is controlled from Attendance Register",
    ar: "يتم التحكم بالحالة من سجل الحضور",
    fr: "Le statut est contrôlé depuis le registre de présence",
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
  productionWhatsappImageSent: {
    en: "Production image sent to WhatsApp group",
    ar: "تم إرسال صورة الإنتاج إلى مجموعة واتساب",
    fr: "Image de production envoyée au groupe WhatsApp",
  },
  productionWhatsappImageFailed: {
    en: "Production ended, but the WhatsApp image was not sent",
    ar: "تم إنهاء الإنتاج، لكن لم يتم إرسال الصورة عبر واتساب",
    fr: "La production est terminée, mais l’image WhatsApp n’a pas été envoyée",
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
