import type { ApplicationLanguage } from "@shared/applicationLanguageContract";
import { intercompanyBackendPhrases } from "./intercompanyContainerTradingTranslations.backend";

type Phrase = { en: string; ar: string; fr: string };

/** Intercompany container trading screens (import, linked POs, payments, lifecycle) in English, Arabic, and French. */
const intercompanyInterfacePhrases: readonly Phrase[] = [
  { en: "Trading", ar: "التجارة", fr: "Négoce" },
  { en: "Container Trading", ar: "تجارة الحاويات", fr: "Négoce de conteneurs" },
  { en: "Linked POs & Freight", ar: "أوامر الشراء المرتبطة والشحن", fr: "Commandes liées et fret" },
  {
    en: "Intercompany Payments & Credits",
    ar: "المدفوعات والأرصدة بين الشركات",
    fr: "Paiements et crédits intersociétés",
  },
  { en: "Receiving & Cancellation", ar: "الاستلام والإلغاء", fr: "Réception et annulation" },
  { en: "Intercompany Payments", ar: "المدفوعات بين الشركات", fr: "Paiements intersociétés" },
  {
    en: "Intercompany Receiving & Cancellation",
    ar: "الاستلام والإلغاء بين الشركات",
    fr: "Réception et annulation intersociétés",
  },
  { en: "Linked container lifecycle", ar: "دورة حياة الحاوية المرتبطة", fr: "Cycle de vie du conteneur lié" },
  { en: "ERP destination", ar: "الشركة الوجهة في النظام", fr: "Destination ERP" },
  { en: "Confirmed cost", ar: "التكلفة المؤكدة", fr: "Coût confirmé" },
  { en: "State", ar: "الحالة", fr: "État" },
  {
    en: "Trade canceled. Original supplier invoices and real cash transactions remain auditable.",
    ar: "تم إلغاء الصفقة. تبقى فواتير المورد الأصلية والحركات النقدية الفعلية قابلة للتدقيق.",
    fr: "Transaction annulée. Les factures fournisseur d’origine et les mouvements de trésorerie réels restent vérifiables.",
  },
  { en: "Actual posting date", ar: "تاريخ الترحيل الفعلي", fr: "Date de comptabilisation réelle" },
  { en: "Documented accounting reason", ar: "السبب المحاسبي الموثق", fr: "Motif comptable documenté" },
  {
    en: "Arrival or cancellation supporting evidence",
    ar: "المستندات المؤيدة للوصول أو الإلغاء",
    fr: "Justificatifs d’arrivée ou d’annulation",
  },
  { en: "Receive into this ERP company", ar: "الاستلام في هذه الشركة", fr: "Réceptionner dans cette société ERP" },
  { en: "Actual receiving warehouse", ar: "مستودع الاستلام الفعلي", fr: "Entrepôt de réception réel" },
  { en: "Choose ERP location", ar: "اختر موقعًا في النظام", fr: "Choisissez un emplacement ERP" },
  {
    en: "Existing ERP INVENTORY asset account",
    ar: "حساب أصول المخزون الموجود في النظام",
    fr: "Compte d’actif de stock ERP existant",
  },
  {
    en: "Choose verified inventory account",
    ar: "اختر حساب مخزون موثقًا",
    fr: "Choisissez un compte de stock vérifié",
  },
  {
    en: "Cancel before goods are received",
    ar: "الإلغاء قبل استلام البضاعة",
    fr: "Annuler avant la réception des marchandises",
  },
  {
    en: "Cannot access the verified linked trade records.",
    ar: "تعذّر الوصول إلى سجلات الصفقات المرتبطة الموثقة.",
    fr: "Impossible d’accéder aux transactions liées vérifiées.",
  },
  {
    en: "Cannot read intercompany lifecycle",
    ar: "تعذّرت قراءة دورة الحياة بين الشركات",
    fr: "Impossible de lire le cycle de vie intersociétés",
  },
  {
    en: "Destination ERP inventory received",
    ar: "تم استلام مخزون الشركة الوجهة",
    fr: "Stock de la société destinataire réceptionné",
  },
  {
    en: "One GIT-to-INVENTORY voucher and canonical stock evidence were posted together.",
    ar: "تم ترحيل قيد واحد من البضاعة بالطريق إلى المخزون مع إثبات المخزون المعتمد معًا.",
    fr: "Une pièce marchandises en transit vers stock et la preuve de stock de référence ont été comptabilisées ensemble.",
  },
  { en: "Receipt not posted", ar: "لم يتم ترحيل الاستلام", fr: "Réception non comptabilisée" },
  {
    en: "Unreceived internal trade canceled",
    ar: "تم إلغاء الصفقة الداخلية غير المستلمة",
    fr: "Transaction interne non réceptionnée annulée",
  },
  {
    en: "Original purchases and cash retained;",
    ar: "تم الاحتفاظ بالمشتريات الأصلية والنقد؛",
    fr: "Achats d’origine et trésorerie conservés ;",
  },
  {
    en: "Bank statements or receipt references",
    ar: "كشوف الحساب المصرفية أو مراجع الإيصالات",
    fr: "Relevés bancaires ou références de reçus",
  },
  {
    en: "Destination company relationship",
    ar: "علاقة الشركة الوجهة",
    fr: "Relation avec la société destinataire",
  },
  { en: "Choose an enabled relationship", ar: "اختر علاقة مفعّلة", fr: "Choisissez une relation activée" },
  {
    en: "Confirm actual payment and receipt",
    ar: "تأكيد الدفع والقبض الفعليين",
    fr: "Confirmer le paiement et l’encaissement réels",
  },
  { en: "Actual payment date", ar: "تاريخ الدفع الفعلي", fr: "Date de paiement réelle" },
  { en: "Actual amount", ar: "المبلغ الفعلي", fr: "Montant réel" },
  { en: "Original currency", ar: "العملة الأصلية", fr: "Devise d’origine" },
  {
    en: "Historical exchange rate (currency units per USD)",
    ar: "سعر الصرف التاريخي (وحدات العملة لكل دولار أمريكي)",
    fr: "Taux de change historique (unités de devise par USD)",
  },
  {
    en: "Properties — confirmed receiving cash/bank",
    ar: "العقارات — حساب النقد/البنك المستلم المؤكد",
    fr: "Properties — caisse/banque d’encaissement confirmée",
  },
  {
    en: "ERP — confirmed paying cash/bank",
    ar: "النظام — حساب النقد/البنك الدافع المؤكد",
    fr: "ERP — caisse/banque de paiement confirmée",
  },
  {
    en: "Bank / cash transfer reference",
    ar: "مرجع التحويل المصرفي / النقدي",
    fr: "Référence du virement bancaire / espèces",
  },
  {
    en: "Proof of both actual money movements",
    ar: "إثبات حركتي الأموال الفعليتين",
    fr: "Preuve des deux mouvements de fonds réels",
  },
  { en: "Accounting reason", ar: "السبب المحاسبي", fr: "Motif comptable" },
  { en: "Confirmed landed cost", ar: "التكلفة الواصلة المؤكدة", fr: "Coût de revient confirmé" },
  { en: "Allocate now (USD)", ar: "التخصيص الآن (دولار أمريكي)", fr: "Affecter maintenant (USD)" },
  {
    en: "Payment, credit and reversal history",
    ar: "سجل المدفوعات والأرصدة والعكوسات",
    fr: "Historique des paiements, crédits et contre-passations",
  },
  { en: "Actual date", ar: "التاريخ الفعلي", fr: "Date réelle" },
  { en: "Transfer reference", ar: "مرجع التحويل", fr: "Référence du virement" },
  { en: "Historical payment", ar: "دفعة تاريخية", fr: "Paiement historique" },
  { en: "Unused credit", ar: "رصيد غير مستخدم", fr: "Crédit non utilisé" },
  {
    en: "Permitted reversal posting date",
    ar: "تاريخ ترحيل العكس المسموح به",
    fr: "Date de comptabilisation autorisée pour la contre-passation",
  },
  { en: "Documented reversal reason", ar: "سبب العكس الموثق", fr: "Motif de contre-passation documenté" },
  {
    en: "Payments between Hassan Properties and one destination ERP company remain separate.",
    ar: "تبقى المدفوعات بين Hassan Properties وكل شركة وجهة في النظام منفصلة.",
    fr: "Les paiements entre Hassan Properties et chaque société ERP destinataire restent séparés.",
  },
  {
    en: "Company-pair payment access is unavailable.",
    ar: "الوصول إلى مدفوعات هذا الزوج من الشركات غير متاح.",
    fr: "L’accès aux paiements de cette paire de sociétés est indisponible.",
  },
  {
    en: "Cannot access the verified partner accounts. Check company permissions.",
    ar: "تعذّر الوصول إلى حسابات الشريك الموثقة. تحقق من صلاحيات الشركة.",
    fr: "Impossible d’accéder aux comptes partenaires vérifiés. Vérifiez les autorisations de la société.",
  },
  {
    en: "One bank transfer is recorded once and linked to both company vouchers. Reversals are append-only.",
    ar: "يُسجَّل التحويل المصرفي الواحد مرة واحدة ويُربط بقيدي الشركتين. العكوسات تُضاف فقط ولا تُعدَّل.",
    fr: "Un virement bancaire est enregistré une seule fois et lié aux pièces des deux sociétés. Les contre-passations sont uniquement ajoutées.",
  },
  { en: "Reverse both vouchers", ar: "عكس القيدين", fr: "Contre-passer les deux pièces" },
  {
    en: "Post audited paired reversal",
    ar: "ترحيل العكس المزدوج المدقق",
    fr: "Comptabiliser la contre-passation jumelée auditée",
  },
  {
    en: "Could not read payment data",
    ar: "تعذّرت قراءة بيانات الدفع",
    fr: "Impossible de lire les données de paiement",
  },
  {
    en: "Actual payment mirrored in both companies",
    ar: "تم تسجيل الدفعة الفعلية في الشركتين",
    fr: "Paiement réel reflété dans les deux sociétés",
  },
  { en: "Payment #", ar: "الدفعة رقم", fr: "Paiement n°" },
  { en: "No cash was posted", ar: "لم يُرحَّل أي نقد", fr: "Aucun mouvement de trésorerie comptabilisé" },
  {
    en: "Both payment vouchers reversed together",
    ar: "تم عكس قيدي الدفع معًا",
    fr: "Les deux pièces de paiement ont été contre-passées ensemble",
  },
  {
    en: "Original vouchers and historical FX evidence were preserved.",
    ar: "تم الحفاظ على القيود الأصلية وإثبات سعر الصرف التاريخي.",
    fr: "Les pièces d’origine et la preuve du taux de change historique ont été conservées.",
  },
  { en: "Reversal was not posted", ar: "لم يتم ترحيل العكس", fr: "La contre-passation n’a pas été comptabilisée" },
  {
    en: "Choose an active cash or bank account",
    ar: "اختر حساب نقد أو بنك نشطًا",
    fr: "Choisissez un compte de caisse ou de banque actif",
  },
  {
    en: "Linked Container POs & Shared Charges",
    ar: "أوامر شراء الحاويات المرتبطة والمصاريف المشتركة",
    fr: "Commandes de conteneurs liées et frais partagés",
  },
  { en: "Invoice ID", ar: "معرّف الفاتورة", fr: "ID de facture" },
  { en: "Linked purchase orders", ar: "أوامر الشراء المرتبطة", fr: "Commandes d’achat liées" },
  { en: "Loading linked containers…", ar: "جارٍ تحميل الحاويات المرتبطة…", fr: "Chargement des conteneurs liés…" },
  { en: "Original PO", ar: "أمر الشراء الأصلي", fr: "Commande d’origine" },
  { en: "Item description", ar: "وصف الصنف", fr: "Description de l’article" },
  { en: "Original line total", ar: "إجمالي السطر الأصلي", fr: "Total de ligne d’origine" },
  { en: "Adjustment posting date", ar: "تاريخ ترحيل التسوية", fr: "Date de comptabilisation de l’ajustement" },
  { en: "Reason / source evidence", ar: "السبب / مستند المصدر", fr: "Motif / justificatif source" },
  {
    en: "Confirm a shared freight or handling invoice",
    ar: "تأكيد فاتورة شحن أو مناولة مشتركة",
    fr: "Confirmer une facture partagée de fret ou de manutention",
  },
  { en: "Original invoice reference", ar: "مرجع الفاتورة الأصلية", fr: "Référence de la facture d’origine" },
  { en: "Invoice total (USD)", ar: "إجمالي الفاتورة (دولار أمريكي)", fr: "Total de la facture (USD)" },
  { en: "Handling / other", ar: "مناولة / أخرى", fr: "Manutention / autre" },
  { en: "Posting date", ar: "تاريخ الترحيل", fr: "Date de comptabilisation" },
  {
    en: "Verified invoice document / evidence",
    ar: "مستند / إثبات الفاتورة الموثق",
    fr: "Document / justificatif de facture vérifié",
  },
  { en: "Confirmed allocation", ar: "التوزيع المؤكد", fr: "Répartition confirmée" },
  {
    en: "Review or redistribute a confirmed invoice",
    ar: "مراجعة فاتورة مؤكدة أو إعادة توزيعها",
    fr: "Examiner ou redistribuer une facture confirmée",
  },
  { en: "Shared invoice ID", ar: "معرّف الفاتورة المشتركة", fr: "ID de facture partagée" },
  { en: "Revised allocation (USD)", ar: "التوزيع المعدّل (دولار أمريكي)", fr: "Répartition révisée (USD)" },
  { en: "Reason for redistribution", ar: "سبب إعادة التوزيع", fr: "Motif de la redistribution" },
  {
    en: "Grant Shared Charge Editor access",
    ar: "منح صلاحية محرر المصاريف المشتركة",
    fr: "Accorder l’accès Éditeur de frais partagés",
  },
  { en: "User ID", ar: "معرّف المستخدم", fr: "ID utilisateur" },
  { en: "Involved company relationship", ar: "علاقة الشركات المعنية", fr: "Relation entre les sociétés concernées" },
  { en: "Choose relationship", ar: "اختر العلاقة", fr: "Choisissez la relation" },
  { en: "Permission scope", ar: "نطاق الصلاحية", fr: "Portée de l’autorisation" },
  { en: "This invoice only", ar: "هذه الفاتورة فقط", fr: "Cette facture uniquement" },
  {
    en: "All invoices on this company pair",
    ar: "كل فواتير هذا الزوج من الشركات",
    fr: "Toutes les factures de cette paire de sociétés",
  },
  {
    en: "Choose a container in this company, then edit quantities, rates or item descriptions.",
    ar: "اختر حاوية في هذه الشركة ثم عدّل الكميات أو الأسعار أو أوصاف الأصناف.",
    fr: "Choisissez un conteneur de cette société, puis modifiez les quantités, les prix ou les descriptions d’articles.",
  },
  {
    en: "Preview proportional allocation",
    ar: "معاينة التوزيع النسبي",
    fr: "Aperçu de la répartition proportionnelle",
  },
  {
    en: "Confirm and post shared invoice",
    ar: "تأكيد الفاتورة المشتركة وترحيلها",
    fr: "Confirmer et comptabiliser la facture partagée",
  },
  {
    en: "Confirmed allocations do not automatically change when a container's purchase price changes.",
    ar: "لا تتغير التوزيعات المؤكدة تلقائيًا عند تغيّر سعر شراء الحاوية.",
    fr: "Les répartitions confirmées ne changent pas automatiquement lorsque le prix d’achat d’un conteneur change.",
  },
  { en: "Load verified invoice", ar: "تحميل الفاتورة الموثقة", fr: "Charger la facture vérifiée" },
  {
    en: "Invoice not found or you do not have Shared Charge Editor access.",
    ar: "الفاتورة غير موجودة أو لا تملك صلاحية محرر المصاريف المشتركة.",
    fr: "Facture introuvable ou vous n’avez pas l’accès Éditeur de frais partagés.",
  },
  {
    en: "Apply verified allocation changes",
    ar: "تطبيق تغييرات التوزيع الموثقة",
    fr: "Appliquer les modifications de répartition vérifiées",
  },
  { en: "Grant editor permission", ar: "منح صلاحية المحرر", fr: "Accorder l’autorisation d’éditeur" },
  { en: "Both companies synchronized", ar: "تمت مزامنة الشركتين", fr: "Les deux sociétés sont synchronisées" },
  {
    en: "The price adjustment and accounting vouchers were posted together.",
    ar: "تم ترحيل تسوية السعر والقيود المحاسبية معًا.",
    fr: "L’ajustement de prix et les pièces comptables ont été comptabilisés ensemble.",
  },
  { en: "Edit refused", ar: "تم رفض التعديل", fr: "Modification refusée" },
  { en: "Proposed allocation ready", ar: "التوزيع المقترح جاهز", fr: "Répartition proposée prête" },
  {
    en: "Review and confirm these amounts; they are not posted yet.",
    ar: "راجع هذه المبالغ وأكّدها؛ لم تُرحَّل بعد.",
    fr: "Vérifiez et confirmez ces montants ; ils ne sont pas encore comptabilisés.",
  },
  { en: "Allocation not available", ar: "التوزيع غير متاح", fr: "Répartition indisponible" },
  { en: "Shared invoice confirmed", ar: "تم تأكيد الفاتورة المشتركة", fr: "Facture partagée confirmée" },
  {
    en: "Every affected linked PO was updated atomically.",
    ar: "تم تحديث كل أوامر الشراء المرتبطة المتأثرة في عملية واحدة.",
    fr: "Toutes les commandes liées concernées ont été mises à jour en une seule opération.",
  },
  { en: "Confirmation refused", ar: "تم رفض التأكيد", fr: "Confirmation refusée" },
  { en: "Confirmed allocation updated", ar: "تم تحديث التوزيع المؤكد", fr: "Répartition confirmée mise à jour" },
  {
    en: "Original invoice amount was preserved.",
    ar: "تم الحفاظ على مبلغ الفاتورة الأصلي.",
    fr: "Le montant de la facture d’origine a été conservé.",
  },
  { en: "Redistribution refused", ar: "تم رفض إعادة التوزيع", fr: "Redistribution refusée" },
  {
    en: "Shared Charge Editor permission granted",
    ar: "تم منح صلاحية محرر المصاريف المشتركة",
    fr: "Autorisation Éditeur de frais partagés accordée",
  },
  { en: "Permission not granted", ar: "لم تُمنح الصلاحية", fr: "Autorisation non accordée" },
  { en: "Preview the allocations first", ar: "عاين التوزيعات أولًا", fr: "Prévisualisez d’abord les répartitions" },
  { en: "Load an invoice to revise", ar: "حمّل فاتورة لمراجعتها", fr: "Chargez une facture à réviser" },
  { en: "Load an invoice first", ar: "حمّل فاتورة أولًا", fr: "Chargez d’abord une facture" },
  {
    en: "Supplier invoice / freight document reference",
    ar: "مرجع فاتورة المورد / مستند الشحن",
    fr: "Référence de la facture fournisseur / du document de fret",
  },
  {
    en: "Choose a verified ledger account",
    ar: "اختر حساب دفتر أستاذ موثقًا",
    fr: "Choisissez un compte de grand livre vérifié",
  },
  {
    en: "Each container belongs to one destination. No markup, cash payment or duplicate stock is created.",
    ar: "تنتمي كل حاوية إلى وجهة واحدة. لا يُنشأ أي هامش ربح أو دفعة نقدية أو مخزون مكرر.",
    fr: "Chaque conteneur appartient à une seule destination. Aucune marge, aucun paiement en espèces ni stock en double n’est créé.",
  },
  {
    en: "Loading authorized company relationships…",
    ar: "جارٍ تحميل علاقات الشركات المصرّح بها…",
    fr: "Chargement des relations de sociétés autorisées…",
  },
  { en: "Partner setup", ar: "إعداد الشريك", fr: "Configuration du partenaire" },
  { en: "Choose company", ar: "اختر الشركة", fr: "Choisissez la société" },
  { en: "Enabled destination pairs", ar: "أزواج الوجهات المفعّلة", fr: "Paires de destination activées" },
  {
    en: "Destination's supplier representing Properties",
    ar: "مورد الشركة الوجهة الذي يمثل Properties",
    fr: "Fournisseur de la destination représentant Properties",
  },
  { en: "Choose existing supplier", ar: "اختر موردًا موجودًا", fr: "Choisissez un fournisseur existant" },
  { en: "Import supplier Excel", ar: "استيراد ملف Excel للمورد", fr: "Importer le fichier Excel du fournisseur" },
  { en: "Original supplier workbook", ar: "ملف المورد الأصلي", fr: "Classeur fournisseur d’origine" },
  { en: "Original external supplier", ar: "المورد الخارجي الأصلي", fr: "Fournisseur externe d’origine" },
  {
    en: "Choose supplier (e.g., Eurogulf)",
    ar: "اختر المورد (مثل Eurogulf)",
    fr: "Choisissez le fournisseur (p. ex. Eurogulf)",
  },
  { en: "Import / posting date", ar: "تاريخ الاستيراد / الترحيل", fr: "Date d’import / de comptabilisation" },
  { en: "Container / PO lines", ar: "أسطر الحاوية / أمر الشراء", fr: "Lignes conteneur / commande" },
  { en: "Goods value", ar: "قيمة البضاعة", fr: "Valeur des marchandises" },
  { en: "Sheet charges", ar: "مصاريف الورقة", fr: "Frais de la feuille" },
  { en: "Confirmed charges", ar: "المصاريف المؤكدة", fr: "Frais confirmés" },
  {
    en: "Linked purchase orders created",
    ar: "تم إنشاء أوامر الشراء المرتبطة",
    fr: "Commandes d’achat liées créées",
  },
  {
    en: "Original supplier PO IDs",
    ar: "معرّفات أوامر شراء المورد الأصلية",
    fr: "ID des commandes fournisseur d’origine",
  },
  { en: "Linked PO ID", ar: "معرّف أمر الشراء المرتبط", fr: "ID de commande liée" },
  {
    en: "Confirmed, include in landed cost",
    ar: "مؤكد، يُضاف إلى التكلفة الواصلة",
    fr: "Confirmé, inclure dans le coût de revient",
  },
  { en: "Trading partner configured", ar: "تم إعداد الشريك التجاري", fr: "Partenaire commercial configuré" },
  {
    en: "This company pair can now be selected during import.",
    ar: "يمكن الآن اختيار هذا الزوج من الشركات أثناء الاستيراد.",
    fr: "Cette paire de sociétés peut désormais être sélectionnée lors de l’import.",
  },
  { en: "Configuration rejected", ar: "تم رفض الإعداد", fr: "Configuration rejetée" },
  { en: "Workbook parsed", ar: "تمت قراءة الملف", fr: "Classeur analysé" },
  { en: "Atomic import complete", ar: "اكتمل الاستيراد في عملية واحدة", fr: "Import atomique terminé" },
  {
    en: "Import rejected — nothing partially posted",
    ar: "تم رفض الاستيراد — لم يُرحَّل أي جزء",
    fr: "Import rejeté — rien n’a été comptabilisé partiellement",
  },
  {
    en: "Choose a destination and every account / supplier mapping",
    ar: "اختر وجهة وكل ربط للحسابات / الموردين",
    fr: "Choisissez une destination et chaque correspondance compte / fournisseur",
  },
  { en: "Choose a destination for", ar: "اختر وجهة لـ", fr: "Choisissez une destination pour" },
  {
    en: "Enter confirmed charge evidence for",
    ar: "أدخل إثبات المصروف المؤكد لـ",
    fr: "Saisissez le justificatif des frais confirmés pour",
  },
];

const translations = new Map<string, Phrase>(
  [...intercompanyInterfacePhrases, ...intercompanyBackendPhrases].map((phrase) => [phrase.en, phrase] as const)
);

export function isIntercompanyContainerTradingText(value: string): boolean {
  return translations.has(value.trim());
}

export function translateIntercompanyContainerTradingText(value: string, language: ApplicationLanguage): string | null {
  const entry = translations.get(value.trim());
  if (!entry) return null;
  return entry[language] || entry.en;
}
