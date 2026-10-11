import type { Phase3SharedUiEntry } from "./sharedUiPhase3TranslationTypes";

// Accounting audit phases 28 and 29 (factory accounting complete, perpetual inventory go-live).
export const wave8ReleaseTranslationsPhase28: readonly Phase3SharedUiEntry[] = [
  {
    en: "The factory opening receivable has already been applied for this company.",
    ar: "تم تطبيق ذمم المصنع الافتتاحية لهذه الشركة بالفعل.",
    fr: "Les créances d’ouverture de l’usine ont déjà été appliquées pour cette société.",
  },
  {
    en: "The factory receivable cut-over can be applied on or after its date.",
    ar: "لا يمكن تطبيق تاريخ انتقال ذمم المصنع إلا في تاريخه أو بعده.",
    fr: "La bascule des créances de l’usine ne peut être appliquée qu’à sa date ou après.",
  },
  {
    en: "A supplier-partner company carries no factory receivable.",
    ar: "لا تحمل شركة المورد الشريك ذمم مصنع.",
    fr: "Une société fournisseur partenaire ne porte aucune créance d’usine.",
  },
  {
    en: "Some invoices are in a currency with no confirmed exchange rate on or before their date. Enter the factory rates first.",
    ar: "بعض الفواتير بعملة ليس لها سعر صرف مؤكد في تاريخها أو قبله. أدخل أسعار المصنع أولاً.",
    fr: "Certaines factures sont dans une devise sans taux de change confirmé à leur date ou avant. Saisissez d’abord les taux de l’usine.",
  },
  {
    en: "The opening receivable changed since it was reviewed. Preview it again and confirm the new plan.",
    ar: "تغيرت الذمم الافتتاحية منذ مراجعتها. اعرضها مرة أخرى وأكد الخطة الجديدة.",
    fr: "Les créances d’ouverture ont changé depuis leur examen. Prévisualisez-les à nouveau et confirmez le nouveau plan.",
  },
  {
    en: "There is no factory receivable to open.",
    ar: "لا توجد ذمم مصنع لفتحها.",
    fr: "Il n’y a aucune créance d’usine à ouvrir.",
  },
  {
    en: "The no-mix bale plan changed since it was reviewed. Preview it again and confirm the new plan.",
    ar: "تغيرت خطة البالات بدون خلطة منذ مراجعتها. اعرضها مرة أخرى وأكد الخطة الجديدة.",
    fr: "Le plan des balles sans mélange a changé depuis son examen. Prévisualisez-le à nouveau et confirmez le nouveau plan.",
  },
  {
    en: "There is no bale without a costed mix to resolve.",
    ar: "لا توجد بالة بدون خلطة مسعّرة لمعالجتها.",
    fr: "Il n’y a aucune balle sans mélange valorisé à traiter.",
  },
  {
    en: "Choose an action (assign, write off or accept) for every bale without a candidate mix.",
    ar: "اختر إجراءً (تعيين أو شطب أو قبول) لكل بالة ليس لها خلطة مرشحة.",
    fr: "Choisissez une action (affecter, passer en perte ou accepter) pour chaque balle sans mélange candidat.",
  },
  {
    en: "Accepting a bale's cost needs a sign-off reason of at least 10 characters.",
    ar: "يتطلب قبول تكلفة البالة سبب اعتماد من 10 أحرف على الأقل.",
    fr: "Accepter le coût d’une balle exige un motif de validation d’au moins 10 caractères.",
  },
  {
    en: "The chosen mix is not a live, costed mix of this company.",
    ar: "الخلطة المختارة ليست خلطة مسعّرة وفعالة لهذه الشركة.",
    fr: "Le mélange choisi n’est pas un mélange actif et valorisé de cette société.",
  },
  {
    en: "An action names a bale that is not in the plan.",
    ar: "يشير إجراء إلى بالة غير موجودة في الخطة.",
    fr: "Une action désigne une balle qui n’est pas dans le plan.",
  },
  {
    en: "The legacy factory postings changed since they were reviewed. Preview them again and confirm the new plan.",
    ar: "تغيرت قيود المصنع القديمة منذ مراجعتها. اعرضها مرة أخرى وأكد الخطة الجديدة.",
    fr: "Les écritures anciennes de l’usine ont changé depuis leur examen. Prévisualisez-les à nouveau et confirmez le nouveau plan.",
  },
  {
    en: "There is no legacy factory posting to back-fill.",
    ar: "لا توجد قيود مصنع قديمة لاستكمالها.",
    fr: "Il n’y a aucune écriture ancienne de l’usine à compléter.",
  },
  {
    en: "The bale-mirror write-off changed since it was reviewed. Preview it again and confirm the new plan.",
    ar: "تغير شطب مرآة البالات منذ مراجعته. اعرضه مرة أخرى وأكد الخطة الجديدة.",
    fr: "La mise en perte du miroir des balles a changé depuis son examen. Prévisualisez-la à nouveau et confirmez le nouveau plan.",
  },
  {
    en: "No bale-mirror row carries a value.",
    ar: "لا يحمل أي سطر من مرآة البالات قيمة.",
    fr: "Aucune ligne du miroir des balles ne porte de valeur.",
  },
  {
    en: "Perpetual inventory applies: the opening raw-stock usage can no longer be recalculated, because the opening journal valued it.",
    ar: "يُطبَّق الجرد المستمر: لم يعد من الممكن إعادة حساب استهلاك المواد الخام الافتتاحية لأن قيد الافتتاح قيّمه.",
    fr: "L’inventaire permanent s’applique : la consommation de la matière première d’ouverture ne peut plus être recalculée, car l’écriture d’ouverture l’a valorisée.",
  },
  {
    en: "The ledger carries stock only from the perpetual inventory cut-over. Choose a date on or after it.",
    ar: "لا يحمل الدفتر المخزون إلا من تاريخ انتقال الجرد المستمر. اختر تاريخاً في ذلك التاريخ أو بعده.",
    fr: "Le grand livre ne porte le stock qu’à partir de la bascule de l’inventaire permanent. Choisissez une date à partir de celle-ci.",
  },
  {
    en: "This payroll request names another company than the one selected.",
    ar: "يشير طلب الرواتب هذا إلى شركة غير الشركة المحددة.",
    fr: "Cette demande de paie désigne une autre société que celle sélectionnée.",
  },
  {
    en: "This payroll is already paid. Undo the payment first to pay it again with another date or account.",
    ar: "تم دفع هذا الراتب بالفعل. ألغِ الدفع أولاً لدفعه مرة أخرى بتاريخ أو حساب آخر.",
    fr: "Cette paie est déjà payée. Annulez d’abord le paiement pour la payer à nouveau avec une autre date ou un autre compte.",
  },
  {
    en: "Sign off the opening difference: give a reason of at least 10 characters after reviewing what makes it up.",
    ar: "اعتمد فرق الافتتاح: اذكر سبباً من 10 أحرف على الأقل بعد مراجعة مكوناته.",
    fr: "Validez l’écart d’ouverture : indiquez un motif d’au moins 10 caractères après avoir examiné sa composition.",
  },
  {
    en: "The supplier does not belong to this company.",
    ar: "المورد لا ينتمي إلى هذه الشركة.",
    fr: "Le fournisseur n’appartient pas à cette société.",
  },
  {
    en: "Choose the received-not-invoiced receipts this invoice clears.",
    ar: "اختر الاستلامات المستلمة غير المفوترة التي تسويها هذه الفاتورة.",
    fr: "Choisissez les réceptions reçues non facturées que cette facture solde.",
  },
  {
    en: "A chosen receipt is not an open received-not-invoiced receipt of this company.",
    ar: "أحد الاستلامات المختارة ليس استلاماً مفتوحاً مستلماً غير مفوتر لهذه الشركة.",
    fr: "Une réception choisie n’est pas une réception reçue non facturée ouverte de cette société.",
  },
  {
    en: "This supplier invoice number is already recorded.",
    ar: "رقم فاتورة المورد هذا مسجل بالفعل.",
    fr: "Ce numéro de facture fournisseur est déjà enregistré.",
  },
  {
    en: "The invoice date cannot be in the future.",
    ar: "لا يمكن أن يكون تاريخ الفاتورة في المستقبل.",
    fr: "La date de la facture ne peut pas être dans le futur.",
  },
  {
    en: "The invoice amount must be positive.",
    ar: "يجب أن يكون مبلغ الفاتورة موجباً.",
    fr: "Le montant de la facture doit être positif.",
  },
  {
    en: "Reason for the reversal",
    ar: "سبب العكس",
    fr: "Motif de l’extourne",
  },
  {
    en: "Voucher reversed",
    ar: "تم عكس القيد",
    fr: "Pièce extournée",
  },
  {
    en: "Post the corrected voucher in an open period.",
    ar: "سجّل القيد المصحح في فترة مفتوحة.",
    fr: "Passez la pièce corrigée dans une période ouverte.",
  },
  {
    en: "Could not reverse the voucher",
    ar: "تعذر عكس القيد",
    fr: "Impossible d’extourner la pièce",
  },
  {
    en: "Closed period",
    ar: "فترة مقفلة",
    fr: "Période clôturée",
  },
  {
    en: "Reverse",
    ar: "عكس",
    fr: "Extourner",
  },
  {
    en: "Sign-off",
    ar: "الاعتماد",
    fr: "Validation",
  },
];
