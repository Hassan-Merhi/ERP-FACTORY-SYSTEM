import type { Phase7BackendMessagesEntry } from "./backendMessagesTranslationTypes";

export const backendMessagesPhase7TranslationsPart2: readonly Phase7BackendMessagesEntry[] = [
  {
    en: "Access denied: This resource is not available for POS users",
    ar: "تم رفض الوصول: هذا المورد غير متاح لمستخدمي نقاط البيع",
    fr: "Accès refusé : cette ressource n’est pas disponible pour les utilisateurs du point de vente",
  },
  {
    en: "Gemini API key not configured",
    ar: "مفتاح Gemini API غير مهيأ",
    fr: "La clé API Gemini n’est pas configurée",
  },
  {
    en: "OpenAI API key not configured",
    ar: "مفتاح OpenAI API غير مهيأ",
    fr: "La clé API OpenAI n’est pas configurée",
  },
  {
    en: "xAI/Grok API key not configured",
    ar: "مفتاح xAI/Grok API غير مهيأ",
    fr: "La clé API xAI/Grok n’est pas configurée",
  },
  {
    en: "No AI providers available",
    ar: "لا يتوفر أي مزود للذكاء الاصطناعي",
    fr: "Aucun fournisseur d’IA n’est disponible",
  },
  {
    en: "Account not found",
    ar: "لم يتم العثور على الحساب",
    fr: "Compte introuvable",
  },
  {
    en: "No database configuration found. Please set DATABASE_URL or provision a PostgreSQL database.",
    ar: "لم يتم العثور على إعدادات قاعدة البيانات. يرجى تعيين DATABASE_URL أو توفير قاعدة بيانات PostgreSQL.",
    fr: "Aucune configuration de base de données trouvée. Définissez DATABASE_URL ou provisionnez une base PostgreSQL.",
  },
  {
    en: "Stock In Hand (Inventory)",
    ar: "المخزون المتوفر",
    fr: "Stock disponible",
  },
  {
    en: "Employee Advances",
    ar: "سلف الموظفين",
    fr: "Avances aux employés",
  },
  {
    en: "Owed to Employees",
    ar: "مبالغ مستحقة للموظفين",
    fr: "Montants dus aux employés",
  },
  {
    en: "Supplier Credit: ${sup.legalName}",
    ar: "رصيد دائن للمورد: {0}",
    fr: "Crédit fournisseur : {0}",
  },
  {
    en: "Supplier Payables",
    ar: "ذمم الموردين الدائنة",
    fr: "Dettes fournisseurs",
  },
  {
    en: "Stock On The Way (OTW)",
    ar: "المخزون في الطريق",
    fr: "Stock en transit",
  },
  {
    en: "${options.label} failed after ${options.attempts} attempts",
    ar: "فشل {0} بعد {1} محاولة",
    fr: "Échec de {0} après {1} tentative(s)",
  },
  {
    en: "Cross-origin state-changing request rejected by origin guard.",
    ar: "رفض حارس المصدر طلبًا عابرًا للمصادر يغيّر الحالة.",
    fr: "La requête interorigine modifiant l’état a été rejetée par le contrôle d’origine.",
  },
  {
    en: "[AISnapshot] Unknown snapshot type: ${snapshotType}",
    ar: "[AISnapshot] نوع لقطة غير معروف: {0}",
    fr: "[AISnapshot] Type d’instantané inconnu : {0}",
  },
  {
    en: "Path traversal rejected: ${JSON.stringify(relPath)}",
    ar: "تم رفض اجتياز المسار: {0}",
    fr: "Parcours de chemin rejeté : {0}",
  },
  {
    en: "File not found: ${relPath}",
    ar: "الملف غير موجود: {0}",
    fr: "Fichier introuvable : {0}",
  },
  {
    en: "Not a file: ${relPath}",
    ar: "ليس ملفًا: {0}",
    fr: "Ce n’est pas un fichier : {0}",
  },
  {
    en: "Directory not found: ${relPath}",
    ar: "المجلد غير موجود: {0}",
    fr: "Répertoire introuvable : {0}",
  },
  {
    en: "grep failed: ${getErrorMessage(e)}",
    ar: "فشل grep: {0}",
    fr: "Échec de grep : {0}",
  },
  {
    en: "No files to commit",
    ar: "لا توجد ملفات للالتزام بها",
    fr: "Aucun fichier à valider",
  },
  {
    en: "Invalid file path: ${f}",
    ar: "مسار ملف غير صالح: {0}",
    fr: "Chemin de fichier non valide : {0}",
  },
  {
    en: "GitHub repository is not configured. Please set it in Chatbot Settings → GitHub Integration.",
    ar: "مستودع GitHub غير مهيأ. يرجى تعيينه في إعدادات روبوت المحادثة ← تكامل GitHub.",
    fr: "Le dépôt GitHub n’est pas configuré. Définissez-le dans Paramètres du chatbot → Intégration GitHub.",
  },
  {
    en: "Nothing to commit — the file content may already be up to date.",
    ar: "لا يوجد شيء للالتزام به — قد يكون محتوى الملف محدّثًا بالفعل.",
    fr: "Rien à valider — le contenu du fichier est peut-être déjà à jour.",
  },
  {
    en: "Authentication failed. Check your GitHub token in Chatbot Settings.",
    ar: "فشلت المصادقة. تحقق من رمز GitHub في إعدادات روبوت المحادثة.",
    fr: "Échec de l’authentification. Vérifiez votre jeton GitHub dans les paramètres du chatbot.",
  },
  {
    en: "Push rejected — the remote has conflicting changes. Pull and merge first.",
    ar: "تم رفض الدفع — توجد تغييرات متعارضة في المستودع البعيد. اسحب التغييرات وادمجها أولًا.",
    fr: "Envoi rejeté — le dépôt distant contient des modifications conflictuelles. Récupérez-les et fusionnez-les d’abord.",
  },
  {
    en: "Repository not found. Check your GitHub URL in Chatbot Settings.",
    ar: "لم يتم العثور على المستودع. تحقق من رابط GitHub في إعدادات روبوت المحادثة.",
    fr: "Dépôt introuvable. Vérifiez l’URL GitHub dans les paramètres du chatbot.",
  },
  {
    en: "Permission denied. Ensure your token has the required repository write scope.",
    ar: "تم رفض الإذن. تأكد من أن الرمز يملك صلاحية الكتابة المطلوبة على المستودع.",
    fr: "Autorisation refusée. Vérifiez que votre jeton dispose de la portée d’écriture requise sur le dépôt.",
  },
  {
    en: "Unexpected server error",
    ar: "خطأ غير متوقع في الخادم",
    fr: "Erreur serveur inattendue",
  },
  {
    en: "Logger serialization failed",
    ar: "فشل تسلسل بيانات السجل",
    fr: "Échec de la sérialisation du journal",
  },
  {
    en: "Admin or Developer access required.",
    ar: "يلزم وصول مسؤول أو مطور.",
    fr: "Un accès Administrateur ou Développeur est requis.",
  },
  {
    en: "HTTP 5xx rate is elevated",
    ar: "معدل أخطاء HTTP 5xx مرتفع",
    fr: "Le taux d’erreurs HTTP 5xx est élevé",
  },
  {
    en: "HTTP p95 latency is elevated",
    ar: "زمن استجابة HTTP عند p95 مرتفع",
    fr: "La latence HTTP p95 est élevée",
  },
  {
    en: "Process memory pressure is elevated",
    ar: "ضغط ذاكرة العملية مرتفع",
    fr: "La pression mémoire du processus est élevée",
  },
  {
    en: "Database pool has waiting requests",
    ar: "توجد طلبات تنتظر في مجمّع اتصالات قاعدة البيانات",
    fr: "Des requêtes attendent une connexion dans le pool de base de données",
  },
  {
    en: "Scheduled job failures: ${job.name}",
    ar: "إخفاقات المهام المجدولة: {0}",
    fr: "Échecs de tâches planifiées : {0}",
  },
  {
    en: "External dependency failures: ${dependency.name}",
    ar: "إخفاقات التبعيات الخارجية: {0}",
    fr: "Échecs de dépendances externes : {0}",
  },
  {
    en: "Alert webhook returned HTTP ${response.status}",
    ar: "أعاد رابط التنبيه HTTP {0}",
    fr: "Le webhook d’alerte a renvoyé HTTP {0}",
  },
  {
    en: "PARCELSAPP_API_KEY is not configured",
    ar: "لم يتم إعداد PARCELSAPP_API_KEY",
    fr: "PARCELSAPP_API_KEY n’est pas configurée",
  },
  {
    en: "Tracking request timed out after polling",
    ar: "انتهت مهلة طلب التتبع بعد الاستقصاء",
    fr: "La demande de suivi a expiré après interrogation",
  },
  {
    en: "HTTP ${res.status}",
    ar: "HTTP {0}",
    fr: "HTTP {0}",
  },
  {
    en: "ParcelsApp POST failed: ${res.status} ${txt.slice(0, 200)}",
    ar: "فشل طلب ParcelsApp POST: {0} {1}",
    fr: "Échec de la requête POST ParcelsApp : {0} {1}",
  },
  {
    en: "ParcelsApp POST: server busy (BUSY)",
    ar: "ParcelsApp POST: الخادم مشغول (BUSY)",
    fr: "ParcelsApp POST : serveur occupé (BUSY)",
  },
  {
    en: "ParcelsApp POST: no uuid in response (raw=${JSON.stringify(data).slice(0, 120)})",
    ar: "ParcelsApp POST: لا يوجد uuid في الاستجابة (raw={0})",
    fr: "ParcelsApp POST : aucun uuid dans la réponse (raw={0})",
  },
  {
    en: "ParcelsApp GET failed: ${res.status} ${txt.slice(0, 200)}",
    ar: "فشل طلب ParcelsApp GET: {0} {1}",
    fr: "Échec de la requête GET ParcelsApp : {0} {1}",
  },
  {
    en: "initiateWithRetry: unexpected exit",
    ar: "initiateWithRetry: خروج غير متوقع",
    fr: "initiateWithRetry : sortie inattendue",
  },
  {
    en: "Puppeteer not installed",
    ar: "Puppeteer غير مثبت",
    fr: "Puppeteer n’est pas installé",
  },
  {
    en: "PUPPETEER_QUEUE_FULL",
    ar: "PUPPETEER_QUEUE_FULL",
    fr: "PUPPETEER_QUEUE_FULL",
  },
  {
    en: "reCaptcha detected automation — stealth plugin bypassed",
    ar: "اكتشفت reCaptcha الأتمتة — تم تجاوز إضافة التخفي",
    fr: "reCaptcha a détecté l’automatisation — contournement du module furtif",
  },
];
