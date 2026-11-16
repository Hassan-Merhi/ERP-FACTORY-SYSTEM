import type { Phase7BackendMessagesEntry } from "./backendMessagesTranslationTypes";

export const backendMessagesPhase7TranslationsPart3: readonly Phase7BackendMessagesEntry[] = [
  {
    en: "No tracking data received from ParcelsApp page",
    ar: "لم يتم تلقي بيانات تتبع من صفحة ParcelsApp",
    fr: "Aucune donnée de suivi reçue de la page ParcelsApp",
  },
  {
    en: 'Scraper error: ${getErrorMessage(err) ?? "Unknown"}',
    ar: "خطأ أداة الاستخراج: {0}",
    fr: "Erreur de l’extracteur : {0}",
  },
  {
    en: "PUPPETEER_QUEUE_TIMEOUT",
    ar: "PUPPETEER_QUEUE_TIMEOUT",
    fr: "PUPPETEER_QUEUE_TIMEOUT",
  },
  {
    en: "Puppeteer not available",
    ar: "Puppeteer غير متاح",
    fr: "Puppeteer n’est pas disponible",
  },
  {
    en: "track-trace: ${msg}",
    ar: "التتبع: {0}",
    fr: "Suivi : {0}",
  },
  {
    en: "API response bandwidth exceeded its reporting-window budget",
    ar: "تجاوزت استجابة API ميزانية النطاق الترددي لنافذة التقارير",
    fr: "La réponse API a dépassé le budget de bande passante de la fenêtre de rapport",
  },
  {
    en: "Static-asset bandwidth exceeded its reporting-window budget",
    ar: "تجاوزت الأصول الثابتة ميزانية النطاق الترددي لنافذة التقارير",
    fr: "Les ressources statiques ont dépassé le budget de bande passante de la fenêtre de rapport",
  },
  {
    en: "An API endpoint exceeded its reporting-window bandwidth budget",
    ar: "تجاوزت نقطة نهاية API ميزانية النطاق الترددي لنافذة التقارير",
    fr: "Un point de terminaison API a dépassé son budget de bande passante de la fenêtre de rapport",
  },
  {
    en: "A static asset exceeded its reporting-window bandwidth budget",
    ar: "تجاوز أصل ثابت ميزانية النطاق الترددي لنافذة التقارير",
    fr: "Une ressource statique a dépassé son budget de bande passante de la fenêtre de rapport",
  },
  {
    en: "Ranked endpoint performance and bandwidth snapshot",
    ar: "لقطة مرتبة لأداء نقاط النهاية والنطاق الترددي",
    fr: "Aperçu classé des performances des points de terminaison et de la bande passante",
  },
  {
    en: "Large HTTP response detected",
    ar: "تم اكتشاف استجابة HTTP كبيرة",
    fr: "Réponse HTTP volumineuse détectée",
  },
  {
    en: "Cross-origin observability report rejected.",
    ar: "تم رفض تقرير المراقبة العابر للمصادر.",
    fr: "Le rapport d’observabilité interorigine a été rejeté.",
  },
  {
    en: "Authentication required.",
    ar: "المصادقة مطلوبة.",
    fr: "Authentification requise.",
  },
  {
    en: "A non-empty error message is required.",
    ar: "يلزم تقديم رسالة خطأ غير فارغة.",
    fr: "Un message d’erreur non vide est requis.",
  },
  {
    en: "${message}\n${stack}",
    ar: "{0}\n{1}",
    fr: "{0}\n{1}",
  },
  {
    en: "Developer access required for this global maintenance operation",
    ar: "يلزم وصول المطور لتنفيذ عملية الصيانة العامة هذه",
    fr: "Un accès Développeur est requis pour cette opération de maintenance globale",
  },
  {
    en: "Voucher not found",
    ar: "لم يتم العثور على السند",
    fr: "Pièce introuvable",
  },
  {
    en: "HTTP server error detected",
    ar: "تم اكتشاف خطأ في خادم HTTP",
    fr: "Erreur du serveur HTTP détectée",
  },
  {
    en: "Import job not found",
    ar: "لم يتم العثور على مهمة الاستيراد",
    fr: "Tâche d’importation introuvable",
  },
  {
    en: "Invalid job id",
    ar: "معرّف المهمة غير صالح",
    fr: "Identifiant de tâche non valide",
  },
  {
    en: "Job is already posted",
    ar: "تم ترحيل المهمة بالفعل",
    fr: "La tâche est déjà comptabilisée",
  },
  {
    en: "Job is already confirmed",
    ar: "تم تأكيد المهمة بالفعل",
    fr: "La tâche est déjà confirmée",
  },
  {
    en: "Job must be validated before confirming",
    ar: "يجب التحقق من المهمة قبل تأكيدها",
    fr: "La tâche doit être validée avant confirmation",
  },
  {
    en: "Cannot confirm: ${job.errorRows} row(s) still have errors",
    ar: "لا يمكن التأكيد: لا يزال هناك {0} صف يحتوي على أخطاء",
    fr: "Confirmation impossible : {0} ligne(s) contiennent encore des erreurs",
  },
  {
    en: "Job confirmed. Call /post to create the records.",
    ar: "تم تأكيد المهمة. استدعِ /post لإنشاء السجلات.",
    fr: "Tâche confirmée. Appelez /post pour créer les enregistrements.",
  },
  {
    en: "Row not found",
    ar: "لم يتم العثور على الصف",
    fr: "Ligne introuvable",
  },
  {
    en: "Correction not found",
    ar: "لم يتم العثور على التصحيح",
    fr: "Correction introuvable",
  },
  {
    en: "No file uploaded",
    ar: "لم يتم رفع أي ملف",
    fr: "Aucun fichier téléversé",
  },
  {
    en: "importType is required",
    ar: "نوع الاستيراد importType مطلوب",
    fr: "importType est requis",
  },
  {
    en: 'importType must be one of: ${SUPPORTED.join(", ")}',
    ar: "يجب أن يكون importType أحد القيم التالية: {0}",
    fr: "importType doit être l’une des valeurs suivantes : {0}",
  },
  {
    en: "Excel file has no sheets",
    ar: "ملف Excel لا يحتوي على أوراق",
    fr: "Le fichier Excel ne contient aucune feuille",
  },
  {
    en: "Excel file has no data rows",
    ar: "ملف Excel لا يحتوي على صفوف بيانات",
    fr: "Le fichier Excel ne contient aucune ligne de données",
  },
  {
    en: "${rawRows.length} rows staged. Call /validate to check them.",
    ar: "تم تجهيز {0} صف. استدعِ /validate للتحقق منها.",
    fr: "{0} ligne(s) préparée(s). Appelez /validate pour les vérifier.",
  },
  {
    en: "Job has no rows",
    ar: "المهمة لا تحتوي على صفوف",
    fr: "La tâche ne contient aucune ligne",
  },
  {
    en: "instruction is required",
    ar: "التعليمة مطلوبة",
    fr: "L’instruction est requise",
  },
  {
    en: "Invalid task id",
    ar: "معرّف المهمة غير صالح",
    fr: "Identifiant de tâche non valide",
  },
  {
    en: "Task is already ${task.status}",
    ar: "المهمة بحالة {0} بالفعل",
    fr: "La tâche est déjà {0}",
  },
  {
    en: "Task is waiting for an approval",
    ar: "المهمة تنتظر موافقة",
    fr: "La tâche attend une approbation",
  },
  {
    en: "Invalid approval id",
    ar: "معرّف الموافقة غير صالح",
    fr: "Identifiant d’approbation non valide",
  },
  {
    en: "Approval not found",
    ar: "لم يتم العثور على الموافقة",
    fr: "Approbation introuvable",
  },
  {
    en: "Approval is already ${approval.status}",
    ar: "الموافقة بحالة {0} بالفعل",
    fr: "L’approbation est déjà {0}",
  },
  {
    en: "Task not found",
    ar: "لم يتم العثور على المهمة",
    fr: "Tâche introuvable",
  },
  {
    en: "Could not detect a code column in the file.",
    ar: "تعذر اكتشاف عمود الرموز في الملف.",
    fr: "Impossible de détecter une colonne de codes dans le fichier.",
  },
  {
    en: 'No code column found. Expected one of: ${CODE_HEADERS.slice(0, 5).join(", ")}',
    ar: "لم يتم العثور على عمود للرموز. كان متوقعًا أحد الأعمدة التالية: {0}",
    fr: "Aucune colonne de codes trouvée. L’une des colonnes suivantes était attendue : {0}",
  },
  {
    en: "Empty code cell",
    ar: "خلية الرمز فارغة",
    fr: "Cellule de code vide",
  },
  {
    en: 'Duplicate code within file: "${raw}"',
    ar: "رمز مكرر داخل الملف: «{0}»",
    fr: "Code dupliqué dans le fichier : « {0} »",
  },
  {
    en: '"${raw}" not found — close matches: ${detail}',
    ar: "لم يتم العثور على «{0}» — تطابقات قريبة: {1}",
    fr: "« {0} » introuvable — correspondances proches : {1}",
  },
  {
    en: 'Code "${raw}" not found in stock items or aliases',
    ar: "لم يتم العثور على الرمز «{0}» في عناصر المخزون أو الأسماء البديلة",
    fr: "Le code « {0} » est introuvable dans les articles de stock ou les alias",
  },
  {
    en: "${found} found, ${missing} missing, ${duplicateInFile} duplicates in file, ${closeMatches} close matches",
    ar: "تم العثور على {0}، والمفقود {1}، والمكرر في الملف {2}، والتطابقات القريبة {3}",
    fr: "{0} trouvé(s), {1} manquant(s), {2} doublon(s) dans le fichier, {3} correspondance(s) proche(s)",
  },
  {
    en: "Could not detect a name column in the file.",
    ar: "تعذر اكتشاف عمود الأسماء في الملف.",
    fr: "Impossible de détecter une colonne de noms dans le fichier.",
  },
];
