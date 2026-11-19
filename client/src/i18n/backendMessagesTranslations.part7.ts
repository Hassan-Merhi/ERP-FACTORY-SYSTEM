import type { Phase7BackendMessagesEntry } from "./backendMessagesTranslationTypes";

export const backendMessagesPhase7TranslationsPart7: readonly Phase7BackendMessagesEntry[] = [
  {
    en: "Validation error",
    ar: "خطأ في التحقق",
    fr: "Erreur de validation",
  },
  {
    en: "FX Revaluation — ${rateChangeDesc}",
    ar: "إعادة تقييم العملات الأجنبية — {0}",
    fr: "Réévaluation des devises — {0}",
  },
  {
    en: "Only Excel files (.xlsx, .xls) are allowed",
    ar: "يُسمح فقط بملفات Excel بصيغتي .xlsx و.xls",
    fr: "Seuls les fichiers Excel (.xlsx, .xls) sont autorisés",
  },
  {
    en: "Description is required.",
    ar: "الوصف مطلوب.",
    fr: "La description est requise.",
  },
  {
    en: "Amount must be a positive number.",
    ar: "يجب أن يكون المبلغ رقمًا موجبًا.",
    fr: "Le montant doit être un nombre positif.",
  },
  {
    en: "Type must be 'debit' or 'credit'.",
    ar: "يجب أن يكون النوع 'مدين' أو 'دائن'.",
    fr: "Le type doit être « débit » ou « crédit ».",
  },
  {
    en: "oldContainerId and newContainerId are required.",
    ar: "معرّفا الحاويتين القديمة والجديدة oldContainerId وnewContainerId مطلوبان.",
    fr: "oldContainerId et newContainerId sont requis.",
  },
  {
    en: "Old and new containers must be different.",
    ar: "يجب أن تختلف الحاوية القديمة عن الجديدة.",
    fr: "L’ancien et le nouveau conteneur doivent être différents.",
  },
  {
    en: "Old container (id ${oldContainerId}) not found.",
    ar: "لم يتم العثور على الحاوية القديمة ذات المعرّف {0}.",
    fr: "Ancien conteneur, identifiant {0}, introuvable.",
  },
  {
    en: "New container (id ${newContainerId}) not found.",
    ar: "لم يتم العثور على الحاوية الجديدة ذات المعرّف {0}.",
    fr: "Nouveau conteneur, identifiant {0}, introuvable.",
  },
  {
    en: "Container ${oldC.container_number} is not currently designated as prepaid for this agent.",
    ar: "الحاوية {0} غير مصنفة حاليًا كمدفوعة مسبقًا لهذا الوكيل.",
    fr: "Le conteneur {0} n’est pas actuellement désigné comme prépayé pour cet agent.",
  },
  {
    en: "Duty amounts differ between the two containers.",
    ar: "تختلف مبالغ الرسوم بين الحاويتين.",
    fr: "Les montants de droits diffèrent entre les deux conteneurs.",
  },
  {
    en: "File too large. Maximum allowed size is 10 MB.",
    ar: "الملف كبير جدًا. الحد الأقصى المسموح به هو 10 ميغابايت.",
    fr: "Fichier trop volumineux. La taille maximale autorisée est de 10 Mo.",
  },
  {
    en: "trackingDescription",
    ar: "وصف التتبع",
    fr: "Description du suivi",
  },
  {
    en: "importId required",
    ar: "معرّف الاستيراد importId مطلوب",
    fr: "importId est requis",
  },
  {
    en: "Undo data not found — it may have expired (2 hr limit) or already been used.",
    ar: "لم يتم العثور على بيانات التراجع — ربما انتهت صلاحيتها خلال ساعتين أو استُخدمت بالفعل.",
    fr: "Données d’annulation introuvables — elles ont peut-être expiré après 2 heures ou ont déjà été utilisées.",
  },
  {
    en: "Failed to fetch global transactions",
    ar: "فشل جلب المعاملات العامة",
    fr: "Échec de la récupération des transactions globales",
  },
  {
    en: "Failed to fetch voucher types",
    ar: "فشل جلب أنواع السندات",
    fr: "Échec de la récupération des types de pièces",
  },
  {
    en: "Invalid voucher ID",
    ar: "معرّف السند غير صالح",
    fr: "Identifiant de pièce non valide",
  },
  {
    en: "Failed to fetch voucher detail",
    ar: "فشل جلب تفاصيل السند",
    fr: "Échec de la récupération des détails de la pièce",
  },
  {
    en: "Failed to fetch view entries",
    ar: "فشل جلب قيود العرض",
    fr: "Échec de la récupération des écritures d’affichage",
  },
  {
    en: "This financial report is blocked because legacy foreign-currency entries or opening balances are unresolved.",
    ar: "تم حظر هذا التقرير المالي لأن قيود العملات الأجنبية القديمة أو الأرصدة الافتتاحية لم تُحل بعد.",
    fr: "Ce rapport financier est bloqué car des écritures historiques en devises ou des soldes d’ouverture ne sont pas résolus.",
  },
  {
    en: "Admin, Owner, or Developer access is required",
    ar: "يلزم وصول مسؤول أو مالك أو مطور",
    fr: "Un accès Administrateur, Propriétaire ou Développeur est requis",
  },
  {
    en: "The approved rows or current database state changed after preview. Run the dry-run again.",
    ar: "تغيّرت الصفوف المعتمدة أو حالة قاعدة البيانات الحالية بعد المعاينة. شغّل المعاينة الجافة مرة أخرى.",
    fr: "Les lignes approuvées ou l’état actuel de la base de données ont changé après l’aperçu. Relancez l’essai à blanc.",
  },
  {
    en: "Orphaned Inventory at Deleted Locations",
    ar: "مخزون معزول في مواقع محذوفة",
    fr: "Stock orphelin dans des emplacements supprimés",
  },
  {
    en: "You have ${orphanedInventory.length} inventory records worth $${totalOrphanedValue.toFixed(2)} at locations that have been deleted. This inventory is counted as an asset but doesn't exist in any active location.",
    ar: "لديك {0} سجل مخزون بقيمة ${1} في مواقع محذوفة. يُحتسب هذا المخزون كأصل لكنه غير موجود في أي موقع نشط.",
    fr: "Vous avez {0} enregistrement(s) de stock d’une valeur de ${1} dans des emplacements supprimés. Ce stock est comptabilisé comme actif mais n’existe dans aucun emplacement actif.",
  },
  {
    en: "Negative Inventory Quantities",
    ar: "كميات مخزون سالبة",
    fr: "Quantités de stock négatives",
  },
  {
    en: "You have ${negativeInventory.length} items with negative quantities. This shouldn't happen and indicates a data issue.",
    ar: "لديك {0} صنف بكميات سالبة. هذا غير طبيعي ويشير إلى مشكلة في البيانات.",
    fr: "Vous avez {0} article(s) avec des quantités négatives. Cela ne devrait pas arriver et indique un problème de données.",
  },
  {
    en: "Containers In Transit for Over 90 Days",
    ar: "حاويات في الطريق لأكثر من 90 يومًا",
    fr: "Conteneurs en transit depuis plus de 90 jours",
  },
  {
    en: 'You have ${staleContainers.length} container(s) worth $${totalStaleValue.toFixed(2)} that have been "On The Way" for more than 90 days. These may need to be offloaded or marked as lost.',
    ar: "لديك {0} حاوية بقيمة ${1} في حالة «في الطريق» لأكثر من 90 يومًا. قد يلزم تفريغها أو تعليمها كمفقودة.",
    fr: "Vous avez {0} conteneur(s) d’une valeur de ${1} en statut « En transit » depuis plus de 90 jours. Ils doivent peut-être être déchargés ou marqués comme perdus.",
  },
  {
    en: "Unbalanced Voucher Entries (${unbalancedVouchers.length})",
    ar: "قيود سندات غير متوازنة ({0})",
    fr: "Écritures de pièces déséquilibrées ({0})",
  },
  {
    en: '${unbalancedVouchers.length} voucher(s) where debits don\'t equal credits. Total imbalance: ${totalImbalance.toFixed(2)}. Details: ${voucherDetails}${unbalancedVouchers.length > 10 ? "..." : ""}',
    ar: "يوجد {0} سند لا تتساوى فيه المدينات والدائنات. إجمالي عدم التوازن: {1}. التفاصيل: {2}{3}",
    fr: "{0} pièce(s) dont les débits ne sont pas égaux aux crédits. Déséquilibre total : {1}. Détails : {2}{3}",
  },
  {
    en: "Opening Balance Equity Adjustment",
    ar: "تسوية حقوق الملكية للرصيد الافتتاحي",
    fr: "Ajustement des capitaux propres d’ouverture",
  },
  {
    en: "Your opening debit balances ($${totalDrOpenings.toFixed(2)}) differ from opening credit balances ($${totalCrOpenings.toFixed(2)}) by $${openingImbalance.toFixed(2)}. This is treated as implicit opening equity.",
    ar: "تختلف أرصدتك الافتتاحية المدينة (${0}) عن الأرصدة الافتتاحية الدائنة (${1}) بمقدار ${2}. يُعامل هذا كحقوق ملكية افتتاحية ضمنية.",
    fr: "Vos soldes d’ouverture débiteurs (${0}) diffèrent des soldes d’ouverture créditeurs (${1}) de ${2}. Cet écart est traité comme des capitaux propres d’ouverture implicites.",
  },
  {
    en: "Outstanding Employee Balances",
    ar: "أرصدة موظفين مستحقة",
    fr: "Soldes employés en cours",
  },
  {
    en: "You owe ${employeesData.length} employee(s) a total of $${totalOwed.toFixed(2)}. This is recorded as a liability.",
    ar: "أنت مدين لـ {0} موظف بإجمالي ${1}. يُسجل ذلك كالتزام.",
    fr: "Vous devez un total de ${1} à {0} employé(s). Ce montant est enregistré comme passif.",
  },
  {
    en: 'Loans Account "${loanAcct.name}" Has Net Debit Balance — Office Charges May Be Posted Backwards',
    ar: "حساب القروض «{0}» لديه رصيد مدين صافٍ — قد تكون مصروفات المكتب مُرحلة بالعكس",
    fr: "Le compte de prêts « {0} » présente un solde débiteur net — les charges de bureau sont peut-être comptabilisées à l’envers",
  },
  {
    en: "Missing required fields",
    ar: "الحقول المطلوبة مفقودة",
    fr: "Champs requis manquants",
  },
  {
    en: "A parent freight account must be selected when freight is paid by parent company",
    ar: "يجب اختيار حساب شحن للشركة الأم عندما تدفع الشركة الأم تكاليف الشحن",
    fr: "Un compte de fret de la société mère doit être sélectionné lorsque le fret est payé par la société mère",
  },
  {
    en: 'Container "${containerNumber}" already exists in the system. Each container number can only be imported once.',
    ar: "الحاوية «{0}» موجودة بالفعل في النظام. لا يمكن استيراد رقم الحاوية نفسه إلا مرة واحدة.",
    fr: "Le conteneur « {0} » existe déjà dans le système. Chaque numéro de conteneur ne peut être importé qu’une seule fois.",
  },
  {
    en: '${containerNumber} ${supplier?.legalName || "Unknown"}',
    ar: "{0} {1}",
    fr: "{0} {1}",
  },
  {
    en: "SP accounts not configured. Please run SP Setup first at /sp/setup.",
    ar: "حسابات الشريك المورّد غير مهيأة. يرجى تشغيل إعداد الشريك المورّد أولًا من /sp/setup.",
    fr: "Les comptes Partenaire fournisseur ne sont pas configurés. Exécutez d’abord la configuration SP sur /sp/setup.",
  },
  {
    en: "Stock item not found: ${item.barcode || item.itemName}. Please ensure all items exist before importing.",
    ar: "لم يتم العثور على عنصر المخزون: {0}. تأكد من وجود جميع الأصناف قبل الاستيراد.",
    fr: "Article de stock introuvable : {0}. Vérifiez que tous les articles existent avant l’importation.",
  },
  {
    en: "locationId, type, and items are required",
    ar: "معرّف الموقع locationId والنوع والأصناف مطلوبة",
    fr: "locationId, le type et les articles sont requis",
  },
  {
    en: "type must be Production or Consumption",
    ar: "يجب أن يكون النوع إنتاجًا أو استهلاكًا",
    fr: "Le type doit être Production ou Consommation",
  },
  {
    en: "Intercompany Payment Request",
    ar: "طلب دفع بين الشركات",
    fr: "Demande de paiement interentreprises",
  },
  {
    en: 'Payment request from voucher ${voucherNumber} — ${description || ""}',
    ar: "طلب دفع من السند {0} — {1}",
    fr: "Demande de paiement provenant de la pièce {0} — {1}",
  },
  {
    en: "Invalid ID",
    ar: "المعرّف غير صالح",
    fr: "Identifiant non valide",
  },
  {
    en: "Invalid company ID",
    ar: "معرّف الشركة غير صالح",
    fr: "Identifiant d’entreprise non valide",
  },
  {
    en: "Some selected recipients do not have a role in the destination company",
    ar: "بعض المستلمين المحددين ليس لديهم دور في الشركة الوجهة",
    fr: "Certains destinataires sélectionnés n’ont aucun rôle dans l’entreprise de destination",
  },
];
