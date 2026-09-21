import type { ApplicationLanguage } from "@shared/applicationLanguageContract";

type Translation = Record<ApplicationLanguage, string>;

const translations: Record<string, Translation> = {
  "Search worker…": { en: "Search worker…", ar: "ابحث عن عامل…", fr: "Rechercher un ouvrier…" },
  "e.g. short shift, holiday schedule…": {
    en: "e.g. short shift, holiday schedule…",
    ar: "مثال: وردية قصيرة، جدول عطلة…",
    fr: "ex. : courte équipe, horaire de vacances…",
  },
  "Filter workers by team": {
    en: "Filter workers by team",
    ar: "تصفية العمال حسب الفريق",
    fr: "Filtrer les ouvriers par équipe",
  },
  "All workers": { en: "All workers", ar: "كل العمال", fr: "Tous les ouvriers" },
  "No workers found.": { en: "No workers found.", ar: "لم يتم العثور على عمال.", fr: "Aucun ouvrier trouvé." },
  "Total Target:": { en: "Total Target:", ar: "إجمالي المستهدف:", fr: "Objectif total :" },
  "Total Actual:": { en: "Total Actual:", ar: "إجمالي الفعلي:", fr: "Total réalisé :" },
  "Loading plan…": { en: "Loading plan…", ar: "جارٍ تحميل الخطة…", fr: "Chargement du plan…" },
  Worker: { en: "Worker", ar: "عامل", fr: "Ouvrier" },
  Role: { en: "Role", ar: "الدور", fr: "Rôle" },
  Actual: { en: "Actual", ar: "الفعلي", fr: "Réalisé" },
  Used: { en: "Used", ar: "مستخدم", fr: "Utilisé" },
  "Target Met": { en: "Target Met", ar: "تم تحقيق المستهدف", fr: "Objectif atteint" },
  "No workers in plan. Add workers below or copy from a previous plan.": {
    en: "No workers in plan. Add workers below or copy from a previous plan.",
    ar: "لا يوجد عمال في الخطة. أضف عمالًا أدناه أو انسخ من خطة سابقة.",
    fr: "Aucun ouvrier dans le plan. Ajoutez-en ou copiez un plan précédent.",
  },
  "Plan saved": { en: "Plan saved", ar: "تم حفظ الخطة", fr: "Plan enregistré" },
  "Could not save plan": { en: "Could not save plan", ar: "تعذر حفظ الخطة", fr: "Impossible d’enregistrer le plan" },
  "No previous plan found": {
    en: "No previous plan found",
    ar: "لم يتم العثور على خطة سابقة",
    fr: "Aucun plan précédent trouvé",
  },
  "End Production is only available for a single daily production date": {
    en: "End Production is only available for a single daily production date",
    ar: "إنهاء الإنتاج متاح فقط لتاريخ إنتاج يومي واحد",
    fr: "La fin de production n’est disponible que pour une seule date de production quotidienne",
  },
  "Production has already ended for this day and is locked": {
    en: "Production has already ended for this day and is locked",
    ar: "انتهى الإنتاج بالفعل لهذا اليوم وتم قفله",
    fr: "La production est déjà terminée pour cette journée et est verrouillée",
  },
  "Production Targets only supports factory workers": {
    en: "Production Targets only supports factory workers",
    ar: "أهداف الإنتاج تدعم عمال المصنع فقط",
    fr: "Les objectifs de production prennent uniquement en charge les ouvriers de l’usine",
  },
  "Worker is not assigned to a saved Production Planner group": {
    en: "Worker is not assigned to a saved Production Planner group",
    ar: "العامل غير معيّن إلى مجموعة محفوظة في مخطط الإنتاج",
    fr: "L’ouvrier n’est affecté à aucun groupe enregistré du planificateur de production",
  },
  "Copied plan from ${data.fromDate}": {
    en: "Copied plan from ${data.fromDate}",
    ar: "تم نسخ الخطة من ${data.fromDate}",
    fr: "Plan copié depuis le ${data.fromDate}",
  },
  "Container Planner could not load the complete stock list.": {
    en: "Container Planner could not load the complete stock list.",
    ar: "تعذر على مخطط الحاويات تحميل قائمة المخزون الكاملة.",
    fr: "Le planificateur de conteneurs n’a pas pu charger la liste complète du stock.",
  },
  "Container Planner": {
    en: "Container Planner",
    ar: "مخطط الحاويات",
    fr: "Planificateur de conteneurs",
  },
  "Target capacity (bales)": {
    en: "Target capacity (bales)",
    ar: "السعة المستهدفة (بالات)",
    fr: "Capacité cible (balles)",
  },
  "Physical stock": {
    en: "Physical stock",
    ar: "المخزون الفعلي",
    fr: "Stock physique",
  },
  "Customer committed": {
    en: "Customer committed",
    ar: "محجوز للعملاء",
    fr: "Engagé pour les clients",
  },
  "Already loading": {
    en: "Already loading",
    ar: "قيد التحميل بالفعل",
    fr: "Déjà en chargement",
  },
  "Available to plan": {
    en: "Available to plan",
    ar: "متاح للتخطيط",
    fr: "Disponible à planifier",
  },
  "Planned containers": {
    en: "Planned containers",
    ar: "الحاويات المخططة",
    fr: "Conteneurs planifiés",
  },
  "Average / container": {
    en: "Average / container",
    ar: "المتوسط / حاوية",
    fr: "Moyenne / conteneur",
  },
  "There is no positive uncommitted stock to distribute right now.": {
    en: "There is no positive uncommitted stock to distribute right now.",
    ar: "لا يوجد حالياً مخزون موجب غير محجوز لتوزيعه.",
    fr: "Il n’y a actuellement aucun stock positif non engagé à répartir.",
  },
  "Balanced container totals": {
    en: "Balanced container totals",
    ar: "إجماليات الحاويات المتوازنة",
    fr: "Totaux équilibrés des conteneurs",
  },
  "Free stock": {
    en: "Free stock",
    ar: "المخزون الحر",
    fr: "Stock libre",
  },
  "Container ${index + 1}": {
    en: "Container ${index + 1}",
    ar: "الحاوية ${index + 1}",
    fr: "Conteneur ${index + 1}",
  },
  "Save this preview": {
    en: "Save this preview",
    ar: "حفظ هذه المعاينة",
    fr: "Enregistrer cet aperçu",
  },
  "Saving creates a planning draft only. Physical bales and customer loading remain untouched.": {
    en: "Saving creates a planning draft only. Physical bales and customer loading remain untouched.",
    ar: "الحفظ ينشئ مسودة تخطيط فقط. البالات الفعلية وتحميل العملاء لا يتغيران.",
    fr: "L’enregistrement crée uniquement un brouillon de planification. Les balles physiques et les chargements clients restent inchangés.",
  },
  "Optional plan name": {
    en: "Optional plan name",
    ar: "اسم الخطة اختياري",
    fr: "Nom du plan facultatif",
  },
  "Save Plan": { en: "Save Plan", ar: "حفظ الخطة", fr: "Enregistrer le plan" },
  "Saved container plans": {
    en: "Saved container plans",
    ar: "خطط الحاويات المحفوظة",
    fr: "Plans de conteneurs enregistrés",
  },
  "Edit quantities by moving bales between unlocked containers. Lock containers you do not want rebalanced.": {
    en: "Edit quantities by moving bales between unlocked containers. Lock containers you do not want rebalanced.",
    ar: "عدّل الكميات بنقل البالات بين الحاويات غير المقفلة. اقفل الحاويات التي لا تريد إعادة موازنتها.",
    fr: "Modifiez les quantités en déplaçant les balles entre les conteneurs déverrouillés. Verrouillez ceux qui ne doivent pas être rééquilibrés.",
  },
  "No saved container plans yet.": {
    en: "No saved container plans yet.",
    ar: "لا توجد خطط حاويات محفوظة بعد.",
    fr: "Aucun plan de conteneurs enregistré pour le moment.",
  },
  "Rebalance Unlocked": {
    en: "Rebalance Unlocked",
    ar: "إعادة موازنة غير المقفل",
    fr: "Rééquilibrer les déverrouillés",
  },
  Delete: { en: "Delete", ar: "حذف", fr: "Supprimer" },
  "Confirm Delete": { en: "Confirm Delete", ar: "تأكيد الحذف", fr: "Confirmer la suppression" },
  Cancel: { en: "Cancel", ar: "إلغاء", fr: "Annuler" },
  "Save Name": { en: "Save Name", ar: "حفظ الاسم", fr: "Enregistrer le nom" },
  "Locked · rebalance protected": {
    en: "Locked · rebalance protected",
    ar: "مقفل · محمي من إعادة الموازنة",
    fr: "Verrouillé · protégé du rééquilibrage",
  },
  Unlocked: { en: "Unlocked", ar: "غير مقفل", fr: "Déverrouillé" },
  "Move product": { en: "Move product", ar: "نقل المنتج", fr: "Déplacer le produit" },
  Quantity: { en: "Quantity", ar: "الكمية", fr: "Quantité" },
  Destination: { en: "Destination", ar: "الوجهة", fr: "Destination" },
  "No unlocked destination has space": {
    en: "No unlocked destination has space",
    ar: "لا توجد حاوية وجهة غير مقفلة بها مساحة",
    fr: "Aucun conteneur de destination déverrouillé n’a de place",
  },
  Move: { en: "Move", ar: "نقل", fr: "Déplacer" },
  "Plan already saved": {
    en: "Plan already saved",
    ar: "الخطة محفوظة بالفعل",
    fr: "Plan déjà enregistré",
  },
  "Container plan saved": {
    en: "Container plan saved",
    ar: "تم حفظ خطة الحاويات",
    fr: "Plan de conteneurs enregistré",
  },
  "Plan renamed": { en: "Plan renamed", ar: "تمت إعادة تسمية الخطة", fr: "Plan renommé" },
  "Container lock updated": {
    en: "Container lock updated",
    ar: "تم تحديث قفل الحاوية",
    fr: "Verrouillage du conteneur mis à jour",
  },
  "Bales moved": { en: "Bales moved", ar: "تم نقل البالات", fr: "Balles déplacées" },
  "Unlocked containers rebalanced": {
    en: "Unlocked containers rebalanced",
    ar: "تمت إعادة موازنة الحاويات غير المقفلة",
    fr: "Conteneurs déverrouillés rééquilibrés",
  },
  "Locked containers were left unchanged.": {
    en: "Locked containers were left unchanged.",
    ar: "لم يتم تغيير الحاويات المقفلة.",
    fr: "Les conteneurs verrouillés sont restés inchangés.",
  },
  "Container plan deleted": {
    en: "Container plan deleted",
    ar: "تم حذف خطة الحاويات",
    fr: "Plan de conteneurs supprimé",
  },
  "Could not rename plan": {
    en: "Could not rename plan",
    ar: "تعذرت إعادة تسمية الخطة",
    fr: "Impossible de renommer le plan",
  },
  "Could not update lock": {
    en: "Could not update lock",
    ar: "تعذر تحديث القفل",
    fr: "Impossible de mettre à jour le verrouillage",
  },
  "Could not move bales": {
    en: "Could not move bales",
    ar: "تعذر نقل البالات",
    fr: "Impossible de déplacer les balles",
  },
  "Could not rebalance plan": {
    en: "Could not rebalance plan",
    ar: "تعذرت إعادة موازنة الخطة",
    fr: "Impossible de rééquilibrer le plan",
  },
  "Could not delete plan": {
    en: "Could not delete plan",
    ar: "تعذر حذف الخطة",
    fr: "Impossible de supprimer le plan",
  },
  "Could not load saved plans.": {
    en: "Could not load saved plans.",
    ar: "تعذر تحميل خطط الحاويات المحفوظة.",
    fr: "Impossible de charger les plans de conteneurs enregistrés.",
  },
  "Could not load plan.": {
    en: "Could not load plan.",
    ar: "تعذر تحميل الخطة.",
    fr: "Impossible de charger le plan.",
  },
  "Unlock container": {
    en: "Unlock container",
    ar: "إلغاء قفل الحاوية",
    fr: "Déverrouiller le conteneur",
  },
  "Lock container": {
    en: "Lock container",
    ar: "قفل الحاوية",
    fr: "Verrouiller le conteneur",
  },
  "Move bales to another unlocked container": {
    en: "Move bales to another unlocked container",
    ar: "نقل البالات إلى حاوية أخرى غير مقفلة",
    fr: "Déplacer les balles vers un autre conteneur déverrouillé",
  },
  "Phase 2": { en: "Phase 2", ar: "المرحلة 2", fr: "Phase 2" },
  "${data.plan.containers.length} containers · ${formatQty(data.plan.totalPlanned)} bales": {
    en: "${data.plan.containers.length} containers · ${formatQty(data.plan.totalPlanned)} bales",
    ar: "${data.plan.containers.length} حاويات · ${formatQty(data.plan.totalPlanned)} بالات",
    fr: "${data.plan.containers.length} conteneurs · ${formatQty(data.plan.totalPlanned)} balles",
  },
  "Invalid plan id": { en: "Invalid plan id", ar: "معرّف الخطة غير صالح", fr: "Identifiant de plan invalide" },
  "Container plan not found": {
    en: "Container plan not found",
    ar: "لم يتم العثور على خطة الحاويات",
    fr: "Plan de conteneurs introuvable",
  },
  "Capacity must be a whole number from 1 to ${MAX_CONTAINER_CAPACITY}": {
    en: "Capacity must be a whole number from 1 to ${MAX_CONTAINER_CAPACITY}",
    ar: "يجب أن تكون السعة عددًا صحيحًا من 1 إلى ${MAX_CONTAINER_CAPACITY}",
    fr: "La capacité doit être un nombre entier de 1 à ${MAX_CONTAINER_CAPACITY}",
  },
  "There is no positive uncommitted stock available to save.": {
    en: "There is no positive uncommitted stock available to save.",
    ar: "لا يوجد مخزون موجب غير محجوز متاح للحفظ.",
    fr: "Aucun stock positif non engagé n’est disponible à enregistrer.",
  },
  "Plan name is required": {
    en: "Plan name is required",
    ar: "اسم الخطة مطلوب",
    fr: "Le nom du plan est requis",
  },
  "Plan, source, destination, product and positive quantity are required": {
    en: "Plan, source, destination, product and positive quantity are required",
    ar: "الخطة والمصدر والوجهة والمنتج والكمية الموجبة مطلوبة",
    fr: "Le plan, la source, la destination, le produit et une quantité positive sont requis",
  },
  "Choose a different destination container": {
    en: "Choose a different destination container",
    ar: "اختر حاوية وجهة مختلفة",
    fr: "Choisissez un autre conteneur de destination",
  },
  "Source or destination container not found": {
    en: "Source or destination container not found",
    ar: "لم يتم العثور على حاوية المصدر أو الوجهة",
    fr: "Conteneur source ou destination introuvable",
  },
  "Locked containers cannot be edited. Unlock them first.": {
    en: "Locked containers cannot be edited. Unlock them first.",
    ar: "لا يمكن تعديل الحاويات المقفلة. قم بإلغاء قفلها أولاً.",
    fr: "Les conteneurs verrouillés ne peuvent pas être modifiés. Déverrouillez-les d’abord.",
  },
  "The source container does not have enough of this product.": {
    en: "The source container does not have enough of this product.",
    ar: "لا تحتوي حاوية المصدر على كمية كافية من هذا المنتج.",
    fr: "Le conteneur source ne contient pas assez de ce produit.",
  },
  "Destination capacity exceeded. Only ${Math.max(destinationCapacity - destinationTotal, 0)} more bales fit.": {
    en: "Destination capacity exceeded. Only ${Math.max(destinationCapacity - destinationTotal, 0)} more bales fit.",
    ar: "تم تجاوز سعة الوجهة. لا تتسع إلا لـ ${Math.max(destinationCapacity - destinationTotal, 0)} بالات إضافية.",
    fr: "Capacité de destination dépassée. Il ne reste de la place que pour ${Math.max(destinationCapacity - destinationTotal, 0)} balles.",
  },
  "Valid plan, container and lock state are required": {
    en: "Valid plan, container and lock state are required",
    ar: "يلزم تحديد خطة وحاوية وحالة قفل صالحة",
    fr: "Un plan, un conteneur et un état de verrouillage valides sont requis",
  },
  "Container ${container.position + 1} exceeds the ${capacity}-bale capacity.": {
    en: "Container ${container.position + 1} exceeds the ${capacity}-bale capacity.",
    ar: "الحاوية ${container.position + 1} تتجاوز سعة ${capacity} بالة.",
    fr: "Le conteneur ${container.position + 1} dépasse la capacité de ${capacity} balles.",
  },
  "All containers are locked. Unlock at least one container before rebalancing.": {
    en: "All containers are locked. Unlock at least one container before rebalancing.",
    ar: "جميع الحاويات مقفلة. ألغِ قفل حاوية واحدة على الأقل قبل إعادة الموازنة.",
    fr: "Tous les conteneurs sont verrouillés. Déverrouillez-en au moins un avant le rééquilibrage.",
  },
  "Unlocked containers can hold ${unlockedCapacity.toLocaleString()} bales, but ${totalRemaining.toLocaleString()} bales still need placement. Unlock more containers first.": {
    en: "Unlocked containers can hold ${unlockedCapacity.toLocaleString()} bales, but ${totalRemaining.toLocaleString()} bales still need placement. Unlock more containers first.",
    ar: "يمكن للحاويات غير المقفلة استيعاب ${unlockedCapacity.toLocaleString()} بالة، لكن لا يزال يلزم توزيع ${totalRemaining.toLocaleString()} بالة. ألغِ قفل المزيد من الحاويات أولاً.",
    fr: "Les conteneurs déverrouillés peuvent contenir ${unlockedCapacity.toLocaleString()} balles, mais ${totalRemaining.toLocaleString()} balles restent à placer. Déverrouillez d’abord davantage de conteneurs.",
  },
  "The remaining plan cannot fit inside the unlocked container capacity.": {
    en: "The remaining plan cannot fit inside the unlocked container capacity.",
    ar: "لا يمكن استيعاب بقية الخطة ضمن سعة الحاويات غير المقفلة.",
    fr: "Le reste du plan ne tient pas dans la capacité des conteneurs déverrouillés.",
  },
  "New bale stock entry controls": {
    en: "New bale stock entry controls",
    ar: "عناصر التحكم لإدخال مخزون بالات جديد",
    fr: "Contrôles de nouvelle entrée de stock de balles",
  },
  "Printing in progress — Stock Entry is locked": {
    en: "Printing in progress — Stock Entry is locked",
    ar: "الطباعة قيد التنفيذ — إدخال المخزون مقفل",
    fr: "Impression en cours — l’entrée de stock est verrouillée",
  },
  "Print tabs blocked": {
    en: "Print tabs blocked",
    ar: "تم حظر علامات تبويب الطباعة",
    fr: "Onglets d’impression bloqués",
  },
  "Allow popups for this ERP, then click Reopen Print Tabs again.": {
    en: "Allow popups for this ERP, then click Reopen Print Tabs again.",
    ar: "اسمح بالنوافذ المنبثقة لهذا النظام، ثم اضغط على إعادة فتح علامات تبويب الطباعة مرة أخرى.",
    fr: "Autorisez les fenêtres contextuelles pour cet ERP, puis cliquez de nouveau sur Rouvrir les onglets d’impression.",
  },
  "Finish printing first": {
    en: "Finish printing first",
    ar: "أنه الطباعة أولاً",
    fr: "Terminez d’abord l’impression",
  },
  "Close both print tabs before entering another bale.": {
    en: "Close both print tabs before entering another bale.",
    ar: "أغلق علامتي تبويب الطباعة قبل إدخال بالة أخرى.",
    fr: "Fermez les deux onglets d’impression avant de saisir une autre balle.",
  },
  "Print tabs closed too early": {
    en: "Print tabs closed too early",
    ar: "تم إغلاق علامات تبويب الطباعة مبكرًا",
    fr: "Onglets d’impression fermés trop tôt",
  },
  "The bale was saved. Reopen the two print tabs to print its labels before continuing.": {
    en: "The bale was saved. Reopen the two print tabs to print its labels before continuing.",
    ar: "تم حفظ البالة. أعد فتح علامتي تبويب الطباعة لطباعة ملصقاتها قبل المتابعة.",
    fr: "La balle a été enregistrée. Rouvrez les deux onglets d’impression pour imprimer ses étiquettes avant de continuer.",
  },
  "Allow popups for this ERP. Stock Entry was not saved, so no bale was created.": {
    en: "Allow popups for this ERP. Stock Entry was not saved, so no bale was created.",
    ar: "اسمح بالنوافذ المنبثقة لهذا النظام. لم يتم حفظ إدخال المخزون، لذلك لم يتم إنشاء أي بالة.",
    fr: "Autorisez les fenêtres contextuelles pour cet ERP. L’entrée de stock n’a pas été enregistrée, donc aucune balle n’a été créée.",
  },
  "Phase 3": { en: "Phase 3", ar: "المرحلة 3", fr: "Phase 3" },
  "Live stock reconciliation": {
    en: "Live stock reconciliation",
    ar: "مطابقة المخزون المباشرة",
    fr: "Rapprochement du stock en direct",
  },
  "Checking plan against current stock…": {
    en: "Checking plan against current stock…",
    ar: "جارٍ مقارنة الخطة بالمخزون الحالي…",
    fr: "Comparaison du plan avec le stock actuel…",
  },
  "Could not check current stock against this plan.": {
    en: "Could not check current stock against this plan.",
    ar: "تعذر مقارنة المخزون الحالي بهذه الخطة.",
    fr: "Impossible de comparer le stock actuel à ce plan.",
  },
  "In sync": { en: "In sync", ar: "متطابق", fr: "Synchronisé" },
  "Locked conflict": { en: "Locked conflict", ar: "تعارض في حاوية مقفلة", fr: "Conflit verrouillé" },
  "Stock changed": { en: "Stock changed", ar: "تغير المخزون", fr: "Stock modifié" },
  "Compares this saved plan with current uncommitted V5 stock. Nothing changes until Reconcile to Current Stock is pressed.": {
    en: "Compares this saved plan with current uncommitted V5 stock. Nothing changes until Reconcile to Current Stock is pressed.",
    ar: "يقارن هذه الخطة المحفوظة بالمخزون الحالي غير المحجوز في V5. لن يتغير شيء حتى تضغط مطابقة مع المخزون الحالي.",
    fr: "Compare ce plan enregistré au stock V5 actuel non engagé. Rien ne change tant que vous n’appuyez pas sur Rapprocher avec le stock actuel.",
  },
  "Refresh Check": { en: "Refresh Check", ar: "تحديث الفحص", fr: "Actualiser le contrôle" },
  "Reconcile to Current Stock": {
    en: "Reconcile to Current Stock",
    ar: "مطابقة مع المخزون الحالي",
    fr: "Rapprocher avec le stock actuel",
  },
  "Current available": { en: "Current available", ar: "المتاح حالياً", fr: "Disponible actuellement" },
  "Plan total": { en: "Plan total", ar: "إجمالي الخطة", fr: "Total du plan" },
  "New / unplanned": { en: "New / unplanned", ar: "جديد / غير مخطط", fr: "Nouveau / non planifié" },
  "Over-planned": { en: "Over-planned", ar: "مخطط بزيادة", fr: "Surplanifié" },
  "Locked conflicts": { en: "Locked conflicts", ar: "تعارضات مقفلة", fr: "Conflits verrouillés" },
  "Customer committed now": {
    en: "Customer committed now",
    ar: "محجوز للعملاء الآن",
    fr: "Engagé pour les clients maintenant",
  },
  "This plan matches current free stock.": {
    en: "This plan matches current free stock.",
    ar: "هذه الخطة تطابق المخزون الحر الحالي.",
    fr: "Ce plan correspond au stock libre actuel.",
  },
  "No reconciliation is needed.": {
    en: "No reconciliation is needed.",
    ar: "لا حاجة إلى مطابقة.",
    fr: "Aucun rapprochement n’est nécessaire.",
  },
  "locked bales conflict with current stock.": {
    en: "locked bales conflict with current stock.",
    ar: "بالات مقفلة تتعارض مع المخزون الحالي.",
    fr: "balles verrouillées sont en conflit avec le stock actuel.",
  },
  "Unlock the affected container or containers first. Phase 3 will never silently reduce a locked container.": {
    en: "Unlock the affected container or containers first. Phase 3 will never silently reduce a locked container.",
    ar: "ألغِ قفل الحاوية أو الحاويات المتأثرة أولاً. المرحلة 3 لن تخفّض أي حاوية مقفلة تلقائياً.",
    fr: "Déverrouillez d’abord le ou les conteneurs concernés. La phase 3 ne réduira jamais silencieusement un conteneur verrouillé.",
  },
  "Current stock has changed since this plan was saved.": {
    en: "Current stock has changed since this plan was saved.",
    ar: "تغير المخزون الحالي منذ حفظ هذه الخطة.",
    fr: "Le stock actuel a changé depuis l’enregistrement de ce plan.",
  },
  "Reconcile will preserve locked containers, resize the unlocked container count when needed, and rebalance only the unlocked quantities.": {
    en: "Reconcile will preserve locked containers, resize the unlocked container count when needed, and rebalance only the unlocked quantities.",
    ar: "المطابقة ستحافظ على الحاويات المقفلة، وتعدّل عدد الحاويات غير المقفلة عند الحاجة، وتعيد موازنة الكميات غير المقفلة فقط.",
    fr: "Le rapprochement préservera les conteneurs verrouillés, ajustera le nombre de conteneurs déverrouillés si nécessaire et rééquilibrera uniquement les quantités déverrouillées.",
  },
  Current: { en: "Current", ar: "الحالي", fr: "Actuel" },
  Planned: { en: "Planned", ar: "المخطط", fr: "Planifié" },
  Change: { en: "Change", ar: "التغيير", fr: "Écart" },
  Locked: { en: "Locked", ar: "مقفل", fr: "Verrouillé" },
  "Checked": { en: "Checked", ar: "تم الفحص", fr: "Vérifié" },
  "Locked containers are preserved exactly; reconciliation never reserves physical bale IDs or changes customer loading.": {
    en: "Locked containers are preserved exactly; reconciliation never reserves physical bale IDs or changes customer loading.",
    ar: "يتم الحفاظ على الحاويات المقفلة كما هي تماماً؛ المطابقة لا تحجز معرّفات بالات فعلية ولا تغيّر تحميل العملاء.",
    fr: "Les conteneurs verrouillés sont conservés exactement ; le rapprochement ne réserve jamais d’identifiants de balles physiques et ne modifie pas les chargements clients.",
  },
  "Container plan reconciled": {
    en: "Container plan reconciled",
    ar: "تمت مطابقة خطة الحاويات",
    fr: "Plan de conteneurs rapproché",
  },
  "Plan now matches current stock.": {
    en: "Plan now matches current stock.",
    ar: "الخطة الآن تطابق المخزون الحالي.",
    fr: "Le plan correspond maintenant au stock actuel.",
  },
  "Could not reconcile plan": {
    en: "Could not reconcile plan",
    ar: "تعذرت مطابقة الخطة",
    fr: "Impossible de rapprocher le plan",
  },
  "Only draft container plans can be reconciled.": {
    en: "Only draft container plans can be reconciled.",
    ar: "يمكن مطابقة خطط الحاويات المسودة فقط.",
    fr: "Seuls les plans de conteneurs en brouillon peuvent être rapprochés.",
  },
  "Locked container quantities exceed current available stock. Unlock the affected containers before reconciling.": {
    en: "Locked container quantities exceed current available stock. Unlock the affected containers before reconciling.",
    ar: "كميات الحاويات المقفلة تتجاوز المخزون المتاح حالياً. ألغِ قفل الحاويات المتأثرة قبل المطابقة.",
    fr: "Les quantités des conteneurs verrouillés dépassent le stock actuellement disponible. Déverrouillez les conteneurs concernés avant le rapprochement.",
  },
  "The current stock cannot fit inside the available unlocked container capacity.": {
    en: "The current stock cannot fit inside the available unlocked container capacity.",
    ar: "لا يمكن استيعاب المخزون الحالي ضمن سعة الحاويات غير المقفلة المتاحة.",
    fr: "Le stock actuel ne peut pas tenir dans la capacité disponible des conteneurs déverrouillés.",
  },
};

