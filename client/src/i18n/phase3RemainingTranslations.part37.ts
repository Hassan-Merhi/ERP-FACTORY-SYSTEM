import type { Phase3SharedUiEntry } from "./sharedUiPhase3TranslationTypes";

// Permissions Control Center (shadow mode): Role Templates, User Access
// overrides, the permission change audit viewer and the server denial messages
// for Create Only and V2 business-action checks.
export const phase3RemainingTranslationsPart37: readonly Phase3SharedUiEntry[] = [
  // Role Templates matrix
  {
    en: "Role Templates — Permission Control Center",
    ar: "قوالب الأدوار — مركز التحكم بالصلاحيات",
    fr: "Modèles de rôles — Centre de contrôle des autorisations",
  },
  {
    en: "Preview before saving. Changes are versioned and audited in shadow storage only.",
    ar: "عاين قبل الحفظ. التغييرات تُحفظ بإصدارات وتُدقق في التخزين التجريبي فقط.",
    fr: "Prévisualisez avant d'enregistrer. Les modifications sont versionnées et auditées uniquement dans le stockage fantôme.",
  },
  {
    en: "Active company mismatch. Switch companies again before editing permissions.",
    ar: "الشركة النشطة غير مطابقة. بدّل الشركة مرة أخرى قبل تعديل الصلاحيات.",
    fr: "La société active ne correspond pas. Changez à nouveau de société avant de modifier les autorisations.",
  },
  { en: "All actions", ar: "كل الإجراءات", fr: "Toutes les actions" },
  { en: "Allow safe visible", ar: "السماح للعناصر الآمنة الظاهرة", fr: "Autoriser les éléments sûrs visibles" },
  { en: "Bulk action column", ar: "عمود الإجراء الجماعي", fr: "Colonne d'action groupée" },
  { en: "Company policy revision", ar: "مراجعة سياسة الشركة", fr: "Révision de la politique de la société" },
  { en: "Deny visible", ar: "رفض العناصر الظاهرة", fr: "Refuser les éléments visibles" },
  {
    en: "Explain the proposed permission changes",
    ar: "اشرح التغييرات المقترحة على الصلاحيات",
    fr: "Expliquez les modifications d'autorisations proposées",
  },
  { en: "Inherit visible", ar: "توريث العناصر الظاهرة", fr: "Hériter pour les éléments visibles" },
  { en: "No matching resources", ar: "لا توجد موارد مطابقة", fr: "Aucune ressource correspondante" },
  {
    en: "Permission catalog unavailable (HTTP ${response.status})",
    ar: "كتالوج الصلاحيات غير متاح (HTTP {{0}})",
    fr: "Catalogue des autorisations indisponible (HTTP {{0}})",
  },
  { en: "Permission request failed.", ar: "فشل طلب الصلاحيات.", fr: "La demande d'autorisation a échoué." },
  {
    en: "Reason for permission change (required)",
    ar: "سبب تغيير الصلاحيات (إلزامي)",
    fr: "Motif du changement d'autorisation (obligatoire)",
  },
  { en: "Resource", ar: "المورد", fr: "Ressource" },
  {
    en: "Review shadow permission changes",
    ar: "مراجعة تغييرات الصلاحيات التجريبية",
    fr: "Vérifier les modifications d'autorisations fantômes",
  },
  { en: "Role permissions matrix", ar: "مصفوفة صلاحيات الدور", fr: "Matrice des autorisations du rôle" },
  { en: "Role template", ar: "قالب الدور", fr: "Modèle de rôle" },
  { en: "Save shadow rules", ar: "حفظ القواعد التجريبية", fr: "Enregistrer les règles fantômes" },
  {
    en: "Search module, page, action",
    ar: "ابحث عن وحدة أو صفحة أو إجراء",
    fr: "Rechercher un module, une page, une action",
  },
  { en: "Search resources", ar: "البحث في الموارد", fr: "Rechercher des ressources" },
  { en: "Shadow mode", ar: "الوضع التجريبي", fr: "Mode fantôme" },
  {
    en: "Shadow policy storage unavailable (HTTP ${response.status})",
    ar: "تخزين السياسة التجريبية غير متاح (HTTP {{0}})",
    fr: "Stockage de la politique fantôme indisponible (HTTP {{0}})",
  },
  {
    en: "Too many changes: save at most 100 per batch.",
    ar: "تغييرات كثيرة جداً: احفظ 100 تغيير كحد أقصى في كل دفعة.",
    fr: "Trop de modifications : enregistrez au maximum 100 par lot.",
  },
  // User Access overrides
  {
    en: "User Access — Shadow Overrides",
    ar: "وصول المستخدم — الاستثناءات التجريبية",
    fr: "Accès utilisateur — Dérogations fantômes",
  },
  {
    en: "Access API returned HTTP ${response.status}",
    ar: "أعادت واجهة الوصول HTTP {{0}}",
    fr: "L'API d'accès a renvoyé HTTP {{0}}",
  },
  { en: "Choose a user", ar: "اختر مستخدماً", fr: "Choisissez un utilisateur" },
  { en: "Company member", ar: "عضو الشركة", fr: "Membre de la société" },
  { en: "Current company role:", ar: "دور الشركة الحالي:", fr: "Rôle actuel dans la société :" },
  { en: "Discard draft", ar: "تجاهل المسودة", fr: "Abandonner le brouillon" },
  { en: "Find a resource", ar: "ابحث عن مورد", fr: "Trouver une ressource" },
  {
    en: "Individual user overrides",
    ar: "استثناءات المستخدم الفردية",
    fr: "Dérogations individuelles de l'utilisateur",
  },
  {
    en: "Only 100 overrides can be saved per batch.",
    ar: "يمكن حفظ 100 استثناء فقط في كل دفعة.",
    fr: "Seules 100 dérogations peuvent être enregistrées par lot.",
  },
  { en: "Override change reason", ar: "سبب تغيير الاستثناء", fr: "Motif de modification de la dérogation" },
  { en: "Override module", ar: "وحدة الاستثناء", fr: "Module de la dérogation" },
  { en: "Preview action", ar: "إجراء المعاينة", fr: "Action à prévisualiser" },
  { en: "Preview not available.", ar: "المعاينة غير متاحة.", fr: "Aperçu indisponible." },
  { en: "Preview resource", ar: "مورد المعاينة", fr: "Ressource à prévisualiser" },
  {
    en: "Reset visible to role",
    ar: "إعادة العناصر الظاهرة إلى الدور",
    fr: "Réinitialiser les éléments visibles au rôle",
  },
  {
    en: "Review user-specific overrides",
    ar: "مراجعة استثناءات المستخدم",
    fr: "Vérifier les dérogations propres à l'utilisateur",
  },
  { en: "Search override resources", ar: "البحث في موارد الاستثناءات", fr: "Rechercher les ressources de dérogation" },
  {
    en: "This user's role is protected or the company policy is not editable in shadow mode.",
    ar: "دور هذا المستخدم محمي أو أن سياسة الشركة غير قابلة للتعديل في الوضع التجريبي.",
    fr: "Le rôle de cet utilisateur est protégé ou la politique de la société n'est pas modifiable en mode fantôme.",
  },
  {
    en: "View as user — diagnostic preview",
    ar: "العرض كمستخدم — معاينة تشخيصية",
    fr: "Voir en tant qu'utilisateur — aperçu de diagnostic",
  },
  {
    en: "Why should this user's access change?",
    ar: "لماذا يجب تغيير وصول هذا المستخدم؟",
    fr: "Pourquoi l'accès de cet utilisateur doit-il changer ?",
  },
  // Permission change audit
  { en: "Permission change audit", ar: "تدقيق تغييرات الصلاحيات", fr: "Audit des modifications d'autorisations" },
  {
    en: "Read-only history of this company's staged role and user permissions. Changes shown here are not live authorization.",
    ar: "سجل للقراءة فقط لصلاحيات الأدوار والمستخدمين المرحلية لهذه الشركة. التغييرات المعروضة هنا ليست صلاحيات فعلية.",
    fr: "Historique en lecture seule des autorisations de rôles et d'utilisateurs préparées pour cette société. Les modifications affichées ne sont pas des autorisations actives.",
  },
  {
    en: "Displays up to the latest 100 staged revisions for this company. The underlying audit is append-only.",
    ar: "يعرض حتى آخر 100 مراجعة مرحلية لهذه الشركة. سجل التدقيق الأساسي للإضافة فقط.",
    fr: "Affiche jusqu'aux 100 dernières révisions préparées pour cette société. L'audit sous-jacent est en ajout seul.",
  },
  {
    en: "Audit records unavailable (HTTP ${response.status})",
    ar: "سجلات التدقيق غير متاحة (HTTP {{0}})",
    fr: "Enregistrements d'audit indisponibles (HTTP {{0}})",
  },
  {
    en: "Company context changed. Refresh to view correct records.",
    ar: "تغيّرت الشركة النشطة. حدّث الصفحة لعرض السجلات الصحيحة.",
    fr: "Le contexte de société a changé. Actualisez pour afficher les bons enregistrements.",
  },
  {
    en: "Filter by actor, role, user, revision or reason",
    ar: "التصفية حسب المنفذ أو الدور أو المستخدم أو المراجعة أو السبب",
    fr: "Filtrer par auteur, rôle, utilisateur, révision ou motif",
  },
  { en: "Filter permission audit", ar: "تصفية تدقيق الصلاحيات", fr: "Filtrer l'audit des autorisations" },
  { en: "Loading audit history…", ar: "جارٍ تحميل سجل التدقيق…", fr: "Chargement de l'historique d'audit…" },
  { en: "No rule delta recorded.", ar: "لم يُسجل أي تغيير في القواعد.", fr: "Aucune variation de règle enregistrée." },
  {
    en: "No staged permission changes match this filter.",
    ar: "لا توجد تغييرات صلاحيات مرحلية مطابقة لهذا الفلتر.",
    fr: "Aucune modification d'autorisation préparée ne correspond à ce filtre.",
  },
  { en: "Permission audit records", ar: "سجلات تدقيق الصلاحيات", fr: "Enregistrements d'audit des autorisations" },
  // Supplier export gating and server denial messages
  { en: "Export unavailable", ar: "التصدير غير متاح", fr: "Export indisponible" },
  {
    en: "This action is not available to Create Only users.",
    ar: "هذا الإجراء غير متاح لمستخدمي دور الإنشاء فقط.",
    fr: "Cette action n'est pas disponible pour les utilisateurs « Création uniquement ».",
  },
  {
    en: "Active company access is required.",
    ar: "يلزم الوصول إلى الشركة النشطة.",
    fr: "L'accès à la société active est requis.",
  },
  {
    en: "This business action is not permitted.",
    ar: "هذا الإجراء التجاري غير مسموح.",
    fr: "Cette action métier n'est pas autorisée.",
  },
];
