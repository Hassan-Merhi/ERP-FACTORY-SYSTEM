import type { Phase3SharedUiEntry } from "./sharedUiPhase3TranslationTypes";

/**
 * Interface copy introduced on current main after the Phase 3 inventory was
 * generated: Group Net Position, company parent selection, supplier tracking
 * defaults, company deletion, and the bale scanning messages that surface with
 * them. Keeping the reviewed EN/AR/FR copy here lets the untranslated-text
 * audit and the runtime interface translator share one source of truth.
 */
export const phase3RemainingTranslationsPart26: readonly Phase3SharedUiEntry[] = [
  {
    en: "Supplier Defaults",
    ar: "الإعدادات الافتراضية للمورّد",
    fr: "Valeurs par défaut du fournisseur",
  },
  {
    en: "Choose parent or standalone",
    ar: "اختر الشركة الأم أو شركة مستقلة",
    fr: "Choisir une société mère ou autonome",
  },
  {
    en: "Parent Company / Standalone *",
    ar: "الشركة الأم / مستقلة *",
    fr: "Société mère / Autonome *",
  },
  {
    en: "Standalone / No Parent",
    ar: "مستقلة / بدون شركة أم",
    fr: "Autonome / Sans société mère",
  },
  {
    en: "Choose a parent company or explicitly select Standalone / No Parent.",
    ar: "اختر شركة أمّاً أو حدّد صراحةً مستقلة / بدون شركة أم.",
    fr: "Choisissez une société mère ou sélectionnez explicitement Autonome / Sans société mère.",
  },
  {
    en: "Back to System Tools",
    ar: "العودة إلى أدوات النظام",
    fr: "Retour aux outils système",
  },
  {
    en: "No balances on this side.",
    ar: "لا توجد أرصدة في هذا الجانب.",
    fr: "Aucun solde de ce côté.",
  },
  {
    en: "Net Position adjustment from this company's existing accounting rules",
    ar: "تعديل صافي المركز وفق القواعد المحاسبية القائمة لهذه الشركة",
    fr: "Ajustement de la position nette selon les règles comptables existantes de cette société",
  },
  {
    en: "Group Net Position",
    ar: "صافي مركز المجموعة",
    fr: "Position nette du groupe",
  },
  {
    en: "As of date",
    ar: "حتى تاريخ",
    fr: "À la date du",
  },
  {
    en: "Group Net Position could not be loaded.",
    ar: "تعذّر تحميل صافي مركز المجموعة.",
    fr: "La position nette du groupe n’a pas pu être chargée.",
  },
  {
    en: "Total What We Have",
    ar: "إجمالي ما لدينا",
    fr: "Total de ce que nous avons",
  },
  {
    en: "Total What We Owe",
    ar: "إجمالي ما علينا",
    fr: "Total de ce que nous devons",
  },
  {
    en: "Company Overview",
    ar: "نظرة عامة على الشركة",
    fr: "Vue d’ensemble de la société",
  },
  {
    en: "GROUP TOTAL",
    ar: "إجمالي المجموعة",
    fr: "TOTAL DU GROUPE",
  },
  {
    en: "Intercompany treatment",
    ar: "معالجة العمليات بين الشركات",
    fr: "Traitement intersociétés",
  },
  {
    en: "Company Breakdown",
    ar: "تفصيل حسب الشركة",
    fr: "Détail par société",
  },
  {
    en: "Every company's What We Have and What We Owe is shown directly from its existing Net Position calculation.",
    ar: "يُعرض «ما لدينا» و«ما علينا» لكل شركة مباشرةً من حساب صافي المركز القائم لديها.",
    fr: "Pour chaque société, « Ce que nous avons » et « Ce que nous devons » proviennent directement de son calcul de position nette existant.",
  },
  {
    en: "Combined What We Have, What We Owe, and Net Position across active ERP companies. Factory and Properties are excluded.",
    ar: "تجميع «ما لدينا» و«ما علينا» وصافي المركز عبر شركات ERP النشطة. المصنع والعقارات مستثناة.",
    fr: "Cumul de « Ce que nous avons », « Ce que nous devons » et de la position nette sur les sociétés ERP actives. L’usine et les biens immobiliers sont exclus.",
  },
  {
    en: "Combine What We Have, What We Owe, and Net Position across active ERP companies. Factory and Properties are excluded.",
    ar: "ادمج «ما لدينا» و«ما علينا» وصافي المركز عبر شركات ERP النشطة. المصنع والعقارات مستثناة.",
    fr: "Combinez « Ce que nous avons », « Ce que nous devons » et la position nette sur les sociétés ERP actives. L’usine et les biens immobiliers sont exclus.",
  },
  {
    en: "No default",
    ar: "بدون قيمة افتراضية",
    fr: "Aucune valeur par défaut",
  },
  {
    en: "e.g. NAHLI",
    ar: "مثال: NAHLI",
    fr: "ex. NAHLI",
  },
  {
    en: "Supplier Tracking Defaults",
    ar: "الإعدادات الافتراضية لتتبع المورّدين",
    fr: "Valeurs par défaut de suivi des fournisseurs",
  },
  {
    en: "Supplier mappings",
    ar: "ربط المورّدين",
    fr: "Correspondances de fournisseurs",
  },
  {
    en: "Loading supplier mappings…",
    ar: "جارٍ تحميل ربط المورّدين…",
    fr: "Chargement des correspondances de fournisseurs…",
  },
  {
    en: "Could not load supplier tracking defaults.",
    ar: "تعذّر تحميل الإعدادات الافتراضية لتتبع المورّدين.",
    fr: "Impossible de charger les valeurs par défaut de suivi des fournisseurs.",
  },
  {
    en: "No matching suppliers found.",
    ar: "لم يتم العثور على موردين مطابقين.",
    fr: "Aucun fournisseur correspondant trouvé.",
  },
  {
    en: "Default Shop / Location",
    ar: "المحل / الموقع الافتراضي",
    fr: "Magasin / Emplacement par défaut",
  },
  {
    en: "Default Agent",
    ar: "الوكيل الافتراضي",
    fr: "Agent par défaut",
  },
  {
    en: "Existing containers",
    ar: "الحاويات القائمة",
    fr: "Conteneurs existants",
  },
  {
    en: "Admin, Owner, or Developer access is required.",
    ar: "يلزم وصول مسؤول أو مالك أو مطوّر.",
    fr: "Un accès Administrateur, Propriétaire ou Développeur est requis.",
  },
  {
    en: "Mappings are company-specific and do not rewrite existing container history.",
    ar: "الربط خاص بكل شركة ولا يعيد كتابة سجل الحاويات القائم.",
    fr: "Les correspondances sont propres à chaque société et ne réécrivent pas l’historique des conteneurs existants.",
  },
  {
    en: "Tracking default saved",
    ar: "تم حفظ إعداد التتبع الافتراضي",
    fr: "Valeur par défaut de suivi enregistrée",
  },
  {
    en: "New containers will use this supplier mapping automatically.",
    ar: "ستستخدم الحاويات الجديدة هذا الربط للمورّد تلقائياً.",
    fr: "Les nouveaux conteneurs utiliseront automatiquement cette correspondance de fournisseur.",
  },
  {
    en: "Could not save tracking default",
    ar: "تعذّر حفظ إعداد التتبع الافتراضي",
    fr: "Impossible d’enregistrer la valeur par défaut de suivi",
  },
  {
    en: "Blank tracking fields backfilled",
    ar: "تمت تعبئة حقول التتبع الفارغة",
    fr: "Champs de suivi vides complétés",
  },
  {
    en: "${result.containersUpdated} container(s) updated · ${result.shopsFilled} shop name(s) · ${result.agentsFilled} agent(s).",
    ar: "تم تحديث {{0}} حاوية · {{1}} اسم محل · {{2}} وكيل.",
    fr: "{{0}} conteneur(s) mis à jour · {{1}} nom(s) de magasin · {{2}} agent(s).",
  },
  {
    en: "Backfill failed",
    ar: "فشلت التعبئة الرجعية",
    fr: "Échec du remplissage rétroactif",
  },
  {
    en: "Invalid tracking default",
    ar: "إعداد تتبع افتراضي غير صالح",
    fr: "Valeur par défaut de suivi non valide",
  },
  {
    en: "Supplier not found in the selected company",
    ar: "المورّد غير موجود في الشركة المحددة",
    fr: "Fournisseur introuvable dans la société sélectionnée",
  },
  {
    en: "Location not found in the selected company",
    ar: "الموقع غير موجود في الشركة المحددة",
    fr: "Emplacement introuvable dans la société sélectionnée",
  },
  {
    en: "ERP Net Position handler is unavailable",
    ar: "معالج صافي مركز ERP غير متاح",
    fr: "Le gestionnaire de position nette ERP est indisponible",
  },
  {
    en: "Switch to a different company before deleting the company that is currently active.",
    ar: "انتقل إلى شركة أخرى قبل حذف الشركة النشطة حالياً.",
    fr: "Basculez vers une autre société avant de supprimer la société actuellement active.",
  },
  {
    en: "This Group Net Position report is blocked because ${error.companyName} has unresolved legacy foreign-currency data.",
    ar: "تم حظر تقرير صافي مركز المجموعة لأن {{0}} لديها بيانات عملات أجنبية قديمة غير معالجة.",
    fr: "Ce rapport de position nette du groupe est bloqué car {{0}} comporte des données historiques en devises non résolues.",
  },
  {
    en: "Invalid toDate. Expected YYYY-MM-DD.",
    ar: "قيمة toDate غير صالحة. الصيغة المتوقعة YYYY-MM-DD.",
    fr: "toDate non valide. Format attendu : YYYY-MM-DD.",
  },
  {
    en: "Authenticated user context is unavailable",
    ar: "سياق المستخدم المُصادَق عليه غير متاح",
    fr: "Le contexte de l’utilisateur authentifié est indisponible",
  },
  {
    en: 'Bale "${newRef}" is already linked to another active loading/order',
    ar: "البالة «{{0}}» مرتبطة بالفعل بتحميل أو طلب نشط آخر",
    fr: "La balle « {{0}} » est déjà liée à un autre chargement/commande actif",
  },
  {
    en: "Linked proforma is unavailable",
    ar: "الفاتورة الأولية المرتبطة غير متاحة",
    fr: "La facture proforma liée est indisponible",
  },
  {
    en: "${label} must be a signed 32-bit integer",
    ar: "يجب أن يكون {{0}} عدداً صحيحاً بإشارة بطول 32 بت",
    fr: "{{0}} doit être un entier signé de 32 bits",
  },
  {
    en: "${result.linked} bale(s) linked successfully",
    ar: "تم ربط {{0}} بالة بنجاح",
    fr: "{{0}} balle(s) liée(s) avec succès",
  },
  {
    en: "${result.linked} bale(s) auto-linked from stock",
    ar: "تم ربط {{0}} بالة تلقائياً من المخزون",
    fr: "{{0}} balle(s) liée(s) automatiquement depuis le stock",
  },
  {
    en: "Company deletion dependency graph is too complex to resolve safely.",
    ar: "رسم تبعيات حذف الشركة معقّد للغاية بحيث لا يمكن حلّه بأمان.",
    fr: "Le graphe de dépendances de suppression de société est trop complexe pour être résolu en toute sécurité.",
  },
  {
    en: "Company deletion is blocked by ${foreignKey.childTable} (${foreignKey.constraintName}).",
    ar: "حذف الشركة محظور بسبب {{0}} ({{1}}).",
    fr: "La suppression de la société est bloquée par {{0}} ({{1}}).",
  },
  {
    en: 'Company deletion stopped because restrictive foreign keys form a cycle across: ${unresolved.join(", ")}. No data was deleted.',
    ar: "توقّف حذف الشركة لأن المفاتيح الأجنبية المقيِّدة تشكّل دورة عبر: {{0}}. لم يتم حذف أي بيانات.",
    fr: "La suppression de la société a été interrompue car des clés étrangères restrictives forment un cycle sur : {{0}}. Aucune donnée n’a été supprimée.",
  },
  {
    en: "Company deletion is blocked by a remaining cross-company reference${constraint}.${detail}",
    ar: "حذف الشركة محظور بسبب مرجع متبقٍّ بين الشركات{{0}}.{{1}}",
    fr: "La suppression de la société est bloquée par une référence intersociétés restante{{0}}.{{1}}",
  },
  {
    en: "Company ID must be a positive integer.",
    ar: "يجب أن يكون معرّف الشركة عدداً صحيحاً موجباً.",
    fr: "L’identifiant de la société doit être un entier positif.",
  },
  {
    en: "Company could not be deleted.",
    ar: "تعذّر حذف الشركة.",
    fr: "La société n’a pas pu être supprimée.",
  },
];