export function translateFactoryProductionPlannerText(value: string, language: ApplicationLanguage): string | null {
  if (value.startsWith("Copied plan from ")) {
    const date = value.slice("Copied plan from ".length);
    const translated = translations["Copied plan from ${data.fromDate}"][language];
    return translated.replace("${data.fromDate}", date);
  }

  const containerMatch = value.match(/^Container (\d+)$/);
  if (containerMatch) {
    const translated = translations["Container ${index + 1}"][language];
    return translated.replace("${index + 1}", containerMatch[1]);
  }

  const savedSummaryMatch = value.match(/^(\d+) containers · ([\d,]+) bales$/);
  if (savedSummaryMatch) {
    return translations["${data.plan.containers.length} containers · ${formatQty(data.plan.totalPlanned)} bales"][
      language
    ]
      .replace("${data.plan.containers.length}", savedSummaryMatch[1])
      .replace("${formatQty(data.plan.totalPlanned)}", savedSummaryMatch[2]);
  }

  const capacityMatch = value.match(/^Capacity must be a whole number from 1 to ([\d,]+)$/);
  if (capacityMatch) {
    return translations["Capacity must be a whole number from 1 to ${MAX_CONTAINER_CAPACITY}"][language].replace(
      "${MAX_CONTAINER_CAPACITY}",
      capacityMatch[1],
    );
  }

  const destinationMatch = value.match(/^Destination capacity exceeded\. Only ([\d,]+) more bales fit\.$/);
  if (destinationMatch) {
    return translations[
      "Destination capacity exceeded. Only ${Math.max(destinationCapacity - destinationTotal, 0)} more bales fit."
    ][language].replace("${Math.max(destinationCapacity - destinationTotal, 0)}", destinationMatch[1]);
  }

  const containerCapacityMatch = value.match(/^Container (\d+) exceeds the ([\d,]+)-bale capacity\.$/);
  if (containerCapacityMatch) {
    return translations["Container ${container.position + 1} exceeds the ${capacity}-bale capacity."][language]
      .replace("${container.position + 1}", containerCapacityMatch[1])
      .replace("${capacity}", containerCapacityMatch[2]);
  }

  const unlockedCapacityMatch = value.match(
    /^Unlocked containers can hold ([\d,]+) bales, but ([\d,]+) bales still need placement\. Unlock more containers first\.$/,
  );
  if (unlockedCapacityMatch) {
    return translations[
      "Unlocked containers can hold ${unlockedCapacity.toLocaleString()} bales, but ${totalRemaining.toLocaleString()} bales still need placement. Unlock more containers first."
    ][language]
      .replace("${unlockedCapacity.toLocaleString()}", unlockedCapacityMatch[1])
      .replace("${totalRemaining.toLocaleString()}", unlockedCapacityMatch[2]);
  }

  return translations[value]?.[language] ?? null;
}
