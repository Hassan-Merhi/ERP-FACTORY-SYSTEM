import type { ApplicationLanguage } from "@shared/applicationLanguageContract";
import { canonicalEnglishLabels } from "./canonicalEnglishLabels";

export const applicationTranslations = {
  "language.label": { en: "Language", ar: "اللغة", fr: "Langue" },
  "language.english": { en: "English", ar: "الإنجليزية", fr: "Anglais" },
  "language.arabic": { en: "Arabic", ar: "العربية", fr: "Arabe" },
  "language.french": { en: "French", ar: "الفرنسية", fr: "Français" },
  "language.saving": { en: "Saving language…", ar: "جارٍ حفظ اللغة…", fr: "Enregistrement de la langue…" },
  "language.saveFailed": {
    en: "The language changed on this device, but the account preference could not be saved.",
    ar: "تم تغيير اللغة على هذا الجهاز، لكن تعذر حفظ تفضيل الحساب.",
    fr: "La langue a été modifiée sur cet appareil, mais la préférence du compte n’a pas pu être enregistrée.",
  },
  "language.changed": {
    en: "Application language changed to English.",
    ar: "تم تغيير لغة التطبيق إلى العربية.",
    fr: "La langue de l’application est maintenant le français.",
  },
  "accessibility.skipToMainContent": {
    en: "Skip to main content",
    ar: "الانتقال إلى المحتوى الرئيسي",
    fr: "Aller au contenu principal",
  },
  "accessibility.openSearch": { en: "Open search", ar: "فتح البحث", fr: "Ouvrir la recherche" },
  "accessibility.openWorkspaceControls": {
    en: "Open account and display controls",
    ar: "فتح عناصر التحكم بالحساب والعرض",
    fr: "Ouvrir les commandes du compte et de l’affichage",
  },
  "accessibility.toggleSidebar": {
    en: "Toggle Sidebar",
    ar: "فتح أو إغلاق شريط التنقل الجانبي",
    fr: "Afficher ou masquer la barre de navigation",
  },
  "accessibility.sidebar": { en: "Sidebar", ar: "شريط التنقل الجانبي", fr: "Barre de navigation" },
  "accessibility.sidebarDescription": {
    en: "Displays the mobile sidebar.",
    ar: "يعرض شريط التنقل الجانبي على الهاتف.",
    fr: "Affiche la barre de navigation sur mobile.",
  },
  "accessibility.closeDialog": { en: "Close dialog", ar: "إغلاق مربع الحوار", fr: "Fermer la boîte de dialogue" },
  "accessibility.closePanel": { en: "Close panel", ar: "إغلاق اللوحة", fr: "Fermer le panneau" },
  "workspace.controls": {
    en: "Workspace controls",
    ar: "عناصر تحكم مساحة العمل",
    fr: "Commandes de l’espace de travail",
  },
  "workspace.controlsDescription": {
    en: "Account, display, synchronization, language, and search controls.",
    ar: "عناصر تحكم الحساب والعرض والمزامنة واللغة والبحث.",
    fr: "Commandes du compte, de l’affichage, de la synchronisation, de la langue et de la recherche.",
  },
  "workspace.search": {
    en: "Search the workspace",
    ar: "البحث في مساحة العمل",
    fr: "Rechercher dans l’espace de travail",
  },
  "workspace.statusDisplay": { en: "Status and display", ar: "الحالة والعرض", fr: "État et affichage" },
  "workspace.pendingSync": { en: "Pending synchronization", ar: "المزامنة المعلّقة", fr: "Synchronisation en attente" },
  "workspace.theme": { en: "Theme", ar: "المظهر", fr: "Thème" },
  "workspace.accountLanguage": { en: "Account and language", ar: "الحساب واللغة", fr: "Compte et langue" },
  "company.loadingSelector": {
    en: "Loading company selector",
    ar: "جارٍ تحميل محدد الشركة",
    fr: "Chargement du sélecteur de société",
  },
  "company.current": { en: "Current company", ar: "الشركة الحالية", fr: "Société actuelle" },
  "company.openSwitcher": { en: "Open company switcher", ar: "فتح مبدّل الشركة", fr: "Ouvrir le sélecteur de société" },
  "user.menu": { en: "Account menu", ar: "قائمة الحساب", fr: "Menu du compte" },
  "common.logout": { en: "Log out", ar: "تسجيل الخروج", fr: "Se déconnecter" },
  "common.refresh": { en: "Refresh", ar: "تحديث", fr: "Actualiser" },
  "common.updateAvailable": { en: "Update available", ar: "يتوفر تحديث", fr: "Mise à jour disponible" },
  "common.updateDescription": {
    en: "A new version of the app is ready.",
    ar: "نسخة جديدة من التطبيق جاهزة.",
    fr: "Une nouvelle version de l’application est prête.",
  },

  "containerVerification.itemsRefreshed": {
    en: "Container items refreshed",
    ar: "تم تحديث عناصر الحاوية",
    fr: "Articles du conteneur actualisés",
  },
  "containerVerification.latestDetailsLoaded": {
    en: "${data.imported} current item lines loaded from the latest container details${skippedMsg}",
    ar: "تم تحميل ${data.imported} من بنود العناصر الحالية من أحدث تفاصيل الحاوية${skippedMsg}",
    fr: "${data.imported} lignes d’articles actuelles chargées depuis les derniers détails du conteneur${skippedMsg}",
  },
  "containerVerification.refreshNeedsConnection": {
    en: "Refresh requires a connection",
    ar: "يتطلب التحديث اتصالاً بالشبكة",
    fr: "L’actualisation nécessite une connexion",
  },
  "factoryAdvances.netDue": { en: "Net Due", ar: "صافي المستحق", fr: "Net dû" },
  "accountMigration.returnFailed": {
    en: "Account return migration failed",
    ar: "فشلت إعادة ترحيل الحساب",
    fr: "Échec du retour de migration du compte",
  },

  "settings.dataTools.costOverride.title": {
    en: "Location Cost Price Override",
    ar: "تعديل تكلفة المخزون حسب الموقع",
    fr: "Remplacement du coût par emplacement",
  },
  "settings.dataTools.costOverride.description": {
    en: "Directly replace the average cost for existing inventory at one location. Developer use only; no voucher or daybook entry is created.",
    ar: "استبدال متوسط تكلفة المخزون الحالي مباشرةً في موقع واحد. للمطور فقط، من دون إنشاء سند أو قيد يومية.",
    fr: "Remplace directement le coût moyen du stock existant dans un emplacement. Réservé au développeur, sans création de pièce ni d’écriture de journal.",
  },
  "settings.dataTools.costOverride.selectLocation": {
    en: "Select Location",
    ar: "اختر الموقع",
    fr: "Sélectionner l’emplacement",
  },
  "settings.dataTools.costOverride.chooseLocation": {
    en: "Choose location...",
    ar: "اختر موقعاً...",
    fr: "Choisir un emplacement...",
  },
  "settings.dataTools.costOverride.openButton": {
    en: "Update Location Costs from Excel",
    ar: "تحديث تكاليف الموقع من Excel",
    fr: "Mettre à jour les coûts depuis Excel",
  },
  "settings.dataTools.costOverride.dialogDescription": {
    en: "Upload an Excel file with barcode and costPrice columns. This directly overwrites the selected location's current average rate and total value.",
    ar: "حمّل ملف Excel يحتوي على عمودي barcode و costPrice. سيستبدل ذلك مباشرةً متوسط السعر والقيمة الإجمالية الحالية للموقع المحدد.",
    fr: "Importez un fichier Excel avec les colonnes barcode et costPrice. Cette opération remplace directement le coût moyen et la valeur totale actuels de l’emplacement sélectionné.",
  },
  "settings.dataTools.costOverride.success": {
    en: "Location cost prices were updated successfully.",
    ar: "تم تحديث تكاليف الموقع بنجاح.",
    fr: "Les coûts de l’emplacement ont été mis à jour.",
  },
  "settings.dataTools.costOverride.close": { en: "Close", ar: "إغلاق", fr: "Fermer" },
  "settings.dataTools.costOverride.warning": {
    en: "This is a direct valuation correction. It does not create accounting entries and should not be used for normal stock receipts or production.",
    ar: "هذا تصحيح مباشر للتقييم ولا ينشئ قيوداً محاسبية. لا تستخدمه لاستلامات المخزون أو الإنتاج العادي.",
    fr: "Il s’agit d’une correction directe de valorisation. Elle ne crée aucune écriture comptable et ne doit pas servir aux réceptions ou à la production normales.",
  },
  "settings.dataTools.costOverride.downloadTemplate": {
    en: "Download Template",
    ar: "تنزيل القالب",
    fr: "Télécharger le modèle",
  },
  "settings.dataTools.costOverride.excelFile": { en: "Excel File", ar: "ملف Excel", fr: "Fichier Excel" },
  "settings.dataTools.costOverride.fileHint": {
    en: "Each row must contain a matching item barcode and a costPrice greater than 0.",
    ar: "يجب أن يحتوي كل صف على باركود صنف مطابق وcostPrice أكبر من صفر.",
    fr: "Chaque ligne doit contenir un code-barres correspondant et un costPrice supérieur à 0.",
  },
  "settings.dataTools.costOverride.barcode": { en: "Barcode", ar: "الباركود", fr: "Code-barres" },
  "settings.dataTools.costOverride.newCost": { en: "New Cost", ar: "التكلفة الجديدة", fr: "Nouveau coût" },
  "settings.dataTools.costOverride.updatesReady": {
    en: "cost updates ready",
    ar: "تحديث تكلفة جاهز",
    fr: "mises à jour de coût prêtes",
  },
  "settings.dataTools.costOverride.cancel": { en: "Cancel", ar: "إلغاء", fr: "Annuler" },
  "settings.dataTools.costOverride.updating": { en: "Updating…", ar: "جارٍ التحديث…", fr: "Mise à jour…" },
  "settings.dataTools.costOverride.apply": {
    en: "Apply Cost Updates",
    ar: "تطبيق تحديثات التكلفة",
    fr: "Appliquer les mises à jour",
  },
  "settings.dataTools.costOverride.templateDownloaded": {
    en: "Template Downloaded",
    ar: "تم تنزيل القالب",
    fr: "Modèle téléchargé",
  },
  "settings.dataTools.costOverride.templateDownloadedDescription": {
    en: "Use this template to update cost prices.",
    ar: "استخدم هذا القالب لتحديث تكاليف الأصناف.",
    fr: "Utilisez ce modèle pour mettre à jour les coûts.",
  },
  "settings.dataTools.costOverride.emptyFile": { en: "Empty File", ar: "ملف فارغ", fr: "Fichier vide" },
  "settings.dataTools.costOverride.emptyFileDescription": {
    en: "The Excel file is empty.",
    ar: "ملف Excel فارغ.",
    fr: "Le fichier Excel est vide.",
  },
  "settings.dataTools.costOverride.missingColumns": {
    en: "Missing Required Columns",
    ar: "أعمدة مطلوبة مفقودة",
    fr: "Colonnes requises manquantes",
  },
  "settings.dataTools.costOverride.missingColumnsDescription": {
    en: "Expected barcode and costPrice columns. Download the template for the required format.",
    ar: "يجب أن يتضمن الملف عمودي barcode وcostPrice. نزّل القالب لمعرفة التنسيق المطلوب.",
    fr: "Les colonnes barcode et costPrice sont requises. Téléchargez le modèle pour le format attendu.",
  },
  "settings.dataTools.costOverride.row": { en: "Row", ar: "الصف", fr: "Ligne" },
  "settings.dataTools.costOverride.barcodeRequired": {
    en: "Barcode is required",
    ar: "الباركود مطلوب",
    fr: "Le code-barres est requis",
  },
  "settings.dataTools.costOverride.costPositive": {
    en: "Cost price must be greater than 0",
    ar: "يجب أن تكون التكلفة أكبر من صفر",
    fr: "Le coût doit être supérieur à 0",
  },
  "settings.dataTools.costOverride.readError": {
    en: "Error Reading File",
    ar: "خطأ في قراءة الملف",
    fr: "Erreur de lecture du fichier",
  },
  "settings.dataTools.costOverride.readErrorDescription": {
    en: "Please ensure the file is a valid Excel file.",
    ar: "تأكد من أن الملف ملف Excel صالح.",
    fr: "Vérifiez que le fichier est un fichier Excel valide.",
  },
  "settings.dataTools.costOverride.noLocation": {
    en: "No Location Selected",
    ar: "لم يتم اختيار موقع",
    fr: "Aucun emplacement sélectionné",
  },
  "settings.dataTools.costOverride.noLocationDescription": {
    en: "Please select a location first.",
    ar: "اختر موقعاً أولاً.",
    fr: "Sélectionnez d’abord un emplacement.",
  },
  "settings.dataTools.costOverride.cannotImport": {
    en: "Cannot Import",
    ar: "تعذر الاستيراد",
    fr: "Importation impossible",
  },
  "settings.dataTools.costOverride.fixErrors": {
    en: "Please fix validation errors first.",
    ar: "صحح أخطاء التحقق أولاً.",
    fr: "Corrigez d’abord les erreurs de validation.",
  },
  "settings.dataTools.costOverride.importSuccessful": {
    en: "Import Successful",
    ar: "تم الاستيراد بنجاح",
    fr: "Importation réussie",
  },
  "settings.dataTools.costOverride.updatedPrefix": {
    en: "Updated cost prices:",
    ar: "عدد التكاليف المحدّثة:",
    fr: "Coûts mis à jour :",
  },
  "settings.dataTools.costOverride.importFailed": {
    en: "Import Failed",
    ar: "فشل الاستيراد",
    fr: "Échec de l’importation",
  },
  "settings.dataTools.costOverride.importFailedDescription": {
    en: "Failed to import cost prices.",
    ar: "تعذر استيراد تكاليف الأصناف.",
    fr: "Impossible d’importer les coûts.",
  },
  "common.search": { en: "Search...", ar: "بحث...", fr: "Rechercher..." },
  "common.filter": { en: "Filter", ar: "تصفية", fr: "Filtrer" },
  "common.actions": { en: "Actions", ar: "الإجراءات", fr: "Actions" },
  "common.export": { en: "Export", ar: "تصدير", fr: "Exporter" },
  "common.today": { en: "Today", ar: "اليوم", fr: "Aujourd’hui" },
  "common.yesterday": { en: "Yesterday", ar: "أمس", fr: "Hier" },
  "common.allTime": { en: "All Time", ar: "كل الوقت", fr: "Toute la période" },
  "common.thisWeek": { en: "This Week", ar: "هذا الأسبوع", fr: "Cette semaine" },
  "common.thisMonth": { en: "This Month", ar: "هذا الشهر", fr: "Ce mois-ci" },
  "common.lastMonth": { en: "Last 1 Month", ar: "آخر شهر", fr: "Le dernier mois" },
  "common.lastSixMonths": { en: "Last 6 Months", ar: "آخر 6 أشهر", fr: "Les 6 derniers mois" },
  "common.thisYear": { en: "This Year", ar: "هذه السنة", fr: "Cette année" },
  "common.customRange": { en: "Custom Range...", ar: "نطاق مخصص...", fr: "Période personnalisée..." },
  "common.allTypes": { en: "All Types", ar: "كل الأنواع", fr: "Tous les types" },
  "common.allEntries": { en: "All Entries", ar: "كل القيود", fr: "Toutes les écritures" },
  "common.active": { en: "Active", ar: "نشط", fr: "Actif" },
  "common.inactive": { en: "Inactive", ar: "غير نشط", fr: "Inactif" },
  "common.total": { en: "Total", ar: "الإجمالي", fr: "Total" },
  "common.status": { en: "Status", ar: "الحالة", fr: "Statut" },
  "common.count": { en: "Count", ar: "العدد", fr: "Nombre" },
  "common.dateType": { en: "DATE / TYPE", ar: "التاريخ / النوع", fr: "DATE / TYPE" },

  "factory.overview": { en: "Overview", ar: "نظرة عامة", fr: "Aperçu" },
  "factory.overviewDescription": {
    en: "Manufacturing overview — output metrics & bale lifecycle",
    ar: "نظرة عامة على التصنيع — مؤشرات الإنتاج ودورة حياة البالات",
    fr: "Vue d’ensemble de la fabrication — indicateurs de production et cycle de vie des balles",
  },
  "factory.otwTracking": { en: "OTW Tracking", ar: "تتبع البضاعة في الطريق", fr: "Suivi en transit" },
  "factory.production": { en: "Production", ar: "الإنتاج", fr: "Production" },
  "factory.comparison": { en: "Comparison", ar: "المقارنة", fr: "Comparaison" },
  "factory.baleLedger": { en: "Bale Ledger", ar: "سجل البالات", fr: "Grand livre des balles" },
  "factory.shippingContainers": { en: "Shipping Containers", ar: "حاويات الشحن", fr: "Conteneurs d’expédition" },
  "factory.byGrade": { en: "BY GRADE", ar: "حسب الدرجة", fr: "PAR QUALITÉ" },
  "factory.productionValue": { en: "PRODUCTION VALUE", ar: "قيمة الإنتاج", fr: "VALEUR DE PRODUCTION" },
  "factory.batchCost": { en: "BATCH COST", ar: "تكلفة الدفعة", fr: "COÛT DU LOT" },
  "factory.productions": { en: "Productions", ar: "الإنتاج", fr: "Productions" },
  "factory.originalBatches": { en: "Original Batches", ar: "الدفعات الأصلية", fr: "Lots d’origine" },
  "factory.payrollOverview": { en: "PAYROLL OVERVIEW", ar: "نظرة عامة على الرواتب", fr: "APERÇU DE LA PAIE" },
  "factory.workersTransport": { en: "WORKERS + TRANSPORT", ar: "العمال + النقل", fr: "TRAVAILLEURS + TRANSPORT" },
  "factory.workerRemaining": { en: "WORKER REMAINING", ar: "المتبقي للعمال", fr: "RESTE AUX TRAVAILLEURS" },
  "factory.totalPayroll": { en: "TOTAL PAYROLL", ar: "إجمالي الرواتب", fr: "PAIE TOTALE" },
  "factory.employeeExpected": { en: "EMPLOYEE EXPECTED", ar: "المتوقع للموظفين", fr: "PRÉVU POUR LES EMPLOYÉS" },

  "daybook.transactions": { en: "Transactions", ar: "المعاملات", fr: "Transactions" },
  "daybook.editsActivity": { en: "Edits & Activity", ar: "التعديلات والنشاط", fr: "Modifications et activité" },
  "daybook.allFactoryTransactions": {
    en: "All factory transactions in one view",
    ar: "جميع معاملات المصنع في عرض واحد",
    fr: "Toutes les transactions de l’usine dans une seule vue",
  },

  "settings.usersPermissions": {
    en: "Users & Permissions",
    ar: "المستخدمون والصلاحيات",
    fr: "Utilisateurs et autorisations",
  },
  "settings.manageUsersRoles": {
    en: "Manage users and role assignments.",
    ar: "إدارة المستخدمين وتعيينات الأدوار.",
    fr: "Gérez les utilisateurs et l’attribution des rôles.",
  },
  "settings.userManagement": { en: "User Management", ar: "إدارة المستخدمين", fr: "Gestion des utilisateurs" },
  "settings.selectUser": {
    en: "Select a user to manage their account, access, and permissions.",
    ar: "اختر مستخدمًا لإدارة حسابه ووصوله وصلاحياته.",
    fr: "Sélectionnez un utilisateur pour gérer son compte, ses accès et ses autorisations.",
  },
  "settings.addUser": { en: "Add User", ar: "إضافة مستخدم", fr: "Ajouter un utilisateur" },
  "settings.fullAccess": { en: "Full access", ar: "وصول كامل", fr: "Accès complet" },

  "payroll.title": { en: "Payroll & Benefits", ar: "الرواتب والمزايا", fr: "Paie et avantages" },
  "payroll.description": {
    en: "Workers, employees and insurance management",
    ar: "إدارة العمال والموظفين والتأمين",
    fr: "Gestion des travailleurs, employés et assurances",
  },
  "payroll.workers": { en: "Workers", ar: "العمال", fr: "Travailleurs" },
  "payroll.employees": { en: "Employees", ar: "الموظفون", fr: "Employés" },
  "payroll.insurance": { en: "Insurance", ar: "التأمين", fr: "Assurance" },
  "payroll.categories": { en: "Categories", ar: "الفئات", fr: "Catégories" },
  "payroll.totalSalary": { en: "Total Salary", ar: "إجمالي الرواتب", fr: "Salaire total" },
  "payroll.transport": { en: "Transport", ar: "النقل", fr: "Transport" },
  "payroll.advances": { en: "Advances", ar: "السلف", fr: "Avances" },
  "payroll.dueToday": { en: "Due Today", ar: "المستحق اليوم", fr: "Dû aujourd’hui" },
  "payroll.totalRemaining": { en: "Total Remaining", ar: "إجمالي المتبقي", fr: "Total restant" },
  "payroll.searchPlaceholder": {
    en: "Search by name, code, position, nationality...",
    ar: "البحث بالاسم أو الرمز أو المنصب أو الجنسية...",
    fr: "Rechercher par nom, code, poste ou nationalité...",
  },
  "payroll.addWorker": { en: "Add Worker", ar: "إضافة عامل", fr: "Ajouter un travailleur" },
  "payroll.worker": { en: "WORKER", ar: "العامل", fr: "TRAVAILLEUR" },
  "payroll.position": { en: "POSITION", ar: "المنصب", fr: "POSTE" },
  "payroll.nationality": { en: "NATIONALITY", ar: "الجنسية", fr: "NATIONALITÉ" },
  "payroll.location": { en: "LOCATION", ar: "الموقع", fr: "EMPLACEMENT" },
  "payroll.salary": { en: "SALARY", ar: "الراتب", fr: "SALAIRE" },
  "payroll.advance": { en: "ADVANCE", ar: "السلفة", fr: "AVANCE" },
  "payroll.dueTodayHeader": { en: "DUE TODAY", ar: "المستحق اليوم", fr: "DÛ AUJOURD’HUI" },
  "payroll.dueMinusAdvance": { en: "DUE − ADV", ar: "المستحق − السلفة", fr: "DÛ − AVANCE" },

  "pos.pointOfSale": { en: "Point of Sale", ar: "نقطة البيع", fr: "Point de vente" },
  "pos.dailyBook": { en: "Daily Book", ar: "دفتر اليومية", fr: "Livre journalier" },
  "pos.inventory": { en: "Inventory", ar: "المخزون", fr: "Stock" },
  "pos.priceList": { en: "Price List", ar: "قائمة الأسعار", fr: "Liste des prix" },
  "pos.transfer": { en: "Transfer", ar: "التحويل", fr: "Transfert" },
  "pos.orders": { en: "Orders", ar: "الطلبات", fr: "Commandes" },
  "pos.settings": { en: "Settings", ar: "الإعدادات", fr: "Paramètres" },
  "pos.stockTransfer": { en: "Stock Transfer", ar: "تحويل المخزون", fr: "Transfert de stock" },
  "pos.stockTransferDescription": {
    en: "Transfer stock between locations",
    ar: "نقل المخزون بين المواقع",
    fr: "Transférer le stock entre les emplacements",
  },
  "pos.from": { en: "From", ar: "من", fr: "De" },
  "pos.to": { en: "To", ar: "إلى", fr: "Vers" },
  "pos.date": { en: "Date", ar: "التاريخ", fr: "Date" },
  "pos.selectDestination": { en: "Select destination...", ar: "اختر الوجهة...", fr: "Sélectionner la destination..." },
  "pos.item": { en: "Item", ar: "الصنف", fr: "Article" },
  "pos.quantity": { en: "Quantity", ar: "الكمية", fr: "Quantité" },
  "pos.typeToSearch": { en: "Type to search...", ar: "اكتب للبحث...", fr: "Saisir pour rechercher..." },
  "pos.totalQty": { en: "Total Qty", ar: "إجمالي الكمية", fr: "Quantité totale" },
  "pos.totalItems": { en: "Total Items", ar: "إجمالي الأصناف", fr: "Total des articles" },
  "pos.notesOptional": { en: "Notes (optional)", ar: "ملاحظات (اختياري)", fr: "Notes (facultatif)" },
  "pos.optional": { en: "Optional", ar: "اختياري", fr: "Facultatif" },
  "pos.saveTransfer": { en: "Save Transfer", ar: "حفظ التحويل", fr: "Enregistrer le transfert" },
  "pos.export": { en: "Export", ar: "تصدير", fr: "Exporter" },
} as const satisfies Record<string, Record<ApplicationLanguage, string>>;

