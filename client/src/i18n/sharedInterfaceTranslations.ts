import type { ApplicationLanguage } from "@shared/applicationLanguageContract";

type SharedEntry = Record<ApplicationLanguage, string>;

/**
 * Exact approved interface labels used by the compatibility translator.
 * These entries are UI chrome only. Stored names, codes, references and free-form
 * business values are intentionally absent and remain protected by the translator.
 */
export const sharedInterfaceTranslations: SharedEntry[] = [
  // Shared navigation and modules
  { en: "Dashboard", ar: "لوحة التحكم", fr: "Tableau de bord" },
  { en: "Overview", ar: "نظرة عامة", fr: "Aperçu" },
  { en: "Inventory", ar: "الجرد", fr: "Inventaire" },
  { en: "Stock", ar: "المخزون", fr: "Stock" },
  { en: "Location Inventory", ar: "مخزون المواقع", fr: "Stock par emplacement" },
  { en: "Stock Items", ar: "أصناف المخزون", fr: "Articles en stock" },
  { en: "Stock Groups", ar: "مجموعات المخزون", fr: "Groupes de stock" },
  { en: "Stock Movements", ar: "حركات المخزون", fr: "Mouvements de stock" },
  { en: "Stock Transfers", ar: "تحويلات المخزون", fr: "Transferts de stock" },
  { en: "Transfer Orders", ar: "أوامر التحويل", fr: "Ordres de transfert" },
  { en: "Sales", ar: "المبيعات", fr: "Ventes" },
  { en: "Sales Orders", ar: "أوامر البيع", fr: "Commandes clients" },
  { en: "Sales Report", ar: "تقرير المبيعات", fr: "Rapport des ventes" },
  { en: "Purchases", ar: "المشتريات", fr: "Achats" },
  { en: "Purchase Orders", ar: "أوامر الشراء", fr: "Commandes fournisseurs" },
  { en: "Accounting", ar: "المحاسبة", fr: "Comptabilité" },
  { en: "Accounts", ar: "الحسابات", fr: "Comptes" },
  { en: "Account Groups", ar: "مجموعات الحسابات", fr: "Groupes de comptes" },
  { en: "Daybook", ar: "دفتر اليومية", fr: "Journal" },
  { en: "Vouchers", ar: "السندات", fr: "Pièces comptables" },
  { en: "Reports", ar: "التقارير", fr: "Rapports" },
  { en: "Customers", ar: "العملاء", fr: "Clients" },
  { en: "Suppliers", ar: "الموردون", fr: "Fournisseurs" },
  { en: "Supplier Partner", ar: "شريك المورد", fr: "Partenaire fournisseur" },
  { en: "Containers", ar: "الحاويات", fr: "Conteneurs" },
  { en: "Container Tracking", ar: "تتبع الحاويات", fr: "Suivi des conteneurs" },
  { en: "Containers on the Way", ar: "الحاويات في الطريق", fr: "Conteneurs en route" },
  { en: "Factory", ar: "المصنع", fr: "Usine" },
  { en: "Production", ar: "الإنتاج", fr: "Production" },
  { en: "Raw Stock", ar: "المخزون الخام", fr: "Stock de matières premières" },
  { en: "Mix Batches", ar: "الدفعات المختلطة", fr: "Lots mélangés" },
  { en: "Bales", ar: "البالات", fr: "Balles" },
  { en: "Bale Products", ar: "منتجات البالات", fr: "Produits en balles" },
  { en: "Categories", ar: "الفئات", fr: "Catégories" },
  { en: "Offloading", ar: "التفريغ", fr: "Déchargement" },
  { en: "Loading", ar: "التحميل", fr: "Chargement" },
  { en: "Customer Orders", ar: "طلبات العملاء", fr: "Commandes clients" },
  { en: "Customer Proformas", ar: "الفواتير الأولية للعملاء", fr: "Proformas clients" },
  { en: "Sheets & Sacks", ar: "الأغطية والأكياس", fr: "Feuilles et sacs" },
  { en: "Workers", ar: "العمال", fr: "Travailleurs" },
  { en: "Payroll", ar: "الرواتب", fr: "Paie" },
  { en: "Properties", ar: "العقارات", fr: "Propriétés" },
  { en: "Units", ar: "الوحدات", fr: "Unités" },
  { en: "Tenants", ar: "المستأجرون", fr: "Locataires" },
  { en: "Rent Payments", ar: "دفعات الإيجار", fr: "Paiements de loyer" },
  { en: "Rent Payable", ar: "الإيجار المستحق", fr: "Loyers à payer" },
  { en: "Leases", ar: "عقود الإيجار", fr: "Baux" },
  { en: "Settings", ar: "الإعدادات", fr: "Paramètres" },
  { en: "Users", ar: "المستخدمون", fr: "Utilisateurs" },
  { en: "User Management", ar: "إدارة المستخدمين", fr: "Gestion des utilisateurs" },
  { en: "Permissions", ar: "الصلاحيات", fr: "Autorisations" },
  { en: "Roles", ar: "الأدوار", fr: "Rôles" },
  { en: "Company Settings", ar: "إعدادات الشركة", fr: "Paramètres de l’entreprise" },
  { en: "POS Settings", ar: "إعدادات نقطة البيع", fr: "Paramètres du point de vente" },
  { en: "Login History", ar: "سجل تسجيل الدخول", fr: "Historique de connexion" },
  { en: "Active Users", ar: "المستخدمون النشطون", fr: "Utilisateurs actifs" },
  { en: "Offline Sync", ar: "المزامنة دون اتصال", fr: "Synchronisation hors ligne" },

  // POS
  { en: "Point of Sale", ar: "نقطة البيع", fr: "Point de vente" },
  { en: "New Sale", ar: "بيع جديد", fr: "Nouvelle vente" },
  { en: "Cart", ar: "السلة", fr: "Panier" },
  { en: "Checkout", ar: "إتمام البيع", fr: "Encaisser" },
  { en: "Hold Sale", ar: "تعليق البيع", fr: "Mettre la vente en attente" },
  { en: "Held Sales", ar: "المبيعات المعلقة", fr: "Ventes en attente" },
  { en: "Recent Sales", ar: "المبيعات الأخيرة", fr: "Ventes récentes" },
  { en: "Payment Method", ar: "طريقة الدفع", fr: "Mode de paiement" },
  { en: "Cash", ar: "نقدي", fr: "Espèces" },
  { en: "Credit", ar: "آجل", fr: "Crédit" },
  { en: "Amount Paid", ar: "المبلغ المدفوع", fr: "Montant payé" },
  { en: "Balance Due", ar: "الرصيد المستحق", fr: "Solde dû" },
  { en: "Complete Sale", ar: "إتمام البيع", fr: "Finaliser la vente" },
  { en: "Void Sale", ar: "إلغاء البيع", fr: "Annuler la vente" },
  { en: "Receipt", ar: "الإيصال", fr: "Reçu" },
  { en: "Print Receipt", ar: "طباعة الإيصال", fr: "Imprimer le reçu" },

  // Shared actions and filters
  { en: "Search", ar: "بحث", fr: "Rechercher" },
  { en: "Search items", ar: "بحث عن الأصناف", fr: "Rechercher des articles" },
  { en: "Search customers", ar: "بحث عن العملاء", fr: "Rechercher des clients" },
  { en: "Search suppliers", ar: "بحث عن الموردين", fr: "Rechercher des fournisseurs" },
  { en: "Filter", ar: "تصفية", fr: "Filtrer" },
  { en: "Filters", ar: "عوامل التصفية", fr: "Filtres" },
  { en: "Clear Filters", ar: "مسح عوامل التصفية", fr: "Effacer les filtres" },
  { en: "Apply Filters", ar: "تطبيق عوامل التصفية", fr: "Appliquer les filtres" },
  { en: "All", ar: "الكل", fr: "Tous" },
  { en: "Active", ar: "نشط", fr: "Actif" },
  { en: "Inactive", ar: "غير نشط", fr: "Inactif" },
  { en: "Pending", ar: "قيد الانتظار", fr: "En attente" },
  { en: "Completed", ar: "مكتمل", fr: "Terminé" },
  { en: "Cancelled", ar: "ملغى", fr: "Annulé" },
  { en: "Draft", ar: "مسودة", fr: "Brouillon" },
  { en: "Approved", ar: "موافق عليه", fr: "Approuvé" },
  { en: "Rejected", ar: "مرفوض", fr: "Rejeté" },
  { en: "In Transit", ar: "قيد النقل", fr: "En transit" },
  { en: "Offloaded", ar: "تم التفريغ", fr: "Déchargé" },
  { en: "Actions", ar: "الإجراءات", fr: "Actions" },
  { en: "Add", ar: "إضافة", fr: "Ajouter" },
  { en: "Add New", ar: "إضافة جديد", fr: "Ajouter" },
  { en: "Create", ar: "إنشاء", fr: "Créer" },
  { en: "Edit", ar: "تعديل", fr: "Modifier" },
  { en: "View", ar: "عرض", fr: "Voir" },
  { en: "View Details", ar: "عرض التفاصيل", fr: "Voir les détails" },
  { en: "Delete", ar: "حذف", fr: "Supprimer" },
  { en: "Restore", ar: "استعادة", fr: "Restaurer" },
  { en: "Save", ar: "حفظ", fr: "Enregistrer" },
  { en: "Save Changes", ar: "حفظ التغييرات", fr: "Enregistrer les modifications" },
  { en: "Cancel", ar: "إلغاء", fr: "Annuler" },
  { en: "Close", ar: "إغلاق", fr: "Fermer" },
  { en: "Confirm", ar: "تأكيد", fr: "Confirmer" },
  { en: "Continue", ar: "متابعة", fr: "Continuer" },
  { en: "Back", ar: "رجوع", fr: "Retour" },
  { en: "Next", ar: "التالي", fr: "Suivant" },
  { en: "Previous", ar: "السابق", fr: "Précédent" },
  { en: "Refresh", ar: "تحديث", fr: "Actualiser" },
  { en: "Recalculate", ar: "إعادة الحساب", fr: "Recalculer" },
  { en: "Export", ar: "تصدير", fr: "Exporter" },
  { en: "Export Excel", ar: "تصدير Excel", fr: "Exporter vers Excel" },
  { en: "Import", ar: "استيراد", fr: "Importer" },
  { en: "Print", ar: "طباعة", fr: "Imprimer" },
  { en: "Download", ar: "تنزيل", fr: "Télécharger" },
  { en: "Upload", ar: "رفع", fr: "Téléverser" },
  { en: "Preview", ar: "معاينة", fr: "Aperçu" },
  { en: "Submit", ar: "إرسال", fr: "Envoyer" },
  { en: "Reset", ar: "إعادة تعيين", fr: "Réinitialiser" },

  // Shared fields and table headings
  { en: "Date", ar: "التاريخ", fr: "Date" },
  { en: "From Date", ar: "من تاريخ", fr: "Date de début" },
  { en: "To Date", ar: "إلى تاريخ", fr: "Date de fin" },
  { en: "Status", ar: "الحالة", fr: "Statut" },
  { en: "Name", ar: "الاسم", fr: "Nom" },
  { en: "Code", ar: "الرمز", fr: "Code" },
  { en: "Type", ar: "النوع", fr: "Type" },
  { en: "Description", ar: "الوصف", fr: "Description" },
  { en: "Category", ar: "الفئة", fr: "Catégorie" },
  { en: "Location", ar: "الموقع", fr: "Emplacement" },
  { en: "Company", ar: "الشركة", fr: "Entreprise" },
  { en: "Customer", ar: "العميل", fr: "Client" },
  { en: "Supplier", ar: "المورد", fr: "Fournisseur" },
  { en: "Product", ar: "المنتج", fr: "Produit" },
  { en: "Item", ar: "الصنف", fr: "Article" },
  { en: "Quantity", ar: "الكمية", fr: "Quantité" },
  { en: "Weight", ar: "الوزن", fr: "Poids" },
  { en: "Price", ar: "السعر", fr: "Prix" },
  { en: "Cost", ar: "التكلفة", fr: "Coût" },
  { en: "Amount", ar: "المبلغ", fr: "Montant" },
  { en: "Total", ar: "الإجمالي", fr: "Total" },
  { en: "Subtotal", ar: "المجموع الفرعي", fr: "Sous-total" },
  { en: "Discount", ar: "الخصم", fr: "Remise" },
  { en: "Tax", ar: "الضريبة", fr: "Taxe" },
  { en: "Currency", ar: "العملة", fr: "Devise" },
  { en: "Reference", ar: "المرجع", fr: "Référence" },
  { en: "Notes", ar: "ملاحظات", fr: "Notes" },
  { en: "Created At", ar: "تاريخ الإنشاء", fr: "Créé le" },
  { en: "Updated At", ar: "تاريخ التحديث", fr: "Mis à jour le" },

  // Loading, empty and validation states
  { en: "Loading…", ar: "جارٍ التحميل…", fr: "Chargement…" },
  { en: "Loading workspace", ar: "جارٍ تحميل مساحة العمل", fr: "Chargement de l’espace de travail" },
  { en: "Please wait", ar: "يرجى الانتظار", fr: "Veuillez patienter" },
  { en: "No results", ar: "لا توجد نتائج", fr: "Aucun résultat" },
  { en: "No data available", ar: "لا توجد بيانات", fr: "Aucune donnée disponible" },
  { en: "No records found", ar: "لم يتم العثور على سجلات", fr: "Aucun enregistrement trouvé" },
  { en: "Required", ar: "مطلوب", fr: "Obligatoire" },
  { en: "Select an option", ar: "اختر خيارًا", fr: "Sélectionnez une option" },
  { en: "Select customer", ar: "اختر العميل", fr: "Sélectionner un client" },
  { en: "Select supplier", ar: "اختر المورد", fr: "Sélectionner un fournisseur" },
  { en: "Select location", ar: "اختر الموقع", fr: "Sélectionner un emplacement" },
  { en: "Something went wrong", ar: "حدث خطأ ما", fr: "Une erreur s’est produite" },
  { en: "Try again", ar: "حاول مرة أخرى", fr: "Réessayer" },
  { en: "Success", ar: "تم بنجاح", fr: "Succès" },
  { en: "Error", ar: "خطأ", fr: "Erreur" },
  { en: "Warning", ar: "تحذير", fr: "Avertissement" },

  // Session and top bar
  { en: "Log out", ar: "تسجيل الخروج", fr: "Déconnexion" },
  { en: "My Settings", ar: "إعداداتي", fr: "Mes paramètres" },
  { en: "Profile", ar: "الملف الشخصي", fr: "Profil" },
  { en: "Notifications", ar: "الإشعارات", fr: "Notifications" },
  // ERP mobile filter sheets
  { en: "Daybook filters", ar: "عوامل تصفية دفتر اليومية", fr: "Filtres du journal" },
  { en: "Stock item filters", ar: "عوامل تصفية أصناف المخزون", fr: "Filtres des articles de stock" },
  { en: "Transporter statement filters", ar: "عوامل تصفية كشف حساب الناقل", fr: "Filtres du relevé transporteur" },
  { en: "All Daybook filters", ar: "عوامل تصفية دفتر اليومية الشامل", fr: "Filtres du journal global" },
  { en: "Sales report filters", ar: "عوامل تصفية تقرير المبيعات", fr: "Filtres du rapport des ventes" },
  { en: "Company comparison filters", ar: "عوامل تصفية مقارنة الشركات", fr: "Filtres de comparaison des sociétés" },
  { en: "Net profit filters", ar: "عوامل تصفية صافي الربح", fr: "Filtres du bénéfice net" },
  { en: "Optional voucher filters", ar: "عوامل تصفية القسائم الاختيارية", fr: "Filtres des bons optionnels" },
  { en: "Container filters", ar: "عوامل تصفية الحاويات", fr: "Filtres des conteneurs" },
  { en: "Stock in and sales filters", ar: "عوامل تصفية المخزون الوارد والمبيعات", fr: "Filtres des entrées et ventes" },
];

const entryByVisibleText = new Map<string, SharedEntry>();

// Canonical English labels must win over translated aliases that use the same
// visible spelling. For example, French "Stock" previously overwrote the
// English Stock route and made it render as "Inventory" in English.
for (const entry of sharedInterfaceTranslations) {
  entryByVisibleText.set(entry.en, entry);
}
for (const entry of sharedInterfaceTranslations) {
  if (!entryByVisibleText.has(entry.ar)) entryByVisibleText.set(entry.ar, entry);
  if (!entryByVisibleText.has(entry.fr)) entryByVisibleText.set(entry.fr, entry);
}

export function translateSharedInterfaceText(value: string, language: ApplicationLanguage): string | null {
  const leading = value.match(/^\s*/)?.[0] ?? "";
  const trailing = value.match(/\s*$/)?.[0] ?? "";
  const normalized = value.trim();
  if (!normalized) return null;
  const entry = entryByVisibleText.get(normalized);
  return entry ? `${leading}${entry[language]}${trailing}` : null;
}
