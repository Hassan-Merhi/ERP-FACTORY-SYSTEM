import type { Phase7BackendMessagesEntry } from "./backendMessagesPhase7TranslationTypes";

// Source-level audit compatibility only: the type-safe callback annotation in
// chatbotPoImportRoutes changes the template-literal fingerprint but not the
// rendered backend message. Keep the canonical runtime translation entry below
// unchanged so its dynamic placeholders continue to compile normally.
// prettier-ignore
export const backendMessagesPhase7TypedCallbackAuditCompatibility = {
  en: '${unresolved.length} item(s) still unresolved: ${unresolved.map((l: { rawName?: unknown; itemName?: unknown }) => l.rawName || l.itemName).join(", ")}',
} as const;

export const backendMessagesPhase7TranslationsPart6: readonly Phase7BackendMessagesEntry[] = [
  {
    en: "PO number is required",
    ar: "رقم أمر الشراء مطلوب",
    fr: "Le numéro du bon de commande est requis",
  },
  {
    en: "Container number is required",
    ar: "رقم الحاوية مطلوب",
    fr: "Le numéro de conteneur est requis",
  },
  {
    en: "Supplier is required",
    ar: "المورد مطلوب",
    fr: "Le fournisseur est requis",
  },
  {
    en: "Selected supplier not found",
    ar: "المورد المحدد غير موجود",
    fr: "Le fournisseur sélectionné est introuvable",
  },
  {
    en: "At least one line item is required",
    ar: "يلزم بند واحد على الأقل",
    fr: "Au moins une ligne d’article est requise",
  },
  {
    en: '${unresolved.length} item(s) still unresolved: ${unresolved.map((l: any) => l.rawName || l.itemName).join(", ")}',
    ar: "لا يزال هناك {0} صنف غير محلول: {1}",
    fr: "{0} article(s) restent non résolus : {1}",
  },
  {
    en: 'A purchase order with number "${poNumber}" already exists. Please use a different PO number.',
    ar: "يوجد بالفعل أمر شراء بالرقم «{0}». يرجى استخدام رقم أمر شراء مختلف.",
    fr: "Un bon de commande portant le numéro « {0} » existe déjà. Utilisez un autre numéro.",
  },
  {
    en: 'Container "${containerNumber}" already has ${existingPOs.length} PO(s) imported (${existingPOs.map((p: any) => p.poNumber).join(", ")}). To avoid duplicates, please delete the existing POs first or use a different container number.',
    ar: "الحاوية «{0}» لديها بالفعل {1} أمر شراء مستورد ({2}). لتجنب التكرار، احذف أوامر الشراء الحالية أولًا أو استخدم رقم حاوية مختلفًا.",
    fr: "Le conteneur « {0} » possède déjà {1} bon(s) de commande importé(s) ({2}). Pour éviter les doublons, supprimez d’abord les bons existants ou utilisez un autre numéro de conteneur.",
  },
  {
    en: "Database connection successful",
    ar: "تم الاتصال بقاعدة البيانات بنجاح",
    fr: "Connexion à la base de données réussie",
  },
  {
    en: "Invalid note type. Must be 'Credit Note' or 'Debit Note'",
    ar: "نوع الإشعار غير صالح. يجب أن يكون 'إشعار دائن' أو 'إشعار مدين'",
    fr: "Type de note non valide. Il doit être « Note de crédit » ou « Note de débit »",
  },
  {
    en: "Voucher date is required",
    ar: "تاريخ السند مطلوب",
    fr: "La date de la pièce est requise",
  },
  {
    en: "Cash/Bank account is required",
    ar: "حساب النقد أو البنك مطلوب",
    fr: "Le compte Espèces ou Banque est requis",
  },
  {
    en: "Invalid stockItemId: ${item.stockItemId}",
    ar: "معرّف عنصر المخزون stockItemId غير صالح: {0}",
    fr: "stockItemId non valide : {0}",
  },
  {
    en: "Invalid locationId for item ${item.stockItemId}: ${item.locationId}",
    ar: "معرّف الموقع locationId غير صالح للصنف {0}: {1}",
    fr: "locationId non valide pour l’article {0} : {1}",
  },
  {
    en: "Invalid quantity for item ${item.stockItemId}: ${item.quantity}",
    ar: "كمية غير صالحة للصنف {0}: {1}",
    fr: "Quantité non valide pour l’article {0} : {1}",
  },
  {
    en: "Invalid quantity for item",
    ar: "كمية غير صالحة للصنف",
    fr: "Quantité d’article non valide",
  },
  {
    en: "Invalid refund rate for item",
    ar: "سعر الاسترداد غير صالح للصنف",
    fr: "Taux de remboursement non valide pour l’article",
  },
  {
    en: "${noteType} created successfully",
    ar: "تم إنشاء {0} بنجاح",
    fr: "{0} créé(e) avec succès",
  },
  {
    en: "Invalid credit note ID",
    ar: "معرّف الإشعار الدائن غير صالح",
    fr: "Identifiant de note de crédit non valide",
  },
  {
    en: "Credit note not found",
    ar: "لم يتم العثور على الإشعار الدائن",
    fr: "Note de crédit introuvable",
  },
  {
    en: "Not a credit/debit note",
    ar: "ليس إشعارًا دائنًا أو مدينًا",
    fr: "Ce n’est pas une note de crédit ou de débit",
  },
  {
    en: "${noteType} updated successfully",
    ar: "تم تحديث {0} بنجاح",
    fr: "{0} mis(e) à jour avec succès",
  },
  {
    en: "Location ${locationId} not found",
    ar: "لم يتم العثور على الموقع {0}",
    fr: "Emplacement {0} introuvable",
  },
  {
    en: "Accounts with Unknown Category",
    ar: "حسابات بفئة غير معروفة",
    fr: "Comptes de catégorie inconnue",
  },
  {
    en: "Found ${uncategorizedAccounts.length} account(s) with balance of $${Math.abs(totalUncategorized).toFixed(2)} that don't fit any standard category. These may be causing the imbalance.",
    ar: "تم العثور على {0} حساب برصيد قدره ${1} لا يندرج ضمن أي فئة قياسية. قد يكون ذلك سببًا في عدم التوازن.",
    fr: "{0} compte(s) présentant un solde de ${1} ne correspondent à aucune catégorie standard. Ils peuvent être à l’origine du déséquilibre.",
  },
  {
    en: "Variance in ${variance.bucket}",
    ar: "تباين في {0}",
    fr: "Écart dans {0}",
  },
  {
    en: "Computed value ($${variance.computed.toFixed(2)}) differs from account-level sum ($${variance.fromAccounts.toFixed(2)}) by $${Math.abs(variance.variance).toFixed(2)}. This may indicate double-counting or a calculation discrepancy.",
    ar: "تختلف القيمة المحسوبة (${0}) عن مجموع الحسابات (${1}) بمقدار ${2}. قد يشير ذلك إلى احتساب مزدوج أو اختلاف في الحساب.",
    fr: "La valeur calculée (${0}) diffère de la somme des comptes (${1}) de ${2}. Cela peut indiquer un double comptage ou un écart de calcul.",
  },
  {
    en: "Stock OTW",
    ar: "المخزون في الطريق",
    fr: "Stock en transit",
  },
  {
    en: "Bank",
    ar: "البنك",
    fr: "Banque",
  },
  {
    en: "Stock on Floor",
    ar: "المخزون على الأرض",
    fr: "Stock au sol",
  },
  {
    en: "Other Assets",
    ar: "أصول أخرى",
    fr: "Autres actifs",
  },
  {
    en: "Salary Advances",
    ar: "سلف الرواتب",
    fr: "Avances sur salaire",
  },
  {
    en: "Payroll Expenses",
    ar: "مصروفات الرواتب",
    fr: "Charges de paie",
  },
  {
    en: "Gov Taxes",
    ar: "ضرائب حكومية",
    fr: "Taxes gouvernementales",
  },
  {
    en: "Duty Agent",
    ar: "وكيل الرسوم الجمركية",
    fr: "Agent en douane",
  },
  {
    en: "Loans",
    ar: "قروض",
    fr: "Prêts",
  },
  {
    en: "Other Liabilities",
    ar: "التزامات أخرى",
    fr: "Autres passifs",
  },
  {
    en: "Profit",
    ar: "الربح",
    fr: "Bénéfice",
  },
  {
    en: "Payroll Liabilities",
    ar: "التزامات الرواتب",
    fr: "Dettes de paie",
  },
  {
    en: "Opening Equity",
    ar: "حقوق الملكية الافتتاحية",
    fr: "Capitaux propres d’ouverture",
  },
  {
    en: "Variance in",
    ar: "تباين في",
    fr: "Écart dans",
  },
  {
    en: "Computed: $",
    ar: "المحسوب: $",
    fr: "Calculé : $",
  },
  {
    en: "Container ${container.containerNumber} has unbalanced entries",
    ar: "الحاوية {0} تحتوي على قيود غير متوازنة",
    fr: "Le conteneur {0} contient des écritures déséquilibrées",
  },
  {
    en: "Voucher debits ($${container.voucherDebits.toFixed(2)}) do not equal credits ($${container.voucherCredits.toFixed(2)}). Difference: $${Math.abs(container.difference).toFixed(2)}. This container's offload entries are not balanced.",
    ar: "مدينات السند (${0}) لا تساوي الدائنات (${1}). الفرق: ${2}. قيود تفريغ هذه الحاوية غير متوازنة.",
    fr: "Les débits de la pièce (${0}) ne sont pas égaux aux crédits (${1}). Différence : ${2}. Les écritures de déchargement de ce conteneur sont déséquilibrées.",
  },
  {
    en: "Negative inventory: ${item.stockItemCode} at ${item.locationName ||",
    ar: "مخزون سالب: {0} في ${item.locationName ||",
    fr: "Stock négatif : {0} à ${item.locationName ||",
  },
  {
    en: "Orphaned inventory: ${item.stockItemCode} at deleted/missing location ${item.locationId}",
    ar: "مخزون معزول: {0} في موقع محذوف أو مفقود {1}",
    fr: "Stock orphelin : {0} dans l’emplacement supprimé ou manquant {1}",
  },
  {
    en: "Unbalanced voucher: ${voucher.voucherNumber} (${voucher.voucherType}) - Debits: $${debit.toFixed(2)}, Credits: $${credit.toFixed(2)}",
    ar: "سند غير متوازن: {0} ({1}) - المدينات: ${2}، الدائنات: ${3}",
    fr: "Pièce déséquilibrée : {0} ({1}) - Débits : ${2}, Crédits : ${3}",
  },
  {
    en: 'Stale OTW container: ${container.containerNumber} (${daysSinceCreated} days old) from ${container.supplierName || "Unknown Supplier"}',
    ar: "حاوية في الطريق متأخرة: {0} (منذ {1} يوم) من {2}",
    fr: "Conteneur en transit ancien : {0} ({1} jours) de {2}",
  },
  {
    en: "Duplicate inventory records: ${duplicate.count} records for same stock item at same location",
    ar: "سجلات مخزون مكررة: {0} سجلًا لنفس عنصر المخزون في الموقع نفسه",
    fr: "Enregistrements de stock dupliqués : {0} enregistrements pour le même article au même emplacement",
  },
  {
    en: "Company not selected",
    ar: "لم يتم تحديد الشركة",
    fr: "Aucune entreprise sélectionnée",
  },
  {
    en: "fromCurrency and toCurrency are required",
    ar: "العملتان fromCurrency وtoCurrency مطلوبتان",
    fr: "fromCurrency et toCurrency sont requis",
  },
];