export type ApplicationTranslationKey = keyof typeof applicationTranslations;

export function translateApplicationText(key: ApplicationTranslationKey, language: ApplicationLanguage): string {
  const entry = applicationTranslations[key];
  return entry[language] || entry.en || key;
}

type ApplicationTranslationEntry = Record<ApplicationLanguage, string>;

const applicationEntryByVisibleText = new Map<string, ApplicationTranslationEntry>();

// Canonical English labels must win over translated aliases that happen to use
// the same visible spelling. For example, the French text for "Inventory" is
// "Stock", which previously matched the English "Stock" nav item first and
// rendered it as "Inventory" — showing two "Inventory" entries in the sidebar.
{
  const entries = Object.values(applicationTranslations) as readonly ApplicationTranslationEntry[];
  for (const entry of entries) {
    if (!applicationEntryByVisibleText.has(entry.en)) applicationEntryByVisibleText.set(entry.en, entry);
  }
  const registerAlias = (alias: string, entry: ApplicationTranslationEntry) => {
    if (applicationEntryByVisibleText.has(alias)) return;
    // Never let an alias shadow an English label another dictionary owns.
    if (alias !== entry.en && canonicalEnglishLabels.has(alias)) return;
    applicationEntryByVisibleText.set(alias, entry);
  };
  for (const entry of entries) {
    registerAlias(entry.ar, entry);
    registerAlias(entry.fr, entry);
  }
}

export function translateApplicationLiteral(value: string, language: ApplicationLanguage): string | null {
  const leading = value.match(/^\s*/)?.[0] ?? "";
  const trailing = value.match(/\s*$/)?.[0] ?? "";
  const normalized = value.trim();
  if (!normalized) return null;

  const entry = applicationEntryByVisibleText.get(normalized);
  return entry ? `${leading}${entry[language]}${trailing}` : null;
}
