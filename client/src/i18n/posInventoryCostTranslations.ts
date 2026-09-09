import type { ApplicationLanguage } from "@shared/applicationLanguageContract";

const posInventoryCostTranslations = {
  loadPermissionsFailed: {
    en: "Unable to load security permissions",
    ar: "تعذر تحميل أذونات الأمان",
    fr: "Impossible de charger les autorisations de sécurité",
  },
  permissionsLoading: {
    en: "Permissions are still loading",
    ar: "لا تزال الأذونات قيد التحميل",
    fr: "Les autorisations sont encore en cours de chargement",
  },
  switchCompany: {
    en: "Switch to this company before changing POS cost access",
    ar: "انتقل إلى هذه الشركة قبل تغيير صلاحية عرض التكلفة لمستخدم نقطة البيع",
    fr: "Passez à cette société avant de modifier l’accès aux coûts du point de vente",
  },
  updateFailed: {
    en: "Failed to update POS cost access",
    ar: "تعذر تحديث صلاحية عرض التكلفة لمستخدم نقطة البيع",
    fr: "Impossible de mettre à jour l’accès aux coûts du point de vente",
  },
  enabledTitle: {
    en: "Cost price enabled",
    ar: "تم تفعيل عرض سعر التكلفة",
    fr: "Affichage du coût activé",
  },
  hiddenTitle: {
    en: "Cost price hidden",
    ar: "تم إخفاء سعر التكلفة",
    fr: "Coût masqué",
  },
  updatedDescription: {
    en: "This POS user's stock inventory cost access has been updated for this company.",
    ar: "تم تحديث صلاحية هذا المستخدم لعرض تكلفة المخزون في هذه الشركة.",
    fr: "L’accès de cet utilisateur POS aux coûts du stock a été mis à jour pour cette société.",
  },
  updateErrorTitle: {
    en: "Could not update cost access",
    ar: "تعذر تحديث صلاحية عرض التكلفة",
    fr: "Impossible de modifier l’accès aux coûts",
  },
  loadError: {
    en: "Cost-price permission could not be loaded. You may need Security Permissions access.",
    ar: "تعذر تحميل صلاحية سعر التكلفة. قد تحتاج إلى صلاحية إدارة أذونات الأمان.",
    fr: "L’autorisation d’afficher le coût n’a pas pu être chargée. L’accès à la gestion des autorisations de sécurité peut être requis.",
  },
  title: {
    en: "Show cost price in Stock Inventory",
    ar: "إظهار سعر التكلفة في مخزون الأصناف",
    fr: "Afficher le coût dans le stock",
  },
  description: {
    en: "Allows this POS user to see Avg Rate and Total Value in assigned locations. Other POS users remain hidden.",
    ar: "يسمح لهذا المستخدم برؤية متوسط السعر والقيمة الإجمالية في المواقع المخصصة له. تبقى التكلفة مخفية عن مستخدمي نقطة البيع الآخرين.",
    fr: "Permet à cet utilisateur POS de voir le coût moyen et la valeur totale dans les emplacements qui lui sont attribués. Les coûts restent masqués pour les autres utilisateurs POS.",
  },
  ariaLabel: {
    en: "Show inventory cost price for this POS user",
    ar: "إظهار سعر تكلفة المخزون لهذا المستخدم",
    fr: "Afficher le coût du stock pour cet utilisateur POS",
  },
} as const satisfies Record<string, Record<ApplicationLanguage, string>>;

export type PosInventoryCostTranslationKey = keyof typeof posInventoryCostTranslations;

export function translatePosInventoryCostText(
  key: PosInventoryCostTranslationKey,
  language: ApplicationLanguage
): string {
  const entry = posInventoryCostTranslations[key];
  return entry[language] || entry.en;
}
