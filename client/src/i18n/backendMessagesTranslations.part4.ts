import type { Phase7BackendMessagesEntry } from "./backendMessagesTranslationTypes";

export const backendMessagesPhase7TranslationsPart4: readonly Phase7BackendMessagesEntry[] = [
  {
    en: 'No name column found. Expected one of: ${NAME_HEADERS.slice(0, 5).join(", ")}',
    ar: "لم يتم العثور على عمود للأسماء. كان متوقعًا أحد الأعمدة التالية: {0}",
    fr: "Aucune colonne de noms trouvée. L’une des colonnes suivantes était attendue : {0}",
  },
  {
    en: 'Possible duplicate group: "${norm}" (${members.length} matches)',
    ar: "مجموعة مكررة محتملة: «{0}» ({1} تطابقات)",
    fr: "Groupe potentiellement dupliqué : « {0} » ({1} correspondance(s))",
  },
  {
    en: 'Likely duplicate of "${members[0].original}" (normalises to "${norm}")',
    ar: "يُحتمل أنه مكرر من «{0}» بعد التطبيع إلى «{1}»",
    fr: "Doublon probable de « {0} » après normalisation en « {1} »",
  },
  {
    en: "This validation type is not yet implemented.",
    ar: "نوع التحقق هذا غير منفذ بعد.",
    fr: "Ce type de validation n’est pas encore implémenté.",
  },
  {
    en: '"${validationType}" validation is coming soon.',
    ar: "التحقق «{0}» سيتوفر قريبًا.",
    fr: "La validation « {0} » sera bientôt disponible.",
  },
  {
    en: "validationType is required",
    ar: "نوع التحقق validationType مطلوب",
    fr: "validationType est requis",
  },
  {
    en: "A file is required for this validation type",
    ar: "يلزم ملف لهذا النوع من التحقق",
    fr: "Un fichier est requis pour ce type de validation",
  },
  {
    en: "Access denied",
    ar: "تم رفض الوصول",
    fr: "Accès refusé",
  },
  {
    en: "actionType is required",
    ar: "نوع الإجراء actionType مطلوب",
    fr: "actionType est requis",
  },
  {
    en: "Only Admin or Developer can approve requests",
    ar: "يمكن للمسؤول أو المطور فقط الموافقة على الطلبات",
    fr: "Seul un Administrateur ou un Développeur peut approuver les demandes",
  },
  {
    en: "Request not found",
    ar: "لم يتم العثور على الطلب",
    fr: "Demande introuvable",
  },
  {
    en: "Request is not pending",
    ar: "الطلب ليس قيد الانتظار",
    fr: "La demande n’est pas en attente",
  },
  {
    en: "You cannot approve your own request",
    ar: "لا يمكنك الموافقة على طلبك",
    fr: "Vous ne pouvez pas approuver votre propre demande",
  },
  {
    en: "Only Admin or Developer can reject requests",
    ar: "يمكن للمسؤول أو المطور فقط رفض الطلبات",
    fr: "Seul un Administrateur ou un Développeur peut rejeter les demandes",
  },
  {
    en: "You cannot reject your own request",
    ar: "لا يمكنك رفض طلبك",
    fr: "Vous ne pouvez pas rejeter votre propre demande",
  },
  {
    en: "Only Admin or Developer can mark requests as executed",
    ar: "يمكن للمسؤول أو المطور فقط تعليم الطلبات كمنفذة",
    fr: "Seul un Administrateur ou un Développeur peut marquer les demandes comme exécutées",
  },
  {
    en: "Request must be approved before it can be executed",
    ar: "يجب الموافقة على الطلب قبل تنفيذه",
    fr: "La demande doit être approuvée avant son exécution",
  },
  {
    en: "You can only cancel your own requests",
    ar: "يمكنك إلغاء طلباتك فقط",
    fr: "Vous ne pouvez annuler que vos propres demandes",
  },
  {
    en: "Only pending requests can be cancelled",
    ar: "يمكن إلغاء الطلبات قيد الانتظار فقط",
    fr: "Seules les demandes en attente peuvent être annulées",
  },
  {
    en: "Company deleted successfully",
    ar: "تم حذف الشركة بنجاح",
    fr: "Entreprise supprimée avec succès",
  },
  {
    en: "Company ID is required",
    ar: "معرّف الشركة مطلوب",
    fr: "L’identifiant de l’entreprise est requis",
  },
  {
    en: "You don't have access to this company",
    ar: "ليس لديك وصول إلى هذه الشركة",
    fr: "Vous n’avez pas accès à cette entreprise",
  },
  {
    en: "Failed to save session",
    ar: "فشل حفظ الجلسة",
    fr: "Échec de l’enregistrement de la session",
  },
  {
    en: "Company set successfully",
    ar: "تم تعيين الشركة بنجاح",
    fr: "Entreprise définie avec succès",
  },
  {
    en: "Too many login attempts. Please try again later.",
    ar: "محاولات تسجيل دخول كثيرة جدًا. يرجى المحاولة لاحقًا.",
    fr: "Trop de tentatives de connexion. Veuillez réessayer plus tard.",
  },
  {
    en: "Username and password are required",
    ar: "اسم المستخدم وكلمة المرور مطلوبان",
    fr: "Le nom d’utilisateur et le mot de passe sont requis",
  },
  {
    en: "Invalid credentials",
    ar: "بيانات الاعتماد غير صالحة",
    fr: "Identifiants non valides",
  },
  {
    en: "Account is inactive",
    ar: "الحساب غير نشط",
    fr: "Le compte est inactif",
  },
  {
    en: "Failed to logout",
    ar: "فشل تسجيل الخروج",
    fr: "Échec de la déconnexion",
  },
  {
    en: "Logged out successfully",
    ar: "تم تسجيل الخروج بنجاح",
    fr: "Déconnexion réussie",
  },
  {
    en: "All password fields are required.",
    ar: "جميع حقول كلمة المرور مطلوبة.",
    fr: "Tous les champs de mot de passe sont requis.",
  },
  {
    en: "New password must be at least 6 characters.",
    ar: "يجب ألا تقل كلمة المرور الجديدة عن 6 أحرف.",
    fr: "Le nouveau mot de passe doit comporter au moins 6 caractères.",
  },
  {
    en: "New password and confirmation do not match.",
    ar: "كلمة المرور الجديدة وتأكيدها غير متطابقين.",
    fr: "Le nouveau mot de passe et sa confirmation ne correspondent pas.",
  },
  {
    en: "User not found.",
    ar: "لم يتم العثور على المستخدم.",
    fr: "Utilisateur introuvable.",
  },
  {
    en: "Current password is incorrect.",
    ar: "كلمة المرور الحالية غير صحيحة.",
    fr: "Le mot de passe actuel est incorrect.",
  },
  {
    en: "Password is required",
    ar: "كلمة المرور مطلوبة",
    fr: "Le mot de passe est requis",
  },
  {
    en: "User not found",
    ar: "لم يتم العثور على المستخدم",
    fr: "Utilisateur introuvable",
  },
  {
    en: "Incorrect password",
    ar: "كلمة المرور غير صحيحة",
    fr: "Mot de passe incorrect",
  },
  {
    en: "Invalid application language",
    ar: "لغة التطبيق غير صالحة",
    fr: "Langue d’application non valide",
  },
  {
    en: "No snapshot provided",
    ar: "لم يتم تقديم لقطة",
    fr: "Aucun instantané fourni",
  },
  {
    en: "Invalid contractId",
    ar: "معرّف العقد contractId غير صالح",
    fr: "contractId non valide",
  },
  {
    en: "Ledger amounts synced (no rent payments to reallocate).",
    ar: "تمت مزامنة مبالغ دفتر الأستاذ، ولا توجد دفعات إيجار لإعادة توزيعها.",
    fr: "Montants du grand livre synchronisés, aucun paiement de loyer à réaffecter.",
  },
  {
    en: "Ledger amounts synced (no ledger rows found).",
    ar: "تمت مزامنة مبالغ دفتر الأستاذ، ولم يتم العثور على صفوف دفتر أستاذ.",
    fr: "Montants du grand livre synchronisés, aucune ligne de grand livre trouvée.",
  },
  {
    en: "Reallocated ${fixed} payment(s) to the correct months.",
    ar: "تمت إعادة توزيع {0} دفعة إلى الأشهر الصحيحة.",
    fr: "{0} paiement(s) réaffecté(s) aux mois corrects.",
  },
  {
    en: "Bank account code already exists",
    ar: "رمز الحساب البنكي موجود بالفعل",
    fr: "Le code du compte bancaire existe déjà",
  },
  {
    en: "Opening balance requires Dr/Cr side",
    ar: "يتطلب الرصيد الافتتاحي تحديد الجانب مدين أو دائن",
    fr: "Le solde d’ouverture exige un côté Débit ou Crédit",
  },
  {
    en: "Dr/Cr side requires opening balance amount",
    ar: "يتطلب الجانب مدين أو دائن مبلغ رصيد افتتاحي",
    fr: "Le côté Débit ou Crédit exige un montant de solde d’ouverture",
  },
  {
    en: "Linked ledger account not found",
    ar: "لم يتم العثور على حساب دفتر الأستاذ المرتبط",
    fr: "Compte du grand livre lié introuvable",
  },
  {
    en: "Linked ledger must be Bank or Cash type. Found: ${linkedLedger.accountType}",
    ar: "يجب أن يكون دفتر الأستاذ المرتبط من نوع بنك أو نقد. النوع الموجود: {0}",
    fr: "Le grand livre lié doit être de type Banque ou Espèces. Type trouvé : {0}",
  },
  {
    en: "Fixed asset code already exists",
    ar: "رمز الأصل الثابت موجود بالفعل",
    fr: "Le code de l’immobilisation existe déjà",
  },
];
