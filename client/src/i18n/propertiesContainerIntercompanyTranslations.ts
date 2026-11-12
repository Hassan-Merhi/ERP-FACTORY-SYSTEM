import type { ApplicationLanguage } from "@shared/applicationLanguageContract";

const en = {
  title: "Intercompany Container Trading",
  subtitle: "Linked purchase orders, freight, receiving and cancellation stay attached to this physical container.",
  linkedTab: "Linked PO & Freight",
  lifecycleTab: "Receive / Cancel",
  loading: "Loading linked container details…",
  unauthorized: "Intercompany financial actions require Owner, Admin or Developer permissions.",
  failed: "Unable to load verified intercompany container records.",
  unlinked: "No intercompany trade is linked to this physical container. Use Properties Import PO to select its ERP destination.",
  importPo: "Import PO",
  destination: "Destination ERP",
  landed: "Confirmed landed cost",
  active: "In transit",
  received: "Received",
  canceled: "Canceled",
  status: "Trade status",
  closed: "Linked purchase order edits and freight changes are locked after receiving or cancellation.",
  confirm: "All cross-company ledger entries are validated together. Receiving never duplicates the physical Properties container.",
} as const;
type Labels = { [K in keyof typeof en]: string };
const translations: Record<ApplicationLanguage, Labels> = {
  en,
  fr: {
    title: "Échanges intersociétés du conteneur",
    subtitle: "Bons de commande liés, fret, réception et annulation restent attachés à ce conteneur physique.",
    linkedTab: "BC liés et fret",
    lifecycleTab: "Réception / annulation",
    loading: "Chargement des données liées au conteneur…",
    unauthorized: "Les actions financières intersociétés nécessitent les droits Propriétaire, Administrateur ou Développeur.",
    failed: "Impossible de charger les données intersociétés vérifiées.",
    unlinked: "Aucun échange intersociétés n'est associé à ce conteneur. Utilisez Import PO dans Propriétés pour définir la société ERP destinataire.",
    importPo: "Importer un BC",
    destination: "Société ERP destinataire",
    landed: "Coût rendu confirmé",
    active: "En transit",
    received: "Réceptionné",
    canceled: "Annulé",
    status: "Statut de l'échange",
    closed: "Les modifications des BC liés et du fret sont bloquées après réception ou annulation.",
    confirm: "Les écritures des deux sociétés sont validées ensemble. La réception ne duplique pas le conteneur physique dans Propriétés.",
  },
  ar: {
    title: "تجارة الحاويات بين الشركات",
    subtitle: "أوامر الشراء المرتبطة والشحن والاستلام والإلغاء كلها ضمن الحاوية الفعلية نفسها.",
    linkedTab: "أوامر الشراء والشحن",
    lifecycleTab: "الاستلام / الإلغاء",
    loading: "جارٍ تحميل بيانات الحاوية المرتبطة…",
    unauthorized: "تتطلب الإجراءات المالية بين الشركات صلاحيات المالك أو المسؤول أو المطوّر.",
    failed: "تعذر تحميل بيانات التعامل بين الشركات.",
    unlinked: "لا يوجد تعامل بين الشركات مرتبط بهذه الحاوية. استخدم استيراد أوامر الشراء في العقارات لتحديد الشركة المستلمة.",
    importPo: "استيراد أمر شراء",
    destination: "شركة ERP المستلمة",
    landed: "التكلفة المؤكدة بعد الشحن",
    active: "في الطريق",
    received: "تم الاستلام",
    canceled: "تم الإلغاء",
    status: "حالة التعامل",
    closed: "لا يمكن تعديل أوامر الشراء والشحن بعد الاستلام أو الإلغاء.",
    confirm: "يتم التحقق من قيود الشركتين معاً. لا ينشئ الاستلام حاوية فعلية مكررة في العقارات.",
  },
};

export function propertiesContainerIntercompanyText(language: ApplicationLanguage): Labels {
  return translations[language] ?? en;
}
