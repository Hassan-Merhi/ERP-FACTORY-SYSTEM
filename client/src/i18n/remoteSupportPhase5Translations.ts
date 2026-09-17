import type { ApplicationLanguage } from "@shared/applicationLanguageContract";
import type { Phase7BackendMessagesEntry } from "./backendMessagesPhase7TranslationTypes";

export const remoteSupportPhase5Translations: readonly Phase7BackendMessagesEntry[] = [
  { en: "Mouse control", ar: "التحكم بالماوس", fr: "Contrôle de la souris" },
  {
    en: "Safe viewing and navigation",
    ar: "عرض وتنقل آمنان",
    fr: "Consultation et navigation sécurisées",
  },
  {
    en: "Keyboard disabled",
    ar: "لوحة المفاتيح معطلة",
    fr: "Clavier désactivé",
  },
  { en: "Stop mouse", ar: "إيقاف الماوس", fr: "Arrêter la souris" },
  { en: "Enable", ar: "تفعيل", fr: "Activer" },
  {
    en: "Confirm your password to enable mouse control for up to 5 minutes.",
    ar: "أكد كلمة المرور لتفعيل التحكم بالماوس لمدة تصل إلى 5 دقائق.",
    fr: "Confirmez votre mot de passe pour activer le contrôle de la souris pendant 5 minutes maximum.",
  },
  { en: "Password", ar: "كلمة المرور", fr: "Mot de passe" },
  { en: "Confirm", ar: "تأكيد", fr: "Confirmer" },
  {
    en: "Active: click and scroll on allowlisted controls",
    ar: "نشط: النقر والتمرير على عناصر التحكم المسموح بها",
    fr: "Actif : clic et défilement sur les commandes autorisées",
  },
  {
    en: "Read-only until explicitly enabled",
    ar: "للقراءة فقط حتى يتم التفعيل صراحةً",
    fr: "Lecture seule jusqu’à activation explicite",
  },
  {
    en: "That control is protected and cannot be activated remotely.",
    ar: "عنصر التحكم هذا محمي ولا يمكن تفعيله عن بُعد.",
    fr: "Cette commande est protégée et ne peut pas être activée à distance.",
  },
  {
    en: "That part of the screen has scrolled out of view. Wait for a fresh frame and try again.",
    ar: "لقد خرج هذا الجزء من الشاشة عن نطاق العرض. انتظر إطارًا جديدًا ثم حاول مجددًا.",
    fr: "Cette partie de l’écran n’est plus visible. Attendez une image récente puis réessayez.",
  },
  {
    en: "Unable to enable mouse control.",
    ar: "تعذر تفعيل التحكم بالماوس.",
    fr: "Impossible d’activer le contrôle de la souris.",
  },
  {
    en: "Password confirmation failed.",
    ar: "فشل تأكيد كلمة المرور.",
    fr: "La confirmation du mot de passe a échoué.",
  },
  {
    en: "Mouse command failed.",
    ar: "فشل أمر الماوس.",
    fr: "La commande de souris a échoué.",
  },
  {
    en: "Remote mouse request failed.",
    ar: "فشل طلب الماوس البعيد.",
    fr: "La requête de souris distante a échoué.",
  },
  {
    en: "Remote control request failed.",
    ar: "فشل طلب التحكم عن بُعد.",
    fr: "La requête de contrôle à distance a échoué.",
  },
  {
    en: "Reconnecting the support session.",
    ar: "جارٍ إعادة الاتصال بجلسة الدعم.",
    fr: "Reconnexion à la session d’assistance.",
  },
  {
    en: "Remote control session did not bind to the watched user.",
    ar: "لم ترتبط جلسة التحكم عن بُعد بالمستخدم المُراقَب.",
    fr: "La session de contrôle à distance ne s’est pas liée à l’utilisateur surveillé.",
  },
  {
    en: "Another controller already owns this support session.",
    ar: "وحدة تحكم أخرى تملك جلسة الدعم هذه بالفعل.",
    fr: "Un autre contrôleur possède déjà cette session d’assistance.",
  },
  {
    en: "Waiting for the employee ERP tab to register for control.",
    ar: "بانتظار تسجيل علامة تبويب ERP الخاصة بالموظف للتحكم.",
    fr: "En attente de l’enregistrement de l’onglet ERP de l’employé pour le contrôle.",
  },
  {
    en: "Unable to prepare remote control.",
    ar: "تعذر تجهيز التحكم عن بُعد.",
    fr: "Impossible de préparer le contrôle à distance.",
  },
  { en: "Remote control unavailable", ar: "التحكم عن بُعد غير متاح", fr: "Contrôle à distance indisponible" },
  { en: "Preparing remote control", ar: "جارٍ تجهيز التحكم عن بُعد", fr: "Préparation du contrôle à distance" },
  { en: "Control reconnecting", ar: "جارٍ إعادة اتصال التحكم", fr: "Reconnexion du contrôle" },
  { en: "Preparing the ERP tab for", ar: "جارٍ تجهيز علامة تبويب ERP لـ", fr: "Préparation de l’onglet ERP pour" },
  { en: "Watching", ar: "مراقبة", fr: "Surveillance de" },
  { en: "Fast live feed", ar: "بث مباشر سريع", fr: "Flux direct rapide" },
  { en: "Polling mode", ar: "وضع الاستطلاع", fr: "Mode d’interrogation" },
  { en: "last seen", ar: "آخر ظهور", fr: "vu pour la dernière fois" },
  { en: "Refresh", ar: "تحديث", fr: "Actualiser" },
  { en: "Fit", ar: "ملاءمة", fr: "Ajuster" },
  { en: "Full Screen", ar: "ملء الشاشة", fr: "Plein écran" },
  { en: "Close viewer", ar: "إغلاق العارض", fr: "Fermer la visionneuse" },
  { en: "Live screen for", ar: "الشاشة المباشرة لـ", fr: "Écran en direct de" },
  {
    en: "Waiting for the first screen frame…",
    ar: "بانتظار أول إطار للشاشة…",
    fr: "En attente de la première image de l’écran…",
  },
  { en: "Page history", ar: "سجل الصفحات", fr: "Historique des pages" },
  { en: "Currently on", ar: "حاليًا في", fr: "Actuellement sur" },
  { en: "No history yet.", ar: "لا يوجد سجل بعد.", fr: "Aucun historique pour le moment." },
  { en: "Preparing remote viewer…", ar: "جارٍ تجهيز العارض البعيد…", fr: "Préparation de la visionneuse distante…" },
  {
    en: "Remote screen feed is disabled.",
    ar: "بث الشاشة البعيد معطل.",
    fr: "Le flux d’écran distant est désactivé.",
  },
  {
    en: "Enable screen feed in Remote Support settings before opening a viewer.",
    ar: "فعّل بث الشاشة في إعدادات الدعم عن بُعد قبل فتح العارض.",
    fr: "Activez le flux d’écran dans les paramètres d’assistance à distance avant d’ouvrir une visionneuse.",
  },
  { en: "Close", ar: "إغلاق", fr: "Fermer" },
  {
    en: "Polling recovery failed.",
    ar: "فشل الاسترداد عبر الاستطلاع.",
    fr: "La récupération par interrogation a échoué.",
  },
  {
    en: "A live frame arrived in an invalid format.",
    ar: "وصل إطار مباشر بتنسيق غير صالح.",
    fr: "Une image en direct est arrivée dans un format non valide.",
  },
  {
    en: "Live connection interrupted. Polling recovery is active.",
    ar: "انقطع الاتصال المباشر. الاسترداد عبر الاستطلاع نشط.",
    fr: "Connexion en direct interrompue. La récupération par interrogation est active.",
  },
  {
    en: "Screen feed request failed.",
    ar: "فشل طلب بث الشاشة.",
    fr: "La requête de flux d’écran a échoué.",
  },
  {
    en: "Screen capture issue",
    ar: "مشكلة في التقاط الشاشة",
    fr: "Problème de capture d’écran",
  },
  {
    en: "Screen capture failed",
    ar: "فشل التقاط الشاشة",
    fr: "Échec de la capture d’écran",
  },
  {
    en: "Frame payload is too large.",
    ar: "حجم بيانات الإطار كبير جدًا.",
    fr: "La charge utile de la trame est trop volumineuse.",
  },
  {
    en: "Frame producer is sending too quickly.",
    ar: "يتم إرسال الإطارات بسرعة كبيرة.",
    fr: "Les trames sont envoyées trop rapidement.",
  },
  {
    en: "Invalid watched user ID.",
    ar: "معرّف المستخدم المُراقَب غير صالح.",
    fr: "L’identifiant de l’utilisateur surveillé n’est pas valide.",
  },
  { en: "Executed", ar: "تم التنفيذ", fr: "Exécutée" },
  { en: "Blocked", ar: "محظور", fr: "Bloquée" },
  { en: "Ignored", ar: "تم التجاهل", fr: "Ignorée" },
  {
    en: "This controller does not own the session.",
    ar: "وحدة التحكم هذه لا تملك الجلسة.",
    fr: "Ce contrôleur ne possède pas la session.",
  },
  {
    en: "Mouse control is disabled.",
    ar: "التحكم بالماوس معطل.",
    fr: "Le contrôle de la souris est désactivé.",
  },
  {
    en: "This command channel is not bound to this ERP tab.",
    ar: "قناة الأوامر هذه غير مرتبطة بعلامة تبويب ERP هذه.",
    fr: "Ce canal de commande n’est pas lié à cet onglet ERP.",
  },
  {
    en: "Mouse commands are being sent too quickly.",
    ar: "يتم إرسال أوامر الماوس بسرعة كبيرة.",
    fr: "Les commandes de souris sont envoyées trop rapidement.",
  },
  {
    en: "Confirm your password before enabling mouse control.",
    ar: "أكد كلمة المرور قبل تفعيل التحكم بالماوس.",
    fr: "Confirmez votre mot de passe avant d’activer le contrôle de la souris.",
  },
  {
    en: "Unsupported mouse command.",
    ar: "أمر ماوس غير مدعوم.",
    fr: "Commande de souris non prise en charge.",
  },
  {
    en: "Mouse coordinates must be normalized.",
    ar: "يجب أن تكون إحداثيات الماوس مطبّعة.",
    fr: "Les coordonnées de la souris doivent être normalisées.",
  },
  {
    en: "A bounded scroll delta is required.",
    ar: "يلزم مقدار تمرير ضمن الحدود.",
    fr: "Un delta de défilement limité est requis.",
  },
  {
    en: "The employee ERP tab is not ready to receive mouse commands.",
    ar: "علامة تبويب ERP الخاصة بالموظف غير جاهزة لاستقبال أوامر الماوس.",
    fr: "L’onglet ERP de l’employé n’est pas prêt à recevoir les commandes de souris.",
  },
  {
    en: "Mouse command not found.",
    ar: "لم يتم العثور على أمر الماوس.",
    fr: "Commande de souris introuvable.",
  },
  {
    en: "Unsupported mouse command result.",
    ar: "نتيجة أمر الماوس غير مدعومة.",
    fr: "Résultat de commande de souris non pris en charge.",
  },
  {
    en: "A support session and browser tab are required.",
    ar: "يلزم وجود جلسة دعم وعلامة تبويب متصفح.",
    fr: "Une session d’assistance et un onglet de navigateur sont requis.",
  },
];

const translationByText = new Map<string, Phase7BackendMessagesEntry>();
for (const entry of remoteSupportPhase5Translations) {
  translationByText.set(entry.en, entry);
  translationByText.set(entry.ar, entry);
  translationByText.set(entry.fr, entry);
}

export function translateRemoteSupportPhase5Text(value: string, language: ApplicationLanguage): string {
  return translationByText.get(value)?.[language] ?? value;
}
