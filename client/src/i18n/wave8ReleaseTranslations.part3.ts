import type { Phase3SharedUiEntry } from "./sharedUiPhase3TranslationTypes";

// Wave 8 release closeout, continued from part 2 (which reached the 900-line limit).
export const wave8ReleaseTranslationsPart3: readonly Phase3SharedUiEntry[] = [
  {
    en: "One or more selected companies could not be found",
    ar: "تعذر العثور على شركة أو أكثر من الشركات المحددة",
    fr: "Une ou plusieurs des sociétés sélectionnées sont introuvables",
  },
  {
    en: "Item Market Analysis can only compare ERP companies",
    ar: "لا يمكن لتحليل سوق الأصناف مقارنة سوى شركات ERP",
    fr: "L’analyse du marché des articles ne peut comparer que des sociétés ERP",
  },
  {
    en: "Load 250 more",
    ar: "تحميل 250 إضافية",
    fr: "Charger 250 de plus",
  },
  {
    en: "All Profit",
    ar: "كل الأرباح",
    fr: "Tous les bénéfices",
  },
  {
    en: "COGS Reconciliation",
    ar: "تسوية تكلفة البضاعة المباعة",
    fr: "Rapprochement du coût des ventes",
  },
  {
    en: "Adjusted Cost Profit",
    ar: "الربح بالتكلفة المعدّلة",
    fr: "Bénéfice au coût ajusté",
  },
  {
    en: "Freight + Charges: Included",
    ar: "الشحن + الرسوم: مشمولة",
    fr: "Fret + frais : inclus",
  },
  {
    en: "Freight + Charges: Excluded",
    ar: "الشحن + الرسوم: مستبعدة",
    fr: "Fret + frais : exclus",
  },
  {
    en: "Invoice Total (With Charges)",
    ar: "إجمالي الفاتورة (مع الرسوم)",
    fr: "Total de la facture (avec frais)",
  },
  {
    en: "Total Cost (With Charges)",
    ar: "إجمالي التكلفة (مع الرسوم)",
    fr: "Coût total (avec frais)",
  },
  {
    en: "Expand a customer to see each loading, verified or finalized invoice. Totals below include freight and extra charges.",
    ar: "وسّع العميل لعرض كل عملية تحميل أو فاتورة متحقق منها أو معتمدة. الإجماليات أدناه تشمل الشحن والرسوم الإضافية.",
    fr: "Développez un client pour voir chaque chargement ou facture vérifiée ou finalisée. Les totaux ci-dessous incluent le fret et les frais supplémentaires.",
  },
  {
    en: "Expand a customer to see each loading, verified or finalized invoice. Totals below exclude freight and extra charges.",
    ar: "وسّع العميل لعرض كل عملية تحميل أو فاتورة متحقق منها أو معتمدة. الإجماليات أدناه تستثني الشحن والرسوم الإضافية.",
    fr: "Développez un client pour voir chaque chargement ou facture vérifiée ou finalisée. Les totaux ci-dessous excluent le fret et les frais supplémentaires.",
  },
  {
    en: "Invalid includeCharges filter",
    ar: "عامل تصفية includeCharges غير صالح",
    fr: "Filtre includeCharges non valide",
  },
  {
    en: "Invalid payroll salary amounts",
    ar: "مبالغ رواتب غير صالحة في كشف الرواتب",
    fr: "Montants de salaire de paie non valides",
  },
  {
    en: "Commission amount must be a number",
    ar: "يجب أن يكون مبلغ العمولة رقماً",
    fr: "Le montant de la commission doit être un nombre",
  },
  {
    en: "Commission FX rate must be a number",
    ar: "يجب أن يكون سعر صرف العمولة رقماً",
    fr: "Le taux de change de la commission doit être un nombre",
  },
  {
    en: "Not changed. Investigate the difference and post a correcting entry.",
    ar: "لم يتم التغيير. تحقق من الفرق وسجّل قيداً تصحيحياً.",
    fr: "Non modifié. Analysez l’écart et passez une écriture de correction.",
  },
  {
    en: "No balances were changed",
    ar: "لم يتم تغيير أي أرصدة",
    fr: "Aucun solde n’a été modifié",
  },
  {
    en: "Equity adjustments are no longer written. The difference is reported as it is; investigate it and post a correcting entry.",
    ar: "لم تعد تسويات حقوق الملكية تُسجَّل. يُعرض الفرق كما هو؛ تحقق منه وسجّل قيداً تصحيحياً.",
    fr: "Les ajustements de capitaux propres ne sont plus enregistrés. L’écart est présenté tel quel ; analysez-le et passez une écriture de correction.",
  },
  {
    en: "This checks each company's Import Cycle difference and shows what a balancing entry would need. No balances are changed: a difference is corrected with a reviewed, posted entry.",
    ar: "يتحقق هذا من فرق دورة الاستيراد لكل شركة ويعرض ما يتطلبه قيد الموازنة. لا يتم تغيير أي أرصدة: يُصحَّح الفرق بقيد مُراجع ومُرحَّل.",
    fr: "Ceci vérifie l’écart du cycle d’importation de chaque société et indique ce qu’exigerait une écriture d’équilibrage. Aucun solde n’est modifié : un écart se corrige par une écriture revue et comptabilisée.",
  },
  {
    en: "Check All Companies",
    ar: "التحقق من جميع الشركات",
    fr: "Vérifier toutes les sociétés",
  },
  {
    en: "Checking...",
    ar: "جارٍ التحقق...",
    fr: "Vérification...",
  },
  {
    en: "Only ledger account entries can be moved",
    ar: "يمكن نقل قيود حسابات الأستاذ فقط",
    fr: "Seules les écritures de comptes du grand livre peuvent être déplacées",
  },
  {
    en: "A legacy line changed during the repair; nothing was applied",
    ar: "تغيّر سطر قديم أثناء الإصلاح؛ لم يُطبَّق أي شيء",
    fr: "Une ligne historique a changé pendant la réparation ; rien n'a été appliqué",
  },
  {
    en: "A required system account is not available",
    ar: "حساب نظام مطلوب غير متاح",
    fr: "Un compte système requis n'est pas disponible",
  },
  {
    en: "Perpetual inventory posting is not complete yet; the cut-over cannot be applied",
    ar: "ترحيل المخزون الدائم لم يكتمل بعد؛ لا يمكن تطبيق التحويل",
    fr: "La comptabilisation de l'inventaire permanent n'est pas encore terminée ; la bascule ne peut pas être appliquée",
  },
  {
    en: "The cut-over can be applied on or after its date",
    ar: "يمكن تطبيق التحويل في تاريخه أو بعده",
    fr: "La bascule peut être appliquée à sa date ou après",
  },
  {
    en: "The cut-over is already applied for this company",
    ar: "تم تطبيق التحويل بالفعل لهذه الشركة",
    fr: "La bascule est déjà appliquée pour cette société",
  },
  {
    en: "Documents are already posted on or after the cut-over date; choose a later date",
    ar: "توجد مستندات مرحّلة في تاريخ التحويل أو بعده؛ اختر تاريخًا لاحقًا",
    fr: "Des documents sont déjà comptabilisés à la date de bascule ou après ; choisissez une date ultérieure",
  },
  {
    en: "A perpetual-inventory journal does not balance",
    ar: "قيد المخزون الدائم غير متوازن",
    fr: "Une écriture d'inventaire permanent n'est pas équilibrée",
  },
  {
    en: "Unknown system account code",
    ar: "رمز حساب نظام غير معروف",
    fr: "Code de compte système inconnu",
  },
  {
    en: "Confirmation is required",
    ar: "التأكيد مطلوب",
    fr: "Une confirmation est requise",
  },
  {
    en: "A balanced voucher cannot be changed to a voucher type that is exempt from balancing",
    ar: "لا يمكن تغيير قيد متوازن إلى نوع قيد معفى من شرط التوازن",
    fr: "Une pièce équilibrée ne peut pas être changée en un type de pièce exempté de l'équilibre",
  },
  {
    en: "Period start is after its end",
    ar: "بداية الفترة بعد نهايتها",
    fr: "Le début de la période est après sa fin",
  },
  {
    en: "Not yet in the ledger",
    ar: "لم يُرحَّل إلى الدفتر بعد",
    fr: "Pas encore au grand livre",
  },
  {
    en: "Shown for information only; not part of the ledger balance above.",
    ar: "معروض للعلم فقط؛ ليس جزءًا من رصيد الدفتر أعلاه.",
    fr: "Affiché à titre d'information ; ne fait pas partie du solde du grand livre ci-dessus.",
  },
  {
    en: "Total not yet in the ledger",
    ar: "إجمالي ما لم يُرحَّل إلى الدفتر بعد",
    fr: "Total pas encore au grand livre",
  },
  {
    en: "Operational amounts shown for information. They are not included in What We Have or What We Owe.",
    ar: "مبالغ تشغيلية معروضة للعلم. لا تدخل في ما لدينا ولا في ما علينا.",
    fr: "Montants opérationnels affichés à titre d'information. Ils ne sont inclus ni dans Ce que nous avons ni dans Ce que nous devons.",
  },
  {
    en: 'Unfinalized orders are not receivables yet: they are listed under "Not yet in the ledger" and are not included in "What We Have." Loading orders update live as bales are scanned.',
    ar: 'الطلبات غير المُنهاة ليست ذمماً مدينة بعد: تُدرج ضمن "لم يُرحَّل إلى الدفتر بعد" ولا تدخل في "ما لدينا". تتحدث طلبات التحميل مباشرة أثناء مسح البالات.',
    fr: "Les commandes non finalisées ne sont pas encore des créances : elles figurent sous « Pas encore au grand livre » et ne sont pas incluses dans « Ce que nous avons ». Les commandes en chargement se mettent à jour en direct lors du scan des balles.",
  },
  {
    en: "Factory invoices not yet in the ledger",
    ar: "فواتير المصنع غير المُرحَّلة إلى الدفتر بعد",
    fr: "Factures d'usine pas encore au grand livre",
  },
  {
    en: "Factory POS credit sales not yet in the ledger",
    ar: "مبيعات آجلة من نقاط بيع المصنع غير مُرحَّلة بعد",
    fr: "Ventes à crédit du PDV d'usine pas encore au grand livre",
  },
  {
    en: "Deposits on factory POS credit sales not yet in the ledger",
    ar: "عربون مبيعات نقاط بيع المصنع الآجلة غير مُرحَّل بعد",
    fr: "Acomptes sur ventes à crédit du PDV d'usine pas encore au grand livre",
  },
  {
    en: "Other customer balance records not in the ledger",
    ar: "سجلات أرصدة عملاء أخرى غير موجودة في الدفتر",
    fr: "Autres enregistrements de solde client absents du grand livre",
  },
  {
    en: "Container goods not yet in the ledger (legacy containers)",
    ar: "بضائع حاويات غير مُرحَّلة بعد (حاويات قديمة)",
    fr: "Marchandises de conteneurs pas encore au grand livre (anciens conteneurs)",
  },
  {
    en: "Supplier-paid container freight not yet in the ledger",
    ar: "شحن حاويات مدفوع من المورد غير مُرحَّل بعد",
    fr: "Fret de conteneur payé par le fournisseur pas encore au grand livre",
  },
  {
    en: "Container commission not yet in the ledger",
    ar: "عمولة الحاويات غير مُرحَّلة بعد",
    fr: "Commission de conteneur pas encore au grand livre",
  },
  {
    en: "Salary advances: advances-table remaining balance differs from the ledger",
    ar: "سلف الرواتب: الرصيد المتبقي في جدول السلف يختلف عن الدفتر",
    fr: "Avances sur salaire : le solde restant du tableau des avances diffère du grand livre",
  },
  {
    en: "Payroll: the payroll page's current balance differs from the ledger",
    ar: "الرواتب: الرصيد الحالي في صفحة الرواتب يختلف عن الدفتر",
    fr: "Paie : le solde actuel de la page de paie diffère du grand livre",
  },
  {
    en: "Pending orders at selling price (not invoiced)",
    ar: "طلبات معلقة بسعر البيع (غير مفوترة)",
    fr: "Commandes en attente au prix de vente (non facturées)",
  },
  {
    en: "Verified orders at selling price (not invoiced)",
    ar: "طلبات مُتحقق منها بسعر البيع (غير مفوترة)",
    fr: "Commandes vérifiées au prix de vente (non facturées)",
  },
  {
    en: "Loading orders at selling price (not invoiced)",
    ar: "طلبات قيد التحميل بسعر البيع (غير مفوترة)",
    fr: "Commandes en chargement au prix de vente (non facturées)",
  },
  {
    en: "Factory worker advances: the advances table differs from the ledger",
    ar: "سلف عمال المصنع: جدول السلف يختلف عن الدفتر",
    fr: "Avances aux ouvriers d'usine : le tableau des avances diffère du grand livre",
  },
  {
    en: "Workers Payable",
    ar: "مستحقات العمال",
    fr: "Ouvriers à payer",
  },
  {
    en: "Not yet in the ledger (not included in the net position)",
    ar: "لم يُرحَّل إلى الدفتر بعد (غير مُدرج في صافي المركز)",
    fr: "Pas encore au grand livre (non inclus dans la position nette)",
  },
  {
    en: "Container amount not yet in the ledger, in a currency without a confirmed rate",
    ar: "مبلغ حاوية غير مُرحَّل بعد، بعملة بلا سعر صرف مؤكد",
    fr: "Montant de conteneur pas encore au grand livre, dans une devise sans taux confirmé",
  },
  // Wave 11: admin stock tools refuse after the perpetual-inventory cut-over
  // (server/services/accounting/perpetualInventory/cutoverRefusal.ts).
  {
    en: "This stock tool is not available after the company's perpetual inventory cut-over: it would change stock values without a matching journal.",
    ar: "أداة المخزون هذه غير متاحة بعد تحويل الشركة إلى الجرد المستمر: فهي ستغيّر قيم المخزون دون قيد مقابل.",
    fr: "Cet outil de stock n’est plus disponible après le passage de la société à l’inventaire permanent : il modifierait la valeur du stock sans écriture correspondante.",
  },
  // Wave 11: inventory movement journal refusals (perpetualInventory/inventoryMovementJournal.ts).
  {
    en: "The inventory movement has an invalid company or source",
    ar: "حركة المخزون تحتوي على شركة أو مصدر غير صالح",
    fr: "Le mouvement de stock a une société ou une source invalide",
  },
  {
    en: "The offset of an inventory movement must be a registry account other than Inventory",
    ar: "يجب أن يكون الطرف المقابل لحركة المخزون حسابًا نظاميًا غير حساب المخزون",
    fr: "La contrepartie d’un mouvement de stock doit être un compte système autre que Stock",
  },
  // Wave 11: factory bale cost basis (server/services/factory/baleCostBasis.ts, baleRecost.ts)
  // and the informational order lines of the factory net position.
  {
    en: "A mix source has no USD cost rate. Confirm the container's exchange rate or the supplier's rate before mixing or pressing under perpetual inventory.",
    ar: "أحد مصادر الخلطة ليس له سعر تكلفة بالدولار. أكّد سعر صرف الحاوية أو سعر المورد قبل الخلط أو الكبس في ظل الجرد المستمر.",
    fr: "Une source du mélange n’a pas de coût en USD. Confirmez le taux de change du conteneur ou le taux du fournisseur avant de mélanger ou de presser en inventaire permanent.",
  },
  {
    en: "Bale costs are now changed only through the reviewed re-cost: preview the plan, then an Owner confirms it.",
    ar: "لا تُغيَّر تكاليف البالات الآن إلا عبر إعادة التكلفة المراجَعة: اعرض الخطة، ثم يؤكدها المالك.",
    fr: "Le coût des balles ne change plus que par la revalorisation revue : prévisualisez le plan, puis un propriétaire le confirme.",
  },
  {
    en: "The re-cost plan changed since it was reviewed. Preview it again and confirm the new plan.",
    ar: "تغيّرت خطة إعادة التكلفة منذ مراجعتها. اعرضها مجددًا وأكّد الخطة الجديدة.",
    fr: "Le plan de revalorisation a changé depuis sa revue. Prévisualisez-le à nouveau et confirmez le nouveau plan.",
  },
  {
    en: "There is nothing to re-cost.",
    ar: "لا يوجد ما يُعاد تكليفه.",
    fr: "Il n’y a rien à revaloriser.",
  },
  {
    en: "The reviewed plan hash is required",
    ar: "رمز الخطة المراجَعة مطلوب",
    fr: "L’empreinte du plan revu est requise",
  },
  {
    en: "Pending orders at selling price (not invoiced; for information, their bales are in stock at cost)",
    ar: "طلبات معلّقة بسعر البيع (غير مفوترة؛ للعلم فقط، بالاتها ضمن المخزون بالتكلفة)",
    fr: "Commandes en attente au prix de vente (non facturées ; pour information, leurs balles sont en stock au coût)",
  },
  {
    en: "Verified orders at selling price (not invoiced; for information, their bales are in stock at cost)",
    ar: "طلبات مُتحقَّق منها بسعر البيع (غير مفوترة؛ للعلم فقط، بالاتها ضمن المخزون بالتكلفة)",
    fr: "Commandes vérifiées au prix de vente (non facturées ; pour information, leurs balles sont en stock au coût)",
  },
  {
    en: "Loading orders at selling price (not invoiced; for information, their bales are in stock at cost)",
    ar: "طلبات قيد التحميل بسعر البيع (غير مفوترة؛ للعلم فقط، بالاتها ضمن المخزون بالتكلفة)",
    fr: "Commandes en chargement au prix de vente (non facturées ; pour information, leurs balles sont en stock au coût)",
  },
  {
    en: "After the perpetual inventory cut-over a stock import must say what it is: an opening balance or a stock count.",
    ar: "بعد التحول إلى الجرد المستمر يجب أن يحدد استيراد المخزون نوعه: رصيد افتتاحي أو جرد فعلي.",
    fr: "Après le passage à l’inventaire permanent, un import de stock doit indiquer sa nature : solde d’ouverture ou inventaire physique.",
  },
  {
    en: "Only an Owner can import opening stock after the perpetual inventory cut-over.",
    ar: "يمكن للمالك فقط استيراد مخزون افتتاحي بعد التحول إلى الجرد المستمر.",
    fr: "Seul un propriétaire peut importer un stock d’ouverture après le passage à l’inventaire permanent.",
  },
  {
    en: "This line belongs to a posted stock document. Edit the document itself so its stock and journal move with the change.",
    ar: "هذا السطر ينتمي إلى مستند مخزون مُرحَّل. عدّل المستند نفسه لكي يتحرك مخزونه وقيده مع التعديل.",
    fr: "Cette ligne appartient à un document de stock comptabilisé. Modifiez le document lui-même pour que son stock et son écriture suivent la modification.",
  },
  {
    en: "This item has no stock cost at this location: enter its inventory cost before taking it back.",
    ar: "لا توجد تكلفة مخزون لهذا الصنف في هذا الموقع: أدخل تكلفة المخزون قبل استرجاعه.",
    fr: "Cet article n’a pas de coût de stock à cet emplacement : saisissez son coût d’inventaire avant de le reprendre.",
  },
  {
    en: "Transferring closing stock to another company has been retired: it moved stock value with no journal in either company. Use stock documents or the opening inventory journal instead.",
    ar: "تم إيقاف نقل مخزون آخر المدة إلى شركة أخرى: كان ينقل قيمة المخزون دون قيد في أي من الشركتين. استخدم مستندات المخزون أو قيد المخزون الافتتاحي بدلاً من ذلك.",
    fr: "Le transfert du stock de clôture vers une autre société a été retiré : il déplaçait la valeur du stock sans écriture dans aucune des deux sociétés. Utilisez plutôt les documents de stock ou l’écriture d’inventaire d’ouverture.",
  },
  {
    en: "This stock transfer cannot be reversed: its source or destination location is missing.",
    ar: "لا يمكن عكس تحويل المخزون هذا: موقع المصدر أو الوجهة مفقود.",
    fr: "Ce transfert de stock ne peut pas être annulé : son emplacement source ou de destination est manquant.",
  },
  // Factory daybook container cost edit narration (docs-users/daybookEditRoutes.ts),
  // now with the supplier suffix.
  {
    en: "Offloaded container ${container.containerNumber}${supplierNarrationSuffix}: ${container.actualReceivedKg} kg at ${inclusiveCostPerKg.toFixed(4)}/kg (inclusive) [edited]",
    ar: "حاوية مفرغة {{0}}{{1}}: {{2}} كغم بسعر {{3}}/كغم (شامل) [معدّل]",
    fr: "Conteneur déchargé {{0}}{{1}} : {{2}} kg à {{3}}/kg (inclus) [modifié]",
  },
  // Wave 11 follow-ups: ERP sale/transfer of a factory bale-mirror item after the
  // cut-over (cutoverRefusal.ts), and an offload of non-USD purchase orders under
  // perpetual inventory (services/containers/offload-lifecycle/execute.ts).
  {
    en: "This item mirrors factory bale stock: after the company's perpetual inventory cut-over it is sold and moved in the factory, not in the ERP.",
    ar: "هذا الصنف يعكس مخزون بالات المصنع: بعد تحويل الشركة إلى الجرد المستمر يُباع ويُنقل في المصنع، وليس في نظام ERP.",
    fr: "Cet article reflète le stock de balles de l’usine : après le passage de la société à l’inventaire permanent, il se vend et se déplace dans l’usine, pas dans l’ERP.",
  },
  {
    en: "This container's purchase orders are in a currency other than USD with no confirmed exchange rate: under perpetual inventory the stock cannot be valued, so the offload is refused. Record the purchase orders in USD first.",
    ar: "أوامر الشراء لهذه الحاوية بعملة غير الدولار الأمريكي دون سعر صرف مؤكد: في ظل الجرد المستمر لا يمكن تقييم المخزون، لذلك تم رفض التفريغ. سجّل أوامر الشراء بالدولار الأمريكي أولاً.",
    fr: "Les bons de commande de ce conteneur sont dans une devise autre que l’USD sans taux de change confirmé : en inventaire permanent le stock ne peut pas être valorisé, le déchargement est donc refusé. Enregistrez d’abord les bons de commande en USD.",
  },
  // Wave 8.4 continuation: factory POS sale refusals (services/accounting/factoryPosReceipt.ts).
  {
    en: "This sale is in a currency with no confirmed exchange rate on or before its date. Enter the factory exchange rate for that currency first.",
    ar: "هذا البيع بعملة ليس لها سعر صرف مؤكد في تاريخه أو قبله. أدخل سعر صرف المصنع لتلك العملة أولاً.",
    fr: "Cette vente est dans une devise sans taux de change confirmé à sa date ou avant. Saisissez d’abord le taux de change de l’usine pour cette devise.",
  },
  {
    en: "Choose the cash account that receives this sale's payment.",
    ar: "اختر حساب النقدية الذي يستلم دفعة هذا البيع.",
    fr: "Choisissez le compte de caisse qui reçoit le paiement de cette vente.",
  },
  {
    en: "A credit sale with an unpaid amount needs a customer.",
    ar: "يحتاج البيع الآجل الذي له مبلغ غير مدفوع إلى عميل.",
    fr: "Une vente à crédit avec un montant impayé nécessite un client.",
  },
  {
    en: "A factory POS sale voucher does not balance",
    ar: "قيد بيع نقطة البيع في المصنع غير متوازن",
    fr: "La pièce de vente du point de vente de l’usine n’est pas équilibrée",
  },
  // Wave 12 (A): ledger integrity refusals (stockVoucherTypes.ts, closedPeriodError.ts,
  // ledger/zero-balances.ts, docs-users/companyImportRoutes.ts).
  {
    en: "Production, consumption, mixed and stock adjustment vouchers can only be created and edited from the stock adjustment form.",
    ar: "لا يمكن إنشاء سندات الإنتاج والاستهلاك والسندات المختلطة وسندات تسوية المخزون وتعديلها إلا من نموذج تسوية المخزون.",
    fr: "Les pièces de production, de consommation, mixtes et d’ajustement de stock ne peuvent être créées et modifiées que depuis le formulaire d’ajustement de stock.",
  },
  {
    en: "Accounting period closed: the books are closed through ${closedThrough}, so an opening balance cannot be created or changed. Post an adjusting journal dated after the closed period instead.",
    ar: "الفترة المحاسبية مغلقة: الدفاتر مغلقة حتى {{0}}، لذلك لا يمكن إنشاء رصيد افتتاحي أو تغييره. سجّل بدلاً من ذلك قيد تسوية مؤرخاً بعد الفترة المغلقة.",
    fr: "Période comptable clôturée : les livres sont clôturés jusqu'au {{0}}, un solde d’ouverture ne peut donc pas être créé ni modifié. Passez plutôt une écriture d’ajustement datée après la période clôturée.",
  },
  {
    en: "Opening balances cannot be zeroed after a fiscal period has been closed. Post an adjusting journal dated after the closed period instead.",
    ar: "لا يمكن تصفير الأرصدة الافتتاحية بعد إغلاق فترة مالية. سجّل بدلاً من ذلك قيد تسوية مؤرخاً بعد الفترة المغلقة.",
    fr: "Les soldes d’ouverture ne peuvent pas être remis à zéro après la clôture d’un exercice. Passez plutôt une écriture d’ajustement datée après la période clôturée.",
  },
  {
    en: "The file contains posted vouchers whose debits do not equal their credits. They cannot be imported: correct them in the source company first.",
    ar: "يحتوي الملف على سندات مرحّلة لا تتساوى مدينتها مع دائنتها. لا يمكن استيرادها: صحّحها في الشركة المصدر أولاً.",
    fr: "Le fichier contient des pièces comptabilisées dont les débits ne sont pas égaux aux crédits. Elles ne peuvent pas être importées : corrigez-les d’abord dans la société source.",
  },
  // Wave 12 (B): audit trail and destructive routes.
  {
    en: "This company has accounting history (vouchers, stock, fiscal closures or balances) and cannot be deleted. Deactivate it instead.",
    ar: "لهذه الشركة سجل محاسبي (سندات أو مخزون أو إقفالات فترات مالية أو أرصدة) ولا يمكن حذفها. قم بتعطيلها بدلاً من ذلك.",
    fr: "Cette société a un historique comptable (pièces, stock, clôtures d’exercice ou soldes) et ne peut pas être supprimée. Désactivez-la plutôt.",
  },
  {
    en: "Only an Owner of the company can delete it.",
    ar: "لا يمكن حذف الشركة إلا من قبل مالكها.",
    fr: "Seul un propriétaire de la société peut la supprimer.",
  },
  {
    en: "This orphaned POS sale has ledger or stock lines, so it is posted and cannot be permanently deleted. Delete it as a voucher instead, which keeps its history.",
    ar: "يحتوي بيع نقطة البيع اليتيم هذا على بنود قيود أو مخزون، فهو مرحّل ولا يمكن حذفه نهائياً. احذفه كسند بدلاً من ذلك، مما يحتفظ بسجله.",
    fr: "Cette vente PDV orpheline a des lignes comptables ou de stock : elle est comptabilisée et ne peut pas être supprimée définitivement. Supprimez-la plutôt comme pièce, ce qui conserve son historique.",
  },
  {
    en: "This employee is named on voucher lines, salary advances or payroll, so it cannot be permanently deleted. Keep it in Deleted Items.",
    ar: "هذا الموظف مذكور في بنود سندات أو سلف رواتب أو كشوف رواتب، لذا لا يمكن حذفه نهائياً. أبقه في العناصر المحذوفة.",
    fr: "Cet employé figure sur des lignes de pièces, des avances sur salaire ou la paie : il ne peut pas être supprimé définitivement. Conservez-le dans les éléments supprimés.",
  },
  {
    en: "This customer is named on voucher lines or sales, so it cannot be permanently deleted. Keep it in Deleted Items.",
    ar: "هذا العميل مذكور في بنود سندات أو مبيعات، لذا لا يمكن حذفه نهائياً. أبقه في العناصر المحذوفة.",
    fr: "Ce client figure sur des lignes de pièces ou des ventes : il ne peut pas être supprimé définitivement. Conservez-le dans les éléments supprimés.",
  },
];
