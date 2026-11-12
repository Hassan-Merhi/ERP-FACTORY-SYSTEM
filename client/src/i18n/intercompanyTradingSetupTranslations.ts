import type { ApplicationLanguage } from "@shared/applicationLanguageContract";

export const INTERCOMPANY_TRADING_EN = {
  addSupplier: "Add Supplier",
  containerDetails: "Container Details",
  offloadDetails: "Offload Details",
  partnerSetup: "Automatic partner setup",
  partnerDescription:
    "Choose an ERP destination. The system reuses verified accounts and the Properties supplier, creating missing records with zero opening balances. No cash or vouchers are posted.",
  setupLabel: "Accounting setup",
  chooseDestination: "Choose an ERP destination company",
  destinationCompany: "Destination company",
  chooseCompany: "Choose company",
  chooseDestinationStatus: "Choose a destination",
  ready: "Ready — accounts and supplier linked",
  notConfigured: "Not configured — automatic setup available",
  enableTrading: "Enable intercompany trading",
  verifySetup: "Verify automatic setup",
  settingUp: "Setting up company pair…",
  setupVerified: "Accounting setup verified",
  tradingReady: "Trading partner ready",
  reused: "Existing company-pair accounts and supplier were reused.",
  automaticSetupRejected: "Automatic setup rejected",
  createdAccounts: "account(s) created and",
  reusedAccounts: "reused",
  supplierCreated: "Properties supplier created.",
  supplierReused: "Existing Properties supplier reused.",
  payableExplanation:
    "The destination's actual payable is held once in its Properties supplier subledger. Mapping accounts support reconciliation without creating a second payable or stock movement.",
  readyDestinations: "Ready destinations:",
  none: "None yet",
} as const;

type TradingLabels = { [K in keyof typeof INTERCOMPANY_TRADING_EN]: string };

const translations: Record<ApplicationLanguage, TradingLabels> = {
  en: INTERCOMPANY_TRADING_EN,
  fr: {
    addSupplier: "Ajouter un fournisseur",
    containerDetails: "Détails du conteneur",
    offloadDetails: "Détails du déchargement",
    partnerSetup: "Configuration automatique du partenaire",
    partnerDescription:
      "Choisissez une société ERP destinataire. Le système réutilise les comptes vérifiés et le fournisseur Propriétés, et crée les données manquantes sans solde initial. Aucun paiement ni pièce comptable n'est enregistré.",
    setupLabel: "Configuration comptable",
    chooseDestination: "Choisissez une société ERP destinataire",
    destinationCompany: "Société destinataire",
    chooseCompany: "Choisir une société",
    chooseDestinationStatus: "Choisissez une destination",
    ready: "Prêt — comptes et fournisseur liés",
    notConfigured: "Non configuré — configuration automatique disponible",
    enableTrading: "Activer les échanges intersociétés",
    verifySetup: "Vérifier la configuration automatique",
    settingUp: "Configuration des sociétés…",
    setupVerified: "Configuration comptable vérifiée",
    tradingReady: "Partenaire commercial prêt",
    reused: "Les comptes et le fournisseur existants ont été réutilisés.",
    automaticSetupRejected: "Configuration automatique refusée",
    createdAccounts: "compte(s) créé(s) et",
    reusedAccounts: "réutilisé(s)",
    supplierCreated: "Fournisseur Propriétés créé.",
    supplierReused: "Fournisseur Propriétés existant réutilisé.",
    payableExplanation:
      "La dette réelle est enregistrée une seule fois dans le compte fournisseur de la société destinataire. Les comptes de liaison servent au rapprochement sans doubler les dettes ni les stocks.",
    readyDestinations: "Destinations prêtes :",
    none: "Aucune",
  },
  ar: {
    addSupplier: "إضافة مورّد",
    containerDetails: "تفاصيل الحاوية",
    offloadDetails: "تفاصيل التفريغ",
    partnerSetup: "إعداد الشريك تلقائياً",
    partnerDescription:
      "اختر شركة ERP المستلمة. يعيد النظام استخدام الحسابات الموثقة ومورّد العقارات وينشئ السجلات الناقصة بأرصدة افتتاحية صفرية، من دون تسجيل مدفوعات أو قيود.",
    setupLabel: "إعداد المحاسبة",
    chooseDestination: "اختر شركة ERP المستلمة",
    destinationCompany: "الشركة المستلمة",
    chooseCompany: "اختر شركة",
    chooseDestinationStatus: "اختر وجهة",
    ready: "جاهز — الحسابات والمورّد مرتبطون",
    notConfigured: "غير مهيأ — الإعداد التلقائي متاح",
    enableTrading: "تفعيل التعامل بين الشركات",
    verifySetup: "التحقق من الإعداد التلقائي",
    settingUp: "جارٍ إعداد الشركتين…",
    setupVerified: "تم التحقق من إعداد المحاسبة",
    tradingReady: "الشريك التجاري جاهز",
    reused: "تم استخدام الحسابات والمورّد الموجودين من قبل.",
    automaticSetupRejected: "تم رفض الإعداد التلقائي",
    createdAccounts: "حسابات أُنشئت و",
    reusedAccounts: "أُعيد استخدامها",
    supplierCreated: "تم إنشاء مورّد العقارات.",
    supplierReused: "تم استخدام مورّد العقارات الموجود.",
    payableExplanation:
      "يُسجَّل الالتزام الفعلي مرة واحدة فقط في حساب مورّد العقارات لدى الشركة المستلمة، وتُستخدم حسابات الربط للتسوية دون تكرار الالتزامات أو المخزون.",
    readyDestinations: "الوجهات الجاهزة:",
    none: "لا يوجد",
  },
};

export function intercompanyTradingSetupText(language: ApplicationLanguage): TradingLabels {
  return translations[language] ?? INTERCOMPANY_TRADING_EN;
}
