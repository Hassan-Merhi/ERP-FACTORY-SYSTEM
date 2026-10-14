import type { Phase7BackendMessagesEntry } from "./backendMessagesPhase7TranslationTypes";

/** Backend validation messages added after the Phase 7 audit baseline. */
export const backendMessagesPhase7TranslationsPart13: readonly Phase7BackendMessagesEntry[] = [
  {
    en: "Factory fxRateToUsd for ${ccy} is required.",
    ar: "معدل Factory fxRateToUsd للعملة {0} مطلوب.",
    fr: "Le taux Factory fxRateToUsd pour {0} est requis.",
  },
  {
    en: "Factory fxRateToUsd for ${ccy} must be numeric.",
    ar: "يجب أن يكون معدل Factory fxRateToUsd للعملة {0} رقميًا.",
    fr: "Le taux Factory fxRateToUsd pour {0} doit être numérique.",
  },
  {
    en: "Factory fxRateToUsd for ${ccy} must be a positive finite rate.",
    ar: "يجب أن يكون معدل Factory fxRateToUsd للعملة {0} موجبًا ومحدودًا.",
    fr: "Le taux Factory fxRateToUsd pour {0} doit être positif et fini.",
  },
  {
    en: "clientSaleId must be at most 36 characters",
    ar: "يجب ألا يتجاوز clientSaleId 36 حرفًا",
    fr: "clientSaleId ne doit pas dépasser 36 caractères",
  },
  {
    en: "A watched user is required.",
    ar: "يجب تحديد مستخدم للمشاهدة.",
    fr: "Un utilisateur à surveiller est requis.",
  },
  {
    en: "No company selected.",
    ar: "لم يتم تحديد شركة.",
    fr: "Aucune société sélectionnée.",
  },
  {
    en: "No active screen feed is available for this user in the selected company.",
    ar: "لا توجد مشاركة شاشة نشطة متاحة لهذا المستخدم في الشركة المحددة.",
    fr: "Aucun flux d’écran actif n’est disponible pour cet utilisateur dans la société sélectionnée.",
  },
  {
    en: "Service temporarily unavailable — please retry.",
    ar: "الخدمة غير متوفرة مؤقتًا — يرجى إعادة المحاولة.",
    fr: "Service temporairement indisponible — veuillez réessayer.",
  },
  {
    en: "CSRF token missing or invalid.",
    ar: "رمز CSRF مفقود أو غير صالح.",
    fr: "Jeton CSRF manquant ou invalide.",
  },
  {
    en: "That color is already assigned to another active priority loading.",
    ar: "هذا اللون مخصص بالفعل لعملية تحميل أخرى ذات أولوية نشطة.",
    fr: "Cette couleur est déjà attribuée à un autre chargement prioritaire actif.",
  },
  {
    en: "That priority is already assigned to another active priority loading.",
    ar: "هذه الأولوية مخصصة بالفعل لعملية تحميل أخرى ذات أولوية نشطة.",
    fr: "Cette priorité est déjà attribuée à un autre chargement prioritaire actif.",
  },
  {
    en: "Priority Scan configuration changed at the same time. Please try again.",
    ar: "تم تغيير إعدادات المسح حسب الأولوية في الوقت نفسه. يرجى المحاولة مرة أخرى.",
    fr: "La configuration du scan prioritaire a été modifiée simultanément. Veuillez réessayer.",
  },
  {
    en: "Failed to load Priority Scan configuration.",
    ar: "تعذر تحميل إعدادات المسح حسب الأولوية.",
    fr: "Impossible de charger la configuration du scan prioritaire.",
  },
  {
    en: "Invalid loading id",
    ar: "معرّف التحميل غير صالح",
    fr: "Identifiant de chargement non valide",
  },
  {
    en: "Priority color must be one of the 11 approved HEX colors.",
    ar: "يجب أن يكون لون الأولوية أحد الألوان الأحد عشر المعتمدة بصيغة HEX.",
    fr: "La couleur de priorité doit être l’une des 11 couleurs HEX approuvées.",
  },
  {
    en: "Only an existing active priority can be moved without choosing a new color.",
    ar: "لا يمكن نقل سوى أولوية نشطة موجودة دون اختيار لون جديد.",
    fr: "Seule une priorité active existante peut être déplacée sans choisir de nouvelle couleur.",
  },
  {
    en: "Priority must be a whole number between 1 and 10000.",
    ar: "يجب أن تكون الأولوية عددًا صحيحًا بين 1 و10000.",
    fr: "La priorité doit être un nombre entier compris entre 1 et 10000.",
  },
  {
    en: "enabled must be true or false.",
    ar: "يجب أن تكون قيمة enabled إما true أو false.",
    fr: "La valeur enabled doit être true ou false.",
  },
  {
    en: "Pending loading not found.",
    ar: "لم يتم العثور على عملية التحميل المعلقة.",
    fr: "Chargement en attente introuvable.",
  },
  {
    en: "Only pending loadings in LOADING status can use Priority Scan.",
    ar: "يمكن فقط لعمليات التحميل المعلقة بحالة LOADING استخدام المسح حسب الأولوية.",
    fr: "Seuls les chargements en attente au statut LOADING peuvent utiliser le scan prioritaire.",
  },
  {
    en: "Link a proforma before enabling Priority Scan for this loading.",
    ar: "اربط فاتورة أولية قبل تفعيل المسح حسب الأولوية لهذا التحميل.",
    fr: "Associez une proforma avant d’activer le scan prioritaire pour ce chargement.",
  },
  {
    en: "Failed to save Priority Scan configuration.",
    ar: "تعذر حفظ إعدادات المسح حسب الأولوية.",
    fr: "Impossible d’enregistrer la configuration du scan prioritaire.",
  },
  {
    en: "Failed to clear Priority Scan configuration.",
    ar: "تعذر مسح إعدادات المسح حسب الأولوية.",
    fr: "Impossible d’effacer la configuration du scan prioritaire.",
  },
  {
    en: "Priority Scan cannot bypass proforma requirements or overload limits. Use the normal Pending Loading scanner for manual exceptions.",
    ar: "لا يمكن للمسح حسب الأولوية تجاوز متطلبات البروفرما أو حدود التحميل. استخدم ماسح التحميلات المعلقة العادي للاستثناءات اليدوية.",
    fr: "Le scan prioritaire ne peut pas contourner les exigences de proforma ni les limites de chargement. Utilisez le scanner normal des chargements en attente pour les exceptions manuelles.",
  },
  {
    en: "Priority Scan loading changed while the reference was routing. Scan again.",
    ar: "تغيّر تحميل المسح حسب الأولوية أثناء توجيه المرجع. امسح المرجع مرة أخرى.",
    fr: "Le chargement du scan prioritaire a changé pendant l’acheminement de la référence. Scannez à nouveau.",
  },
  {
    en: "Priority Scan requires an exact bale reference or bale code.",
    ar: "يتطلب المسح حسب الأولوية مرجع بالة أو رمز بالة مطابقًا تمامًا.",
    fr: "Le scan prioritaire exige une référence de balle ou un code de balle exact.",
  },
  {
    en: "This reference is no longer required by an active Priority Scan loading.",
    ar: "لم يعد هذا المرجع مطلوبًا في أي تحميل نشط للمسح حسب الأولوية.",
    fr: "Cette référence n’est plus requise par un chargement actif du scan prioritaire.",
  },
  {
    en: "This reference is not required by any active Priority Scan loading. Use the normal Pending Loading scanner for overload or items not requested on the proforma.",
    ar: "هذا المرجع غير مطلوب في أي تحميل نشط للمسح حسب الأولوية. استخدم ماسح التحميلات المعلقة العادي للتحميل الزائد أو الأصناف غير المطلوبة في البروفرما.",
    fr: "Cette référence n’est requise par aucun chargement actif du scan prioritaire. Utilisez le scanner normal des chargements en attente pour les surcharges ou les articles non demandés sur la proforma.",
  },
  {
    en: "Reference is not available in stock.",
    ar: "المرجع غير متوفر في المخزون.",
    fr: "La référence n’est pas disponible en stock.",
  },
  {
    en: "Reference has no stock location and cannot be routed.",
    ar: "لا يوجد موقع مخزون لهذا المرجع ولا يمكن توجيهه.",
    fr: "La référence n’a pas d’emplacement de stock et ne peut pas être acheminée.",
  },
  {
    en: "Reference has no article code and cannot be matched to a priority.",
    ar: "لا يحتوي المرجع على رمز صنف ولا يمكن مطابقته مع أولوية.",
    fr: "La référence n’a pas de code article et ne peut pas être associée à une priorité.",
  },
  {
    en: "Failed to resolve Priority Scan destination.",
    ar: "تعذر تحديد وجهة المسح حسب الأولوية.",
    fr: "Impossible de déterminer la destination du scan prioritaire.",
  },
  {
    en: "This loading already satisfies its linked proforma and does not need Priority Scan.",
    ar: "هذا التحميل يحقق بالفعل متطلبات البروفرما المرتبطة ولا يحتاج إلى المسح حسب الأولوية.",
    fr: "Ce chargement satisfait déjà sa proforma liée et n’a pas besoin du scan prioritaire.",
  },
  {
    en: "Priority Scan routing changed to Loading #${authoritativeTarget.orderId}. Routing again.",
    ar: "تغيّر توجيه المسح حسب الأولوية إلى التحميل #{0}. جارٍ إعادة التوجيه.",
    fr: "Le routage du scan prioritaire a changé vers le chargement #{0}. Nouvel acheminement en cours.",
  },
  {
    en: "Bale ${bale.referenceNumber} is already in ${orderRef} (${duplicate.status}).",
    ar: "البالة {0} موجودة بالفعل في {1} ({2}).",
    fr: "La balle {0} se trouve déjà dans {1} ({2}).",
  },
  {
    en: "Post-offload charge requires exactly one company-owned expense account or supplier and a valid payable account.",
    ar: "تتطلب الرسوم بعد التفريغ حساب مصروف أو مورّدًا واحدًا تابعًا للشركة، وحساب مستحقات صالحًا.",
    fr: "Les frais après déchargement nécessitent un compte de charges ou un fournisseur de la société, ainsi qu'un compte de dettes valide.",
  },
  {
    en: "Charge editing requires a valid same-company ledger destination; no unposted charge changes are permitted.",
    ar: "يتطلب تعديل الرسوم حسابًا محاسبيًا صالحًا تابعًا للشركة نفسها. لا يُسمح بتعديلات غير مُرحّلة.",
    fr: "La modification des frais exige un compte comptable valide de la même société. Aucune modification non comptabilisée n'est autorisée.",
  },
  {
    en: "Charge #${chargeRow.id} has missing historical voucher/daybook links. Reconcile the original records before editing or undoing it.",
    ar: "تفتقد الرسوم رقم {0} إلى روابط السند أو دفتر اليومية التاريخية. يجب تسوية السجلات الأصلية قبل تعديلها أو إلغائها.",
    fr: "Les frais n° {0} n'ont pas de liens historiques vers la pièce ou le journal. Rapprochez les écritures originales avant modification ou annulation.",
  },
  {
    en: "Cannot reverse offload while ${activePostOffloadCharges.length} post-offload charge(s) remain active. Undo those charges first so their vouchers and supplier costing are reversed safely.",
    ar: "لا يمكن عكس التفريغ مع وجود {0} رسوم نشطة بعد التفريغ. ألغِ هذه الرسوم أولاً لضمان عكس القيود وتكاليف المورد بأمان.",
    fr: "Impossible d'annuler le déchargement tant que {0} frais restent actifs. Annulez-les d'abord pour rétablir correctement les écritures et le coût fournisseur.",
  },
  {
    en: "Each post-offload charge needs exactly one ledger account or supplier before it can be saved.",
    ar: "يجب تحديد حساب محاسبي واحد أو مورّد واحد لكل رسم بعد التفريغ قبل الحفظ.",
    fr: "Chaque frais après déchargement exige exactement un compte comptable ou un fournisseur avant l'enregistrement.",
  },
  {
    en: "Charge ledger account must belong to the selected company.",
    ar: "يجب أن ينتمي الحساب المحاسبي للرسوم إلى الشركة المحددة.",
    fr: "Le compte comptable des frais doit appartenir à la société sélectionnée.",
  },
  {
    en: "A post-offload charge edit requires exactly one ledger account or supplier.",
    ar: "يتطلب تعديل رسم بعد التفريغ حسابًا محاسبيًا واحدًا أو مورّدًا واحدًا.",
    fr: "La modification des frais après déchargement exige exactement un compte comptable ou un fournisseur.",
  },
  {
    en: "Select the freight supplier or paying account before offloading.",
    ar: "اختر مورّد الشحن أو حساب الدفع قبل التفريغ.",
    fr: "Sélectionnez le fournisseur de fret ou le compte de paiement avant le déchargement.",
  },
  {
    en: "Select the other-charges supplier or paying account before offloading.",
    ar: "اختر مورّد الرسوم الأخرى أو حساب الدفع قبل التفريغ.",
    fr: "Sélectionnez le fournisseur des autres frais ou le compte de paiement avant le déchargement.",
  },
  {
    en: "Select the duty payment account before confirming duties and offloading.",
    ar: "اختر حساب سداد الرسوم الجمركية قبل تأكيدها والتفريغ.",
    fr: "Sélectionnez le compte de règlement des droits de douane avant leur confirmation et le déchargement.",
  },
  {
    en: "Each positive additional charge needs exactly one paying account or supplier.",
    ar: "تتطلب كل رسوم إضافية موجبة حساب دفع واحدًا أو مورّدًا واحدًا.",
    fr: "Chaque frais supplémentaire positif exige exactement un compte de paiement ou un fournisseur.",
  },
  {
    en: "Duty on container ${container.containerNumber}",
    ar: "رسوم جمركية على الحاوية {0}",
    fr: "Droits de douane du conteneur {0}",
  },
  {
    en: "Duty incurred - container ${container.containerNumber}",
    ar: "رسوم جمركية مستحقة - الحاوية {0}",
    fr: "Droits engagés - conteneur {0}",
  },
  {
    en: "Duty paid or payable through account - container ${container.containerNumber}",
    ar: "رسوم جمركية مدفوعة أو مستحقة عبر الحساب - الحاوية {0}",
    fr: "Droits payés ou dus via le compte - conteneur {0}",
  },
  {
    en: "Cannot reverse offload while post-offload charges remain active.",
    ar: "لا يمكن عكس التفريغ مع وجود رسوم نشطة بعد التفريغ.",
    fr: "Impossible d'annuler le déchargement tant que des frais restent actifs.",
  },
];
