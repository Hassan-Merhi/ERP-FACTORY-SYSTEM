import type { Phase3SharedUiEntry } from "./sharedUiPhase3TranslationTypes";

// Accounting audit phase 26 (multi-company and consolidation).
export const wave8ReleaseTranslationsPhase26: readonly Phase3SharedUiEntry[] = [
  // Intercompany posting service (services/accounting/intercompany/).
  {
    en: "Company ${companyId} not found",
    ar: "الشركة {{0}} غير موجودة",
    fr: "Société {{0}} introuvable",
  },
  {
    en: "The ${role} account ${accountId} is not a live account of company ${companyId}.",
    ar: "الحساب {{0}} رقم {{1}} ليس حساباً قائماً للشركة {{2}}.",
    fr: "Le compte {{0}} n° {{1}} n’est pas un compte actif de la société {{2}}.",
  },
  {
    en: "The intercompany account ${input.code} of company ${input.companyId} is deleted. Restore it from Deleted Items first.",
    ar: "الحساب بين الشركات {{0}} للشركة {{1}} محذوف. استعده أولاً من العناصر المحذوفة.",
    fr: "Le compte intersociétés {{0}} de la société {{1}} est supprimé. Restaurez-le d’abord depuis les éléments supprimés.",
  },
  {
    en: "An intercompany transfer needs two companies",
    ar: "يتطلب التحويل بين الشركات شركتين",
    fr: "Un transfert intersociétés nécessite deux sociétés",
  },
  {
    en: "An intercompany leg needs a source",
    ar: "يتطلب طرف التحويل بين الشركات مصدراً",
    fr: "Une jambe intersociétés nécessite une source",
  },
  {
    en: "${from.name} and ${to.name} keep their books in different currencies; this transfer needs an exchange rate.",
    ar: "تمسك {{0}} و{{1}} دفاترهما بعملتين مختلفتين؛ يحتاج هذا التحويل إلى سعر صرف.",
    fr: "{{0}} et {{1}} tiennent leurs livres dans des devises différentes ; ce transfert nécessite un taux de change.",
  },
  {
    en: "No access to company ${companyId} for this intercompany posting.",
    ar: "لا تملك صلاحية الوصول إلى الشركة {{0}} لهذا القيد بين الشركات.",
    fr: "Aucun accès à la société {{0}} pour cette écriture intersociétés.",
  },
  // Cross-company line correction (MC-10).
  {
    en: "The plan changed since it was reviewed. Review it again.",
    ar: "تغيّرت الخطة منذ مراجعتها. راجعها مرة أخرى.",
    fr: "Le plan a changé depuis sa revue. Revoyez-le.",
  },
  {
    en: "No voucher in the plan can be corrected.",
    ar: "لا يمكن تصحيح أي سند في الخطة.",
    fr: "Aucun bon du plan ne peut être corrigé.",
  },
  {
    en: "A mapped account is not an account of this company.",
    ar: "أحد الحسابات المعيّنة ليس حساباً لهذه الشركة.",
    fr: "Un compte associé n’est pas un compte de cette société.",
  },
  {
    en: "A ${plan.voucherType} voucher is posted by its own module; correct it there.",
    ar: "يُرحَّل سند {{0}} من وحدته الخاصة؛ صحّحه هناك.",
    fr: "Un bon {{0}} est comptabilisé par son propre module ; corrigez-le là.",
  },
  {
    en: "A sub-ledger record references this voucher; correct it through its module.",
    ar: "يشير سجل في دفتر فرعي إلى هذا السند؛ صحّحه من خلال وحدته.",
    fr: "Un enregistrement d’un sous-grand livre référence ce bon ; corrigez-le via son module.",
  },
  {
    en: "The voucher names accounts of more than one other company.",
    ar: "يذكر السند حسابات لأكثر من شركة أخرى.",
    fr: "Le bon mentionne des comptes de plusieurs autres sociétés.",
  },
  {
    en: "Map every foreign account to an account of this company (accountMap).",
    ar: "عيّن لكل حساب أجنبي حساباً من هذه الشركة (accountMap).",
    fr: "Associez chaque compte étranger à un compte de cette société (accountMap).",
  },
  {
    en: "Dated in a closed period of company ${id} (closed through ${through}).",
    ar: "مؤرخ في فترة مغلقة للشركة {{0}} (مغلقة حتى {{1}}).",
    fr: "Daté dans une période clôturée de la société {{0}} (clôturée jusqu’au {{1}}).",
  },
  {
    en: "owner must be account-company or voucher-company",
    ar: "يجب أن يكون owner إما account-company أو voucher-company",
    fr: "owner doit valoir account-company ou voucher-company",
  },
  {
    en: "accountMap must be a JSON object of account ids",
    ar: "يجب أن يكون accountMap كائن JSON من معرّفات الحسابات",
    fr: "accountMap doit être un objet JSON d’identifiants de comptes",
  },
  {
    en: "accountMap must be an object of account ids",
    ar: "يجب أن يكون accountMap كائناً من معرّفات الحسابات",
    fr: "accountMap doit être un objet d’identifiants de comptes",
  },
  {
    en: "accountMap must map account ids to account ids",
    ar: "يجب أن يربط accountMap معرّفات حسابات بمعرّفات حسابات",
    fr: "accountMap doit associer des identifiants de comptes à des identifiants de comptes",
  },
  // Consolidation (MC-6).
  {
    en: "Invalid parentCompanyId",
    ar: "parentCompanyId غير صالح",
    fr: "parentCompanyId invalide",
  },
  {
    en: "Parent company not found",
    ar: "الشركة الأم غير موجودة",
    fr: "Société mère introuvable",
  },
  {
    en: "No access to every company of the group",
    ar: "لا تملك صلاحية الوصول إلى جميع شركات المجموعة",
    fr: "Aucun accès à toutes les sociétés du groupe",
  },
  {
    en: "Every subsidiary is owned 100% by its parent: no non-controlling interest.",
    ar: "كل شركة تابعة مملوكة بنسبة 100% لشركتها الأم: لا توجد حقوق أقلية.",
    fr: "Chaque filiale est détenue à 100 % par sa société mère : aucun intérêt minoritaire.",
  },
  {
    en: "Unrealized profit on intercompany stock still held by the buyer is not eliminated (future work).",
    ar: "لا يُستبعد الربح غير المحقق على المخزون بين الشركات الذي لا يزال لدى المشتري (عمل مستقبلي).",
    fr: "Le profit latent sur le stock intersociétés encore détenu par l’acheteur n’est pas éliminé (travail futur).",
  },
  {
    en: "Rows of unknown class (missing accounts, unassigned lines) total ${money(unknown)}.",
    ar: "مجموع الصفوف غير المصنفة (حسابات مفقودة، بنود غير منسوبة) {{0}}.",
    fr: "Les lignes de classe inconnue (comptes manquants, lignes non affectées) totalisent {{0}}.",
  },
  {
    en: "No counterparty company recorded for this intercompany account.",
    ar: "لم تُسجَّل شركة مقابلة لهذا الحساب بين الشركات.",
    fr: "Aucune société contrepartie n’est enregistrée pour ce compte intersociétés.",
  },
  {
    en: "The account is recorded with more than one counterparty company.",
    ar: "الحساب مسجَّل مع أكثر من شركة مقابلة.",
    fr: "Le compte est enregistré avec plusieurs sociétés contreparties.",
  },
  // Multi-company diagnostic.
  {
    en: "Transfer links written before phase 26 do not record their intercompany accounts; group elimination derives them from the transfer vouchers.",
    ar: "روابط التحويل المكتوبة قبل المرحلة 26 لا تسجّل حساباتها بين الشركات؛ يستنتجها الاستبعاد على مستوى المجموعة من سندات التحويل.",
    fr: "Les liens de transfert écrits avant la phase 26 n’enregistrent pas leurs comptes intersociétés ; l’élimination de groupe les déduit des bons de transfert.",
  },
  {
    en: "Transfer links whose amount differs from a voucher's total, or whose voucher is deleted.",
    ar: "روابط تحويل يختلف مبلغها عن إجمالي أحد السندين، أو سندها محذوف.",
    fr: "Liens de transfert dont le montant diffère du total d’un bon, ou dont le bon est supprimé.",
  },
  {
    en: "IC-TO-/IC-FROM- accounts typed as plain assets or liabilities. Change their type to Intercompany (sub-type Due From or Due To).",
    ar: "حسابات IC-TO-/IC-FROM- مصنفة كأصول أو خصوم عادية. غيّر نوعها إلى بين الشركات (النوع الفرعي مستحق من أو مستحق إلى).",
    fr: "Comptes IC-TO-/IC-FROM- typés comme simples actifs ou passifs. Changez leur type en Intersociétés (sous-type À recevoir de ou Dû à).",
  },
  {
    en: "The legacy TRANSFER-CLEARING account still holds a balance. Reclassify it to the intercompany accounts with a journal.",
    ar: "لا يزال حساب TRANSFER-CLEARING القديم يحمل رصيداً. أعد تصنيفه إلى الحسابات بين الشركات بقيد يومية.",
    fr: "L’ancien compte TRANSFER-CLEARING porte encore un solde. Reclassez-le vers les comptes intersociétés par une écriture de journal.",
  },
  {
    en: "The parent's receivable from this subsidiary is not recorded by id yet; the next PO import records it, or set it in the company settings.",
    ar: "ذمة الشركة الأم على هذه الشركة التابعة غير مسجلة بالمعرّف بعد؛ يسجّلها استيراد أمر الشراء التالي، أو حدّدها في إعدادات الشركة.",
    fr: "La créance de la société mère sur cette filiale n’est pas encore enregistrée par identifiant ; la prochaine importation de bon de commande l’enregistre, ou définissez-la dans les paramètres de la société.",
  },
  {
    en: "Posted lines of this company on another company's accounts. Use the cross-company line correction tool.",
    ar: "بنود مرحّلة لهذه الشركة على حسابات شركة أخرى. استخدم أداة تصحيح البنود بين الشركات.",
    fr: "Lignes comptabilisées de cette société sur les comptes d’une autre société. Utilisez l’outil de correction des lignes intersociétés.",
  },
  {
    en: "The intercompany POS mirror is enabled but no destination cash account is configured, so no sale is mirrored.",
    ar: "انعكاس نقطة البيع بين الشركات مفعّل لكن لم يُضبط حساب نقدية للوجهة، لذا لا تنعكس أي عملية بيع.",
    fr: "Le miroir PDV intersociétés est activé mais aucun compte de caisse de destination n’est configuré : aucune vente n’est reflétée.",
  },
  {
    en: "A unique index on the ledger account code alone; codes are unique per company. Restart the server to drop it.",
    ar: "فهرس فريد على رمز الحساب وحده؛ الرموز فريدة لكل شركة. أعد تشغيل الخادم لإزالته.",
    fr: "Un index unique sur le seul code de compte ; les codes sont uniques par société. Redémarrez le serveur pour le supprimer.",
  },
  // Parent model (MC-7) and the legacy password diagnostic.
  {
    en: "The global parent company setting is retired. Set each subsidiary's parent company under Settings > Companies.",
    ar: "تم إيقاف إعداد الشركة الأم العام. حدّد الشركة الأم لكل شركة تابعة في الإعدادات > الشركات.",
    fr: "Le paramètre global de société mère est retiré. Définissez la société mère de chaque filiale dans Paramètres > Sociétés.",
  },
  {
    en: "The company that other companies name as their parent. Set each subsidiary's parent under Settings > Companies.",
    ar: "الشركة التي تسمّيها الشركات الأخرى شركتها الأم. حدّد الشركة الأم لكل شركة تابعة في الإعدادات > الشركات.",
    fr: "La société que les autres sociétés désignent comme leur mère. Définissez la mère de chaque filiale dans Paramètres > Sociétés.",
  },
  {
    en: "Failed to load the legacy password diagnostic",
    ar: "تعذر تحميل تشخيص كلمات المرور القديمة",
    fr: "Impossible de charger le diagnostic des anciens mots de passe",
  },
  // Voucher descriptions written by phase 26.
  {
    en: "POS cash mirror of sale ${sale.saleVoucherId}",
    ar: "انعكاس نقدية نقطة البيع للبيع {{0}}",
    fr: "Miroir de caisse PDV de la vente {{0}}",
  },
  {
    en: "Auto-transfer rule ${cfg.id}: company ${input.companyId} or ${cfg.destCompanyId} not found",
    ar: "قاعدة التحويل التلقائي {{0}}: الشركة {{1}} أو {{2}} غير موجودة",
    fr: "Règle de transfert automatique {{0}} : société {{1}} ou {{2}} introuvable",
  },
  {
    en: "${voucher.description ?? voucher.voucherNumber} (corrected: lines moved off company ${otherCompanyId}'s accounts)",
    ar: "{{0}} (مصحَّح: نُقلت البنود من حسابات الشركة {{1}})",
    fr: "{{0}} (corrigé : lignes retirées des comptes de la société {{1}})",
  },
  {
    en: "${own.name} ${voucher.voucherNumber}: lines posted on this company's accounts",
    ar: "{{0}} {{1}}: بنود مرحّلة على حسابات هذه الشركة",
    fr: "{{0}} {{1}} : lignes comptabilisées sur les comptes de cette société",
  },
  {
    en: "Cross-company line correction of ${voucher.voucherNumber}",
    ar: "تصحيح البنود بين الشركات للسند {{0}}",
    fr: "Correction des lignes intersociétés du bon {{0}}",
  },
];
