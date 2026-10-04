import type { ApplicationLanguage } from "@shared/applicationLanguageContract";

const priorityScanTranslations = {
  priorityScan: { en: "Priority Scan", ar: "المسح حسب الأولوية", fr: "Scan prioritaire" },
  loadingsHubSubtitle: {
    en: "Container loading, pending sessions and priority scanning",
    ar: "تحميل الحاويات والجلسات المعلقة والمسح حسب الأولوية",
    fr: "Chargement des conteneurs, sessions en attente et scan prioritaire",
  },
  scanDescription: {
    en: "Scan a bale reference. The priority queue stays visible while you work.",
    ar: "امسح مرجع البالة. تبقى قائمة الأولويات ظاهرة أثناء العمل.",
    fr: "Scannez une référence de balle. La file de priorités reste visible pendant le travail.",
  },
  activePriority: {
    en: "{count} active priority",
    ar: "{count} أولوية نشطة",
    fr: "{count} priorité active",
  },
  activePriorities: {
    en: "{count} active priorities",
    ar: "{count} أولوية نشطة",
    fr: "{count} priorités actives",
  },
  scanPlaceholder: { en: "Scan reference...", ar: "امسح المرجع...", fr: "Scanner la référence..." },
  scan: { en: "Scan", ar: "مسح", fr: "Scanner" },
  checking: { en: "Checking…", ar: "جارٍ التحقق…", fr: "Vérification…" },
  routeHint: {
    en: "Each reference goes to the highest-priority loading that still needs it; satisfied loadings advance automatically.",
    ar: "يتم توجيه كل مرجع إلى أعلى تحميل ذي أولوية ما زال يحتاجه، وتنتقل الأولوية تلقائيًا عند اكتمال التحميل.",
    fr: "Chaque référence va vers le chargement prioritaire le plus élevé qui en a encore besoin ; les chargements satisfaits avancent automatiquement.",
  },
  manualExceptionHint: {
    en: "Overload or items not requested on the proforma must be scanned from the normal Pending Loading scanner.",
    ar: "يجب مسح التحميل الزائد أو الأصناف غير المطلوبة في البروفرما من ماسح التحميلات المعلقة العادي.",
    fr: "Les surcharges ou articles non demandés sur la proforma doivent être scannés depuis le scanner normal des chargements en attente.",
  },
  currentPriority: { en: "Current priority", ar: "الأولوية الحالية", fr: "Priorité actuelle" },
  priorityNumber: { en: "Priority #{priority}", ar: "الأولوية #{priority}", fr: "Priorité #{priority}" },
  loadingNumber: { en: "Loading #{orderId}", ar: "تحميل #{orderId}", fr: "Chargement #{orderId}" },
  customerLoading: {
    en: "Customer loading #{orderId}",
    ar: "تحميل العميل #{orderId}",
    fr: "Chargement client #{orderId}",
  },
  proformaNumber: { en: "Proforma #{proformaId}", ar: "بروفرما #{proformaId}", fr: "Proforma #{proformaId}" },
  balesAlreadyScanned: {
    en: "{count} bales already scanned",
    ar: "تم مسح {count} بالة",
    fr: "{count} balles déjà scannées",
  },
  noPriorityQueue: {
    en: "No Priority Scan queue yet. Set colors and priorities from Pending Loadings.",
    ar: "لا توجد قائمة للمسح حسب الأولوية بعد. حدّد الألوان والأولويات من التحميلات المعلقة.",
    fr: "Aucune file de scan prioritaire pour le moment. Définissez les couleurs et priorités depuis les chargements en attente.",
  },
  priorityQueue: { en: "Priority queue", ar: "قائمة الأولويات", fr: "File de priorités" },
  firstRowActive: {
    en: "The first row is the active priority.",
    ar: "الصف الأول هو الأولوية النشطة.",
    fr: "La première ligne est la priorité active.",
  },
  noPrioritiesEnabled: {
    en: "No loadings have Priority Scan enabled.",
    ar: "لا توجد تحميلات مفعّل لها المسح حسب الأولوية.",
    fr: "Aucun chargement n’a le scan prioritaire activé.",
  },
  scanned: { en: "scanned", ar: "ممسوح", fr: "scannées" },
  active: { en: "Active", ar: "نشط", fr: "Active" },
  thisSession: { en: "This scan session", ar: "جلسة المسح الحالية", fr: "Cette session de scan" },
  referenceProductOnly: {
    en: "Reference and product only.",
    ar: "المرجع والمنتج فقط.",
    fr: "Référence et produit uniquement.",
  },
  scanToBegin: { en: "Scan a reference to begin.", ar: "امسح مرجعًا للبدء.", fr: "Scannez une référence pour commencer." },
  unnamedProduct: { en: "Unnamed product", ar: "منتج بدون اسم", fr: "Produit sans nom" },
  priorityColor: { en: "Priority color {color}", ar: "لون الأولوية {color}", fr: "Couleur de priorité {color}" },
  noActivePriority: {
    en: "No active Priority Scan loading is configured.",
    ar: "لا يوجد تحميل نشط مضبوط للمسح حسب الأولوية.",
    fr: "Aucun chargement actif n’est configuré pour le scan prioritaire.",
  },
  alreadyScannedSession: {
    en: "Already scanned in this Priority Scan session.",
    ar: "تم مسح هذا المرجع بالفعل في جلسة المسح حسب الأولوية الحالية.",
    fr: "Déjà scanné dans cette session de scan prioritaire.",
  },
  couldNotRoute: {
    en: "Could not route this reference.",
    ar: "تعذر توجيه هذا المرجع.",
    fr: "Impossible d’acheminer cette référence.",
  },
  noDestination: {
    en: "Could not find an available Priority Scan destination.",
    ar: "تعذر العثور على وجهة متاحة للمسح حسب الأولوية.",
    fr: "Aucune destination de scan prioritaire disponible n’a été trouvée.",
  },
  addedToPriority: {
    en: "Added to Priority #{priority} — Loading #{orderId}.",
    ar: "تمت الإضافة إلى الأولوية #{priority} — التحميل #{orderId}.",
    fr: "Ajouté à la priorité #{priority} — chargement #{orderId}.",
  },
  loadingSatisfiedAdvance: {
    en: "Loading #{orderId} is satisfied. Advanced to Loading #{nextOrderId}.",
    ar: "اكتمل التحميل #{orderId}. تم الانتقال إلى التحميل #{nextOrderId}.",
    fr: "Le chargement #{orderId} est satisfait. Passage au chargement #{nextOrderId}.",
  },
  loadingSatisfiedComplete: {
    en: "Loading #{orderId} is satisfied. Priority queue is complete.",
    ar: "اكتمل التحميل #{orderId}. اكتملت قائمة الأولويات.",
    fr: "Le chargement #{orderId} est satisfait. La file de priorités est terminée.",
  },
  setPriority: { en: "Set Priority", ar: "تحديد الأولوية", fr: "Définir la priorité" },
  editPriorityTitle: {
    en: "Edit Priority Scan color and position",
    ar: "تعديل لون وموقع المسح حسب الأولوية",
    fr: "Modifier la couleur et la position du scan prioritaire",
  },
  moveUp: { en: "Move up in Priority Scan queue", ar: "نقل للأعلى في قائمة الأولويات", fr: "Monter dans la file prioritaire" },
  moveDown: { en: "Move down in Priority Scan queue", ar: "نقل للأسفل في قائمة الأولويات", fr: "Descendre dans la file prioritaire" },
  linkProformaFirst: {
    en: "Link a proforma before setting Priority Scan",
    ar: "اربط بروفرما قبل تحديد المسح حسب الأولوية",
    fr: "Associez une proforma avant de définir le scan prioritaire",
  },
  dialogTitle: {
    en: "Priority Scan — Loading #{orderId}",
    ar: "المسح حسب الأولوية — التحميل #{orderId}",
    fr: "Scan prioritaire — chargement #{orderId}",
  },
  dialogDescription: {
    en: "Choose the color and queue position for {customer}. Moving this loading into an occupied position automatically shifts the other priorities.",
    ar: "اختر اللون وموقع القائمة للعميل {customer}. نقل هذا التحميل إلى موقع مشغول يزيح الأولويات الأخرى تلقائيًا.",
    fr: "Choisissez la couleur et la position dans la file pour {customer}. Déplacer ce chargement vers une position occupée décale automatiquement les autres priorités.",
  },
  linkProformaWarning: {
    en: "Link a proforma to this loading before enabling Priority Scan.",
    ar: "اربط بروفرما بهذا التحميل قبل تفعيل المسح حسب الأولوية.",
    fr: "Associez une proforma à ce chargement avant d’activer le scan prioritaire.",
  },
  priorityColorLabel: { en: "Priority color", ar: "لون الأولوية", fr: "Couleur de priorité" },
  useColor: { en: "Use color {color}", ar: "استخدام اللون {color}", fr: "Utiliser la couleur {color}" },
  colorUsed: {
    en: "Color already used by another priority",
    ar: "اللون مستخدم بالفعل لأولوية أخرى",
    fr: "Couleur déjà utilisée par une autre priorité",
  },
  chooseCustomColor: { en: "Choose custom priority color", ar: "اختر لون أولوية مخصصًا", fr: "Choisir une couleur de priorité personnalisée" },
  colorAlreadyAssigned: {
    en: "That color is already assigned to another active priority.",
    ar: "هذا اللون مخصص بالفعل لأولوية نشطة أخرى.",
    fr: "Cette couleur est déjà attribuée à une autre priorité active.",
  },
  queuePosition: { en: "Queue position", ar: "موقع القائمة", fr: "Position dans la file" },
  autoAdvanceHint: {
    en: "Priority #1 is first. Fully satisfied loadings leave the queue automatically and the remaining priorities move up.",
    ar: "الأولوية #1 هي الأولى. تخرج التحميلات المكتملة تلقائيًا من القائمة وتتقدم الأولويات المتبقية.",
    fr: "La priorité #1 passe en premier. Les chargements satisfaits quittent automatiquement la file et les autres priorités remontent.",
  },
  removePriority: { en: "Remove Priority", ar: "إزالة الأولوية", fr: "Retirer la priorité" },
  cancel: { en: "Cancel", ar: "إلغاء", fr: "Annuler" },
  saving: { en: "Saving…", ar: "جارٍ الحفظ…", fr: "Enregistrement…" },
  savePriority: { en: "Save Priority", ar: "حفظ الأولوية", fr: "Enregistrer la priorité" },
  addToQueue: { en: "Add to Queue", ar: "إضافة إلى القائمة", fr: "Ajouter à la file" },
  prioritySaved: { en: "Priority #{priority} saved", ar: "تم حفظ الأولوية #{priority}", fr: "Priorité #{priority} enregistrée" },
  loadingNowQueued: {
    en: "Loading #{orderId} is now in the Priority Scan queue.",
    ar: "أصبح التحميل #{orderId} الآن في قائمة المسح حسب الأولوية.",
    fr: "Le chargement #{orderId} est maintenant dans la file de scan prioritaire.",
  },
  priorityUpdateFailed: { en: "Priority update failed", ar: "فشل تحديث الأولوية", fr: "Échec de la mise à jour de la priorité" },
  priorityNotActive: { en: "Priority is not active.", ar: "الأولوية غير نشطة.", fr: "La priorité n’est pas active." },
  couldNotMove: { en: "Could not move priority", ar: "تعذر نقل الأولوية", fr: "Impossible de déplacer la priorité" },
  priorityRemoved: { en: "Priority removed", ar: "تمت إزالة الأولوية", fr: "Priorité retirée" },
  loadingRemovedFromQueue: {
    en: "Loading #{orderId} was removed from the Priority Scan queue.",
    ar: "تمت إزالة التحميل #{orderId} من قائمة المسح حسب الأولوية.",
    fr: "Le chargement #{orderId} a été retiré de la file de scan prioritaire.",
  },
  couldNotRemove: { en: "Could not remove priority", ar: "تعذر إزالة الأولوية", fr: "Impossible de retirer la priorité" },
} as const;

export type PriorityScanTranslationKey = keyof typeof priorityScanTranslations;

export function translatePriorityScanText(
  key: PriorityScanTranslationKey,
  language: ApplicationLanguage,
  params?: Record<string, string | number>
): string {
  const entry = priorityScanTranslations[key];
  const template = entry[language] || entry.en;
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (_match, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : `{${name}}`
  );
}
