import type { ApplicationLanguage } from "@shared/applicationLanguageContract";
import type { Phase7BackendMessagesEntry } from "./backendMessagesPhase7TranslationTypes";

export const remoteSupportPhase6Translations: readonly Phase7BackendMessagesEntry[] = [
  { en: "Keyboard control", ar: "التحكم بلوحة المفاتيح", fr: "Contrôle du clavier" },
  { en: "Stop keyboard", ar: "إيقاف لوحة المفاتيح", fr: "Arrêter le clavier" },
  { en: "Enable keyboard", ar: "تفعيل لوحة المفاتيح", fr: "Activer le clavier" },
  { en: "Mouse control required", ar: "يلزم تفعيل الماوس", fr: "Le contrôle de la souris est requis" },
  {
    en: "Confirm your password to enable keyboard control for up to 5 minutes.",
    ar: "أكد كلمة المرور لتفعيل التحكم بلوحة المفاتيح لمدة تصل إلى 5 دقائق.",
    fr: "Confirmez votre mot de passe pour activer le contrôle du clavier pendant 5 minutes maximum.",
  },
  {
    en: "Click a safe field in the watched screen, then type here.",
    ar: "انقر على حقل آمن في الشاشة المشاهدة، ثم اكتب هنا.",
    fr: "Cliquez sur un champ sûr dans l’écran observé, puis saisissez ici.",
  },
  { en: "Type remote text here", ar: "اكتب النص البعيد هنا", fr: "Saisissez le texte distant ici" },
  {
    en: "Only safe search, filter and explicitly approved fields can be edited.",
    ar: "يمكن تعديل حقول البحث والتصفية والحقول المعتمدة صراحةً فقط.",
    fr: "Seuls les champs sûrs de recherche, de filtre et explicitement approuvés peuvent être modifiés.",
  },
  {
    en: "Clipboard shortcuts and paste are blocked.",
    ar: "اختصارات الحافظة واللصق محظورة.",
    fr: "Les raccourcis du presse-papiers et le collage sont bloqués.",
  },
  {
    en: "That field is protected and cannot be edited remotely.",
    ar: "هذا الحقل محمي ولا يمكن تعديله عن بُعد.",
    fr: "Ce champ est protégé et ne peut pas être modifié à distance.",
  },
  {
    en: "Unable to enable keyboard control.",
    ar: "تعذر تفعيل التحكم بلوحة المفاتيح.",
    fr: "Impossible d’activer le contrôle du clavier.",
  },
  {
    en: "Keyboard command failed.",
    ar: "فشل أمر لوحة المفاتيح.",
    fr: "La commande clavier a échoué.",
  },
  {
    en: "Remote control request failed.",
    ar: "فشل طلب التحكم عن بُعد.",
    fr: "La requête de contrôle à distance a échoué.",
  },
  {
    en: "Keyboard control is disabled.",
    ar: "التحكم بلوحة المفاتيح معطل.",
    fr: "Le contrôle du clavier est désactivé.",
  },
  {
    en: "Enable mouse control before keyboard control.",
    ar: "فعّل التحكم بالماوس قبل التحكم بلوحة المفاتيح.",
    fr: "Activez le contrôle de la souris avant le contrôle du clavier.",
  },
  {
    en: "This keyboard channel is not bound to this ERP tab.",
    ar: "قناة لوحة المفاتيح هذه غير مرتبطة بعلامة تبويب ERP هذه.",
    fr: "Ce canal clavier n’est pas lié à cet onglet ERP.",
  },
  {
    en: "Keyboard commands are being sent too quickly.",
    ar: "يتم إرسال أوامر لوحة المفاتيح بسرعة كبيرة.",
    fr: "Les commandes clavier sont envoyées trop rapidement.",
  },
  {
    en: "Confirm your password before enabling keyboard control.",
    ar: "أكد كلمة المرور قبل تفعيل التحكم بلوحة المفاتيح.",
    fr: "Confirmez votre mot de passe avant d’activer le contrôle du clavier.",
  },
  {
    en: "Unsupported keyboard command.",
    ar: "أمر لوحة مفاتيح غير مدعوم.",
    fr: "Commande clavier non prise en charge.",
  },
  {
    en: "Keyboard text is invalid or too long.",
    ar: "نص لوحة المفاتيح غير صالح أو طويل جدًا.",
    fr: "Le texte clavier est invalide ou trop long.",
  },
  {
    en: "This keyboard key is not allowed.",
    ar: "مفتاح لوحة المفاتيح هذا غير مسموح.",
    fr: "Cette touche du clavier n’est pas autorisée.",
  },
  {
    en: "The employee ERP tab is not ready to receive keyboard commands.",
    ar: "علامة تبويب ERP الخاصة بالموظف غير جاهزة لاستقبال أوامر لوحة المفاتيح.",
    fr: "L’onglet ERP de l’employé n’est pas prêt à recevoir les commandes clavier.",
  },
  {
    en: "Keyboard command not found.",
    ar: "لم يتم العثور على أمر لوحة المفاتيح.",
    fr: "Commande clavier introuvable.",
  },
  {
    en: "Unsupported keyboard command result.",
    ar: "نتيجة أمر لوحة المفاتيح غير مدعومة.",
    fr: "Résultat de commande clavier non pris en charge.",
  },
  {
    en: "RemoteControllerSessionProvider is missing.",
    ar: "موفّر جلسة التحكم عن بُعد غير موجود.",
    fr: "Le fournisseur de session de contrôle à distance est manquant.",
  },
  {
    en: "Remote-control send failed.",
    ar: "فشل إرسال أمر التحكم عن بُعد.",
    fr: "Échec de l’envoi de la commande à distance.",
  },
  {
    en: "Legacy frame producer is sending too quickly.",
    ar: "مرسل الإطارات القديم يرسل بسرعة كبيرة.",
    fr: "L’émetteur d’images hérité envoie trop rapidement.",
  },
  {
    en: "ERP tab identifier is required.",
    ar: "معرّف علامة تبويب ERP مطلوب.",
    fr: "L’identifiant de l’onglet ERP est requis.",
  },
  {
    en: "ERP tab belongs to a different company context.",
    ar: "علامة تبويب ERP تابعة لسياق شركة مختلف.",
    fr: "L’onglet ERP appartient à un autre contexte d’entreprise.",
  },
  {
    en: "A user and ERP tab are required.",
    ar: "يجب تحديد مستخدم وعلامة تبويب ERP.",
    fr: "Un utilisateur et un onglet ERP sont requis.",
  },
  {
    en: "The selected ERP tab is no longer available.",
    ar: "علامة تبويب ERP المحددة لم تعد متاحة.",
    fr: "L’onglet ERP sélectionné n’est plus disponible.",
  },
  {
    en: "Invalid screen frame packet.",
    ar: "حزمة إطار الشاشة غير صالحة.",
    fr: "Le paquet d’image écran est invalide.",
  },
  {
    en: "Bind the ERP tab before sending frames.",
    ar: "اربط علامة تبويب ERP قبل إرسال الإطارات.",
    fr: "Liez l’onglet ERP avant d’envoyer des images.",
  },
  {
    en: "Remote support header is too large.",
    ar: "ترويسة الدعم عن بُعد كبيرة جدًا.",
    fr: "L’en-tête de support à distance est trop volumineux.",
  },
  {
    en: "Remote support frame is too large.",
    ar: "إطار الدعم عن بُعد كبير جدًا.",
    fr: "L’image de support à distance est trop volumineuse.",
  },
  { en: "Mouse active", ar: "الماوس نشط", fr: "Souris active" },
  { en: "Keyboard active", ar: "لوحة المفاتيح نشطة", fr: "Clavier actif" },
  { en: "Mouse and keyboard active", ar: "الماوس ولوحة المفاتيح نشطان", fr: "Souris et clavier actifs" },
];

const translationByText = new Map<string, Phase7BackendMessagesEntry>();
for (const entry of remoteSupportPhase6Translations) {
  translationByText.set(entry.en, entry);
  translationByText.set(entry.ar, entry);
  translationByText.set(entry.fr, entry);
}

export function translateRemoteSupportPhase6Text(value: string, language: ApplicationLanguage): string {
  return translationByText.get(value)?.[language] ?? value;
}
