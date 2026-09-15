import type { Phase7BackendMessagesEntry } from "./backendMessagesPhase7TranslationTypes";

export const backendMessagesPhase7TranslationsPart1: readonly Phase7BackendMessagesEntry[] = [
  {
    en: "Search Stock Items",
    ar: "البحث في عناصر المخزون",
    fr: "Rechercher des articles de stock",
  },
  {
    en: "Search stock items by name or code and show current quantities",
    ar: "ابحث عن عناصر المخزون بالاسم أو الرمز واعرض الكميات الحالية",
    fr: "Rechercher des articles par nom ou code et afficher les quantités actuelles",
  },
  {
    en: "Search Suppliers",
    ar: "البحث عن الموردين",
    fr: "Rechercher des fournisseurs",
  },
  {
    en: "Search suppliers by name or code and show contact info",
    ar: "ابحث عن الموردين بالاسم أو الرمز واعرض معلومات الاتصال",
    fr: "Rechercher des fournisseurs par nom ou code et afficher leurs coordonnées",
  },
  {
    en: "Search Customers",
    ar: "البحث عن العملاء",
    fr: "Rechercher des clients",
  },
  {
    en: "Search customers by name or code",
    ar: "ابحث عن العملاء بالاسم أو الرمز",
    fr: "Rechercher des clients par nom ou code",
  },
  {
    en: "Search Ledger Accounts",
    ar: "البحث عن حسابات دفتر الأستاذ",
    fr: "Rechercher des comptes du grand livre",
  },
  {
    en: "Search accounting/ledger accounts by name or code",
    ar: "ابحث عن الحسابات المحاسبية أو حسابات دفتر الأستاذ بالاسم أو الرمز",
    fr: "Rechercher des comptes comptables ou du grand livre par nom ou code",
  },
  {
    en: "Search Vouchers",
    ar: "البحث عن السندات",
    fr: "Rechercher des pièces comptables",
  },
  {
    en: "Search vouchers and transactions by description or voucher number",
    ar: "ابحث عن السندات والمعاملات حسب الوصف أو رقم السند",
    fr: "Rechercher des pièces et transactions par description ou numéro de pièce",
  },
  {
    en: "Validate Item Codes",
    ar: "التحقق من رموز الأصناف",
    fr: "Valider les codes d’articles",
  },
  {
    en: "Check which item codes exist in the ERP system (useful before imports)",
    ar: "تحقق من رموز الأصناف الموجودة في نظام ERP، وهو مفيد قبل الاستيراد",
    fr: "Vérifier quels codes d’articles existent dans l’ERP, utile avant les importations",
  },
  {
    en: "Get Business Alerts",
    ar: "الحصول على تنبيهات الأعمال",
    fr: "Obtenir les alertes métier",
  },
  {
    en: "Get today & month sales summary, low-stock alerts, and pricing health",
    ar: "احصل على ملخص مبيعات اليوم والشهر وتنبيهات انخفاض المخزون وسلامة التسعير",
    fr: "Obtenir le résumé des ventes du jour et du mois, les alertes de stock faible et l’état de la tarification",
  },
  {
    en: "Validate Import Job",
    ar: "التحقق من مهمة الاستيراد",
    fr: "Valider la tâche d’importation",
  },
  {
    en: "Check the status and validation results of an AI import job",
    ar: "تحقق من حالة مهمة استيراد بالذكاء الاصطناعي ونتائج التحقق منها",
    fr: "Vérifier l’état et les résultats de validation d’une tâche d’importation IA",
  },
  {
    en: "Prepare Voucher Draft",
    ar: "إعداد مسودة سند",
    fr: "Préparer un brouillon de pièce",
  },
  {
    en: "Build a journal / receipt / payment voucher and request approval before posting",
    ar: "أنشئ سند قيد أو قبض أو دفع واطلب الموافقة قبل الترحيل",
    fr: "Créer une pièce de journal, de reçu ou de paiement et demander une approbation avant comptabilisation",
  },
  {
    en: "Voucher memo",
    ar: "مذكرة السند",
    fr: "Mémo de la pièce",
  },
  {
    en: "Prepare Purchase Order Draft",
    ar: "إعداد مسودة أمر شراء",
    fr: "Préparer un brouillon de bon de commande",
  },
  {
    en: "Build a purchase order for a supplier and request approval before creating",
    ar: "أنشئ أمر شراء لمورد واطلب الموافقة قبل إنشائه",
    fr: "Créer un bon de commande fournisseur et demander une approbation avant sa création",
  },
  {
    en: "PO description or reference",
    ar: "وصف أمر الشراء أو مرجعه",
    fr: "Description ou référence du bon de commande",
  },
  {
    en: "Prepare Price Update Draft",
    ar: "إعداد مسودة تحديث الأسعار",
    fr: "Préparer un brouillon de mise à jour des prix",
  },
  {
    en: "Build a batch selling-price update and request approval before applying",
    ar: "أنشئ تحديثًا جماعيًا لأسعار البيع واطلب الموافقة قبل تطبيقه",
    fr: "Préparer une mise à jour groupée des prix de vente et demander une approbation avant application",
  },
  {
    en: "Prepare Stock Adjustment Draft",
    ar: "إعداد مسودة تسوية المخزون",
    fr: "Préparer un brouillon d’ajustement de stock",
  },
  {
    en: "Prepare an inventory quantity adjustment and request approval before posting",
    ar: "أعد تسوية لكمية المخزون واطلب الموافقة قبل الترحيل",
    fr: "Préparer un ajustement de quantité de stock et demander une approbation avant comptabilisation",
  },
  {
    en: "Compare Excel Datasets",
    ar: "مقارنة بيانات Excel",
    fr: "Comparer des jeux de données Excel",
  },
  {
    en: "Compare two uploaded Excel files and report differences (items added, removed, changed)",
    ar: "قارن ملفي Excel مرفوعين واعرض الفروقات في الأصناف المضافة والمحذوفة والمتغيرة",
    fr: "Comparer deux fichiers Excel téléversés et signaler les différences : articles ajoutés, supprimés ou modifiés",
  },
  {
    en: "What comparison to perform",
    ar: "ما المقارنة المطلوب تنفيذها؟",
    fr: "Quelle comparaison effectuer ?",
  },
  {
    en: "No codes provided",
    ar: "لم يتم تقديم أي رموز",
    fr: "Aucun code fourni",
  },
  {
    en: "jobId is required",
    ar: "معرّف المهمة jobId مطلوب",
    fr: "jobId est requis",
  },
  {
    en: "Import job ${jobId} not found",
    ar: "لم يتم العثور على مهمة الاستيراد {0}",
    fr: "Tâche d’importation {0} introuvable",
  },
  {
    en: "File comparison is available via the AI Import page. Upload both Excel files there to compare datasets.",
    ar: "تتوفر مقارنة الملفات عبر صفحة الاستيراد بالذكاء الاصطناعي. ارفع ملفي Excel هناك لمقارنة البيانات.",
    fr: "La comparaison de fichiers est disponible sur la page d’importation IA. Téléversez-y les deux fichiers Excel pour comparer les données.",
  },
  {
    en: "Voucher draft prepared — awaiting your approval.",
    ar: "تم إعداد مسودة السند — بانتظار موافقتك.",
    fr: "Brouillon de pièce préparé — en attente de votre approbation.",
  },
  {
    en: "Purchase order draft prepared — awaiting your approval.",
    ar: "تم إعداد مسودة أمر الشراء — بانتظار موافقتك.",
    fr: "Brouillon de bon de commande préparé — en attente de votre approbation.",
  },
  {
    en: "Price update draft for ${updates.length} items — awaiting your approval.",
    ar: "تم إعداد مسودة تحديث الأسعار لـ {0} عنصر — بانتظار موافقتك.",
    fr: "Brouillon de mise à jour des prix pour {0} articles — en attente de votre approbation.",
  },
  {
    en: "Stock adjustment draft prepared — awaiting your approval.",
    ar: "تم إعداد مسودة تسوية المخزون — بانتظار موافقتك.",
    fr: "Brouillon d’ajustement de stock préparé — en attente de votre approbation.",
  },
  {
    en: "Unknown tool: ${toolName}",
    ar: "أداة غير معروفة: {0}",
    fr: "Outil inconnu : {0}",
  },
  {
    en: "Invalid companyId in request ${decision.source}.",
    ar: "قيمة companyId غير صالحة في الطلب {0}.",
    fr: "Valeur companyId non valide dans la requête {0}.",
  },
  {
    en: "All companyId values in the request must match.",
    ar: "يجب أن تتطابق جميع قيم companyId في الطلب.",
    fr: "Toutes les valeurs companyId de la requête doivent correspondre.",
  },
  {
    en: "Unauthorized",
    ar: "غير مصرح",
    fr: "Non autorisé",
  },
  {
    en: "Forbidden",
    ar: "ممنوع",
    fr: "Interdit",
  },
  {
    en: "Owners cannot delete records",
    ar: "لا يمكن للمالكين حذف السجلات",
    fr: "Les propriétaires ne peuvent pas supprimer des enregistrements",
  },
  {
    en: "POS users cannot delete records",
    ar: "لا يمكن لمستخدمي نقاط البيع حذف السجلات",
    fr: "Les utilisateurs du point de vente ne peuvent pas supprimer des enregistrements",
  },
  {
    en: "This manager account does not have delete permission",
    ar: "حساب المدير هذا لا يملك صلاحية الحذف",
    fr: "Ce compte gestionnaire ne dispose pas de l’autorisation de suppression",
  },
  {
    en: "You do not have permission to delete records",
    ar: "ليست لديك صلاحية حذف السجلات",
    fr: "Vous n’êtes pas autorisé à supprimer des enregistrements",
  },
  {
    en: "You can only create or modify records for today's date",
    ar: "يمكنك إنشاء السجلات أو تعديلها لتاريخ اليوم فقط",
    fr: "Vous ne pouvez créer ou modifier les enregistrements que pour la date du jour",
  },
  {
    en: "You can only modify records within ${editDays} day(s) of today",
    ar: "يمكنك تعديل السجلات خلال {0} يوم فقط من تاريخ اليوم",
    fr: "Vous ne pouvez modifier les enregistrements que dans les {0} jour(s) autour d’aujourd’hui",
  },
  {
    en: "You can only access data for your assigned locations",
    ar: "يمكنك الوصول إلى بيانات المواقع المعيّنة لك فقط",
    fr: "Vous ne pouvez accéder qu’aux données de vos emplacements attribués",
  },
  {
    en: "View Only accounts cannot make changes",
    ar: "لا يمكن لحسابات العرض فقط إجراء تغييرات",
    fr: "Les comptes en lecture seule ne peuvent pas effectuer de modifications",
  },
  {
    en: "voucherDate must be a valid YYYY-MM-DD date",
    ar: "يجب أن يكون تاريخ السند تاريخًا صالحًا بالتنسيق YYYY-MM-DD",
    fr: "La date du bon doit être une date valide au format YYYY-MM-DD",
  },
  {
    en: "Deleted stock adjustments cannot be changed",
    ar: "لا يمكن تغيير تسويات المخزون المحذوفة",
    fr: "Les ajustements de stock supprimés ne peuvent pas être modifiés",
  },
  {
    en: "Invalid stock adjustment data",
    ar: "بيانات تسوية المخزون غير صالحة",
    fr: "Données d’ajustement de stock non valides",
  },
];
