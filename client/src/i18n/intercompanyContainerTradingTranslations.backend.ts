/** Intercompany container trading API errors and voucher narrations in English, Arabic, and French. */
export const intercompanyBackendPhrases: readonly { en: string; ar: string; fr: string }[] = [
  {
    en: "Container trading could not be completed. No partial import was committed.",
    ar: "تعذّر إتمام تجارة الحاويات. لم يُحفظ أي استيراد جزئي.",
    fr: "Le négoce de conteneurs n’a pas pu être finalisé. Aucun import partiel n’a été enregistré.",
  },
  {
    en: "Linked edit was not committed. Review and retry.",
    ar: "لم يُحفظ التعديل المرتبط. راجع وأعد المحاولة.",
    fr: "La modification liée n’a pas été enregistrée. Vérifiez puis réessayez.",
  },
  {
    en: "Financial edit permission required",
    ar: "صلاحية التعديل المالي مطلوبة",
    fr: "Autorisation de modification financière requise",
  },
  {
    en: "No partial mirrored payment was saved. Correct the evidence and retry.",
    ar: "لم تُحفظ أي دفعة متقابلة جزئية. صحّح المستندات وأعد المحاولة.",
    fr: "Aucun paiement miroir partiel n’a été enregistré. Corrigez les justificatifs puis réessayez.",
  },
  {
    en: "No partial stock receipt or trade cancellation was saved. Refresh and reconcile the evidence.",
    ar: "لم يُحفظ أي استلام مخزون أو إلغاء صفقة جزئي. حدّث الصفحة وطابق المستندات.",
    fr: "Aucune réception de stock ni annulation de transaction partielle n’a été enregistrée. Actualisez et rapprochez les justificatifs.",
  },
  {
    en: "Destination GIT account must be configured.",
    ar: "يجب إعداد حساب البضاعة بالطريق للشركة الوجهة.",
    fr: "Le compte de marchandises en transit de la destination doit être configuré.",
  },
  {
    en: "Destination Properties supplier must be configured.",
    ar: "يجب إعداد مورد Properties لدى الشركة الوجهة.",
    fr: "Le fournisseur Properties de la destination doit être configuré.",
  },
  {
    en: "Container number and selected destination must match the uploaded workbook",
    ar: "يجب أن يطابق رقم الحاوية والوجهة المختارة الملف المرفوع",
    fr: "Le numéro de conteneur et la destination sélectionnée doivent correspondre au classeur importé",
  },
  { en: "Invalid workbook container", ar: "حاوية غير صالحة في الملف", fr: "Conteneur du classeur invalide" },
  { en: "Original supplier PO", ar: "أمر شراء المورد الأصلي", fr: "Commande fournisseur d’origine" },
  {
    en: "At-cost container resale to",
    ar: "إعادة بيع الحاوية بالتكلفة إلى",
    fr: "Revente du conteneur au prix coûtant à",
  },
  {
    en: "At-cost goods transferred out -",
    ar: "بضاعة محوّلة للخارج بالتكلفة -",
    fr: "Marchandises transférées au prix coûtant -",
  },
  {
    en: "Verified intercompany payment not found",
    ar: "الدفعة الموثقة بين الشركات غير موجودة",
    fr: "Paiement intersociétés vérifié introuvable",
  },
  {
    en: "Intercompany PO payment allocation is unreconciled",
    ar: "تخصيص دفعة أمر الشراء بين الشركات غير مطابق",
    fr: "L’affectation du paiement de commande intersociétés n’est pas rapprochée",
  },
  {
    en: "Automatic credit requires a verified new active trade of the same company pair",
    ar: "يتطلب الرصيد التلقائي صفقة جديدة نشطة وموثقة لنفس الزوج من الشركات",
    fr: "Le crédit automatique exige une nouvelle transaction active vérifiée de la même paire de sociétés",
  },
  {
    en: "Existing PO allocation exceeds its confirmed cost",
    ar: "التخصيص الحالي لأمر الشراء يتجاوز تكلفته المؤكدة",
    fr: "L’affectation existante de la commande dépasse son coût confirmé",
  },
  {
    en: "Cannot safely release excess PO allocation",
    ar: "تعذّر تحرير التخصيص الزائد لأمر الشراء بأمان",
    fr: "Impossible de libérer en toute sécurité l’excédent d’affectation de la commande",
  },
  {
    en: "Negative allocation found during mirrored payment reversal",
    ar: "وُجد تخصيص سالب أثناء عكس الدفعة المتقابلة",
    fr: "Affectation négative détectée lors de la contre-passation du paiement miroir",
  },
  {
    en: "Transaction amount must be an exact nonnegative number with at most 2 decimals",
    ar: "يجب أن يكون مبلغ العملية رقمًا دقيقًا غير سالب بخانتين عشريتين على الأكثر",
    fr: "Le montant de la transaction doit être un nombre exact non négatif avec au plus 2 décimales",
  },
  {
    en: "Transaction amount must be positive and within safe range",
    ar: "يجب أن يكون مبلغ العملية موجبًا وضمن النطاق الآمن",
    fr: "Le montant de la transaction doit être positif et dans la plage sûre",
  },
  {
    en: "Unsupported transaction currency",
    ar: "عملة العملية غير مدعومة",
    fr: "Devise de transaction non prise en charge",
  },
  {
    en: "Historical FX rate must have at most 10 decimals",
    ar: "يجب ألا يتجاوز سعر الصرف التاريخي 10 خانات عشرية",
    fr: "Le taux de change historique doit comporter au plus 10 décimales",
  },
  { en: "Invalid historical FX rate", ar: "سعر الصرف التاريخي غير صالح", fr: "Taux de change historique invalide" },
  {
    en: "USD payment must use an identity FX rate",
    ar: "يجب أن تستخدم الدفعة بالدولار الأمريكي سعر صرف يساوي 1",
    fr: "Un paiement en USD doit utiliser un taux de change égal à 1",
  },
  {
    en: "Actual payment converts to less than one US cent",
    ar: "الدفعة الفعلية تعادل أقل من سنت أمريكي واحد",
    fr: "Le paiement réel équivaut à moins d’un cent américain",
  },
  {
    en: "PO credit allocation budget must be cent-exact",
    ar: "يجب أن يكون مبلغ تخصيص رصيد أمر الشراء دقيقًا بالسنت",
    fr: "Le budget d’affectation du crédit de commande doit être exact au cent près",
  },
  {
    en: "Unreconciled payment credit balance",
    ar: "رصيد دائن للدفعات غير مطابق",
    fr: "Solde de crédit de paiement non rapproché",
  },
  {
    en: "Payment PO allocation list mismatch",
    ar: "عدم تطابق في قائمة تخصيص الدفعة على أوامر الشراء",
    fr: "Incohérence dans la liste d’affectation du paiement aux commandes",
  },
  {
    en: "Manual allocation exceeds an individual PO's confirmed unpaid amount",
    ar: "التخصيص اليدوي يتجاوز المبلغ المؤكد غير المدفوع لأحد أوامر الشراء",
    fr: "L’affectation manuelle dépasse le montant impayé confirmé d’une commande",
  },
  {
    en: "Manual allocation exceeds confirmed payment; overage must remain credit",
    ar: "التخصيص اليدوي يتجاوز الدفعة المؤكدة؛ يجب أن يبقى الفائض رصيدًا",
    fr: "L’affectation manuelle dépasse le paiement confirmé ; l’excédent doit rester en crédit",
  },
  {
    en: "Payment credit ledger does not reconcile",
    ar: "سجل أرصدة الدفعات غير مطابق",
    fr: "Le registre des crédits de paiement n’est pas rapproché",
  },
  { en: "Invalid monetary amount", ar: "مبلغ نقدي غير صالح", fr: "Montant monétaire invalide" },
  { en: "Actual confirmed receipt", ar: "قبض فعلي مؤكد", fr: "Encaissement réel confirmé" },
  { en: "Actual confirmed payment", ar: "دفعة فعلية مؤكدة", fr: "Paiement réel confirmé" },
  {
    en: "Actual reversal of Properties receipt",
    ar: "عكس فعلي لقبض Properties",
    fr: "Contre-passation réelle de l’encaissement Properties",
  },
  {
    en: "Actual reversal of destination payment",
    ar: "عكس فعلي لدفعة الشركة الوجهة",
    fr: "Contre-passation réelle du paiement de la destination",
  },
  {
    en: "Cancel at-cost intercompany sale, trade",
    ar: "إلغاء البيع بين الشركات بالتكلفة، الصفقة",
    fr: "Annulation de la vente intersociétés au prix coûtant, transaction",
  },
  {
    en: "Return original external goods to Properties purchases, trade",
    ar: "إعادة البضاعة الخارجية الأصلية إلى مشتريات Properties، الصفقة",
    fr: "Retour des marchandises externes d’origine aux achats Properties, transaction",
  },
  {
    en: "Reverse unreceived intercompany GIT/supplier liability, trade",
    ar: "عكس البضاعة بالطريق/التزام المورد بين الشركات غير المستلمة، الصفقة",
    fr: "Contre-passation des marchandises en transit/dette fournisseur intersociétés non réceptionnées, transaction",
  },
  {
    en: "Linked source/destination PO lines are incomplete",
    ar: "أسطر أوامر الشراء المرتبطة للمصدر/الوجهة غير مكتملة",
    fr: "Les lignes de commande liées source/destination sont incomplètes",
  },
  {
    en: "Every linked PO row must be paired exactly once",
    ar: "يجب ربط كل سطر أمر شراء مرتبط مرة واحدة بالضبط",
    fr: "Chaque ligne de commande liée doit être appariée exactement une fois",
  },
  {
    en: "Source and ERP destination purchase rows disagree on item name",
    ar: "أسطر الشراء في المصدر والشركة الوجهة مختلفة في اسم الصنف",
    fr: "Les lignes d’achat source et destination ERP diffèrent sur le nom de l’article",
  },
  {
    en: "Source and ERP destination purchase rows disagree on",
    ar: "أسطر الشراء في المصدر والشركة الوجهة مختلفة في",
    fr: "Les lignes d’achat source et destination ERP diffèrent sur",
  },
  {
    en: "Receive canonical linked container",
    ar: "استلام الحاوية المرتبطة المعتمدة",
    fr: "Réception du conteneur lié de référence",
  },
  {
    en: "Verified destination purchase lines are missing",
    ar: "أسطر الشراء الموثقة للشركة الوجهة مفقودة",
    fr: "Les lignes d’achat vérifiées de la destination sont manquantes",
  },
  {
    en: "A destination PO line lacks verified stock identity or exact USD value",
    ar: "أحد أسطر أمر شراء الوجهة يفتقد هوية المخزون الموثقة أو القيمة الدقيقة بالدولار الأمريكي",
    fr: "Une ligne de commande de destination n’a pas d’identité de stock vérifiée ou de valeur exacte en USD",
  },
  {
    en: "Destination PO contains negative goods value",
    ar: "أمر شراء الوجهة يحتوي على قيمة بضاعة سالبة",
    fr: "La commande de destination contient une valeur de marchandises négative",
  },
  {
    en: "Confirmed landed cost and goods must be positive",
    ar: "يجب أن تكون التكلفة الواصلة المؤكدة وقيمة البضاعة موجبتين",
    fr: "Le coût de revient confirmé et la valeur des marchandises doivent être positifs",
  },
  {
    en: "PO quantity must be positive with at most 3 decimals",
    ar: "يجب أن تكون كمية أمر الشراء موجبة بثلاث خانات عشرية على الأكثر",
    fr: "La quantité de la commande doit être positive avec au plus 3 décimales",
  },
  {
    en: "PO rate must be non-negative with at most 2 decimals",
    ar: "يجب أن يكون سعر أمر الشراء غير سالب بخانتين عشريتين على الأكثر",
    fr: "Le prix de la commande doit être non négatif avec au plus 2 décimales",
  },
  {
    en: "Confirmed charge requires positive eligible purchase weights",
    ar: "يتطلب المصروف المؤكد أوزان شراء مؤهلة موجبة",
    fr: "Les frais confirmés exigent des poids d’achat éligibles positifs",
  },
  {
    en: "Confirmed charge must be a non-negative USD amount in cents",
    ar: "يجب أن يكون المصروف المؤكد مبلغًا غير سالب بالدولار الأمريكي محسوبًا بالسنت",
    fr: "Les frais confirmés doivent être un montant USD non négatif exprimé en cents",
  },
  {
    en: "Shared charge is too large to allocate exactly",
    ar: "المصروف المشترك أكبر من أن يُوزَّع بدقة",
    fr: "Les frais partagés sont trop élevés pour être répartis exactement",
  },
  { en: "Original PO adjustment:", ar: "تسوية أمر الشراء الأصلي:", fr: "Ajustement de la commande d’origine :" },
  {
    en: "Atomic linked cost adjustment",
    ar: "تسوية تكلفة مرتبطة في عملية واحدة",
    fr: "Ajustement de coût lié atomique",
  },
];
