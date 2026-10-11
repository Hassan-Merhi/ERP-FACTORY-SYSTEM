import type { Phase7BackendMessagesEntry } from "./backendMessagesPhase7TranslationTypes";

export const backendMessagesPhase7TranslationsPart5: readonly Phase7BackendMessagesEntry[] = [
  {
    en: "Useful life (years) is required and must be greater than 0 when depreciation method is not 'None'",
    ar: "العمر الإنتاجي بالسنوات مطلوب ويجب أن يكون أكبر من صفر عندما لا تكون طريقة الإهلاك 'بدون إهلاك'",
    fr: "La durée d’utilisation en années est requise et doit être supérieure à 0 lorsque la méthode d’amortissement n’est pas « Aucun »",
  },
  {
    en: "Invalid asset ID",
    ar: "معرّف الأصل غير صالح",
    fr: "Identifiant d’immobilisation non valide",
  },
  {
    en: "Cannot delete: this asset has ${entryCount} voucher entry/entries. Remove related transactions first.",
    ar: "لا يمكن الحذف: لهذا الأصل {0} قيد سند. احذف المعاملات المرتبطة أولًا.",
    fr: "Suppression impossible : cette immobilisation possède {0} écriture(s) de pièce. Supprimez d’abord les transactions associées.",
  },
  {
    en: "Fixed asset not found",
    ar: "لم يتم العثور على الأصل الثابت",
    fr: "Immobilisation introuvable",
  },
  {
    en: "Fixed asset deleted successfully",
    ar: "تم حذف الأصل الثابت بنجاح",
    fr: "Immobilisation supprimée avec succès",
  },
  {
    en: "Excel file is empty",
    ar: "ملف Excel فارغ",
    fr: "Le fichier Excel est vide",
  },
  {
    en: "This file has already been imported",
    ar: "تم استيراد هذا الملف من قبل",
    fr: "Ce fichier a déjà été importé",
  },
  {
    en: "Validation errors",
    ar: "أخطاء التحقق",
    fr: "Erreurs de validation",
  },
  {
    en: "No valid item rows found",
    ar: "لم يتم العثور على صفوف أصناف صالحة",
    fr: "Aucune ligne d’article valide trouvée",
  },
  {
    en: "${negStockRes.rows.length} item(s) with negative stock",
    ar: "عدد الأصناف ذات المخزون السالب: {0}",
    fr: "{0} article(s) avec un stock négatif",
  },
  {
    en: '${pendingCount} pending approval request${pendingCount !== 1 ? "s" : ""}',
    ar: "طلبات الموافقة المعلقة: {0}",
    fr: "{0} demande(s) d’approbation en attente",
  },
  {
    en: '${pendingCount} action${pendingCount !== 1 ? "s" : ""} are awaiting review by an Admin or Developer.',
    ar: "هناك {0} إجراء بانتظار مراجعة مسؤول أو مطور.",
    fr: "{0} action(s) attendent l’examen d’un Administrateur ou d’un Développeur.",
  },
  {
    en: "Large withdrawal: ${toMoney(row.amount).toNumber().toLocaleString()}",
    ar: "سحب كبير: {0}",
    fr: "Retrait important : {0}",
  },
  {
    en: 'Voucher ${row.voucher_number ?? row.id}: "${row.narration ?? "No narration"}" — ${toMoney(row.amount).toNumber().toLocaleString()} from ${row.account}',
    ar: "السند {0}: «{1}» — {2} من {3}",
    fr: "Pièce {0} : « {1} » — {2} depuis {3}",
  },
  {
    en: "${total} row error(s) in recent imports",
    ar: "عدد أخطاء الصفوف في عمليات الاستيراد الأخيرة: {0}",
    fr: "{0} erreur(s) de ligne dans les importations récentes",
  },
  {
    en: "Alert checks completed",
    ar: "اكتملت فحوصات التنبيه",
    fr: "Vérifications d’alerte terminées",
  },
  {
    en: "Too many messages. Please wait a moment before sending again.",
    ar: "عدد الرسائل كبير جدًا. يرجى الانتظار قليلًا قبل الإرسال مرة أخرى.",
    fr: "Trop de messages. Veuillez patienter un moment avant d’envoyer à nouveau.",
  },
  {
    en: 'Chatbot ${enabled ? "enabled" : "disabled"} for user',
    ar: "روبوت المحادثة {0} للمستخدم",
    fr: "Chatbot {0} pour l’utilisateur",
  },
  {
    en: "Message and sessionId are required",
    ar: "الرسالة ومعرّف الجلسة sessionId مطلوبان",
    fr: "Le message et sessionId sont requis",
  },
  {
    en: "Chat error:",
    ar: "خطأ في المحادثة:",
    fr: "Erreur de conversation :",
  },
  {
    en: "Not authenticated",
    ar: "لم تتم المصادقة",
    fr: "Non authentifié",
  },
  {
    en: "History error:",
    ar: "خطأ في السجل:",
    fr: "Erreur d’historique :",
  },
  {
    en: "Session not found",
    ar: "لم يتم العثور على الجلسة",
    fr: "Session introuvable",
  },
  {
    en: "Cannot delete a Developer's conversation",
    ar: "لا يمكن حذف محادثة مطور",
    fr: "Impossible de supprimer la conversation d’un Développeur",
  },
  {
    en: "filePath and newContent are required",
    ar: "مسار الملف filePath والمحتوى الجديد newContent مطلوبان",
    fr: "filePath et newContent sont requis",
  },
  {
    en: "Cannot overwrite an existing file without a stale-check reference. Please re-ask the AI to regenerate the patch.",
    ar: "لا يمكن استبدال ملف موجود دون مرجع للتحقق من التقادم. اطلب من الذكاء الاصطناعي إعادة إنشاء التصحيح.",
    fr: "Impossible d’écraser un fichier existant sans référence de contrôle d’obsolescence. Demandez à l’IA de régénérer le correctif.",
  },
  {
    en: "The file has changed since the diff was generated. Please re-ask the AI to regenerate the patch.",
    ar: "تغيّر الملف منذ إنشاء الفرق. اطلب من الذكاء الاصطناعي إعادة إنشاء التصحيح.",
    fr: "Le fichier a changé depuis la génération du diff. Demandez à l’IA de régénérer le correctif.",
  },
  {
    en: "Invalid patch id",
    ar: "معرّف التصحيح غير صالح",
    fr: "Identifiant de correctif non valide",
  },
  {
    en: "Patch not found",
    ar: "لم يتم العثور على التصحيح",
    fr: "Correctif introuvable",
  },
  {
    en: "Patch has already been reverted",
    ar: "تم التراجع عن التصحيح بالفعل",
    fr: "Le correctif a déjà été annulé",
  },
  {
    en: "files array is required",
    ar: "مصفوفة الملفات files مطلوبة",
    fr: "Le tableau files est requis",
  },
  {
    en: "Commit message is required",
    ar: "رسالة الالتزام مطلوبة",
    fr: "Le message de commit est requis",
  },
  {
    en: "GitHub repository URL is not configured. Please set it in Chatbot Settings → GitHub Integration.",
    ar: "رابط مستودع GitHub غير مهيأ. يرجى تعيينه في إعدادات روبوت المحادثة ← تكامل GitHub.",
    fr: "L’URL du dépôt GitHub n’est pas configurée. Définissez-la dans Paramètres du chatbot → Intégration GitHub.",
  },
  {
    en: "Only admins can change AI provider",
    ar: "يمكن للمسؤولين فقط تغيير مزود الذكاء الاصطناعي",
    fr: "Seuls les administrateurs peuvent changer de fournisseur d’IA",
  },
  {
    en: "Invalid provider. Must be gemini, chatgpt, or grok",
    ar: "المزود غير صالح. يجب أن يكون gemini أو chatgpt أو grok",
    fr: "Fournisseur non valide. Il doit être gemini, chatgpt ou grok",
  },
  {
    en: "Source and destination locations are required",
    ar: "موقعا المصدر والوجهة مطلوبان",
    fr: "Les emplacements source et destination sont requis",
  },
  {
    en: "At least one item is required",
    ar: "يلزم عنصر واحد على الأقل",
    fr: "Au moins un article est requis",
  },
  {
    en: "Source and destination must be different",
    ar: "يجب أن يختلف المصدر عن الوجهة",
    fr: "La source et la destination doivent être différentes",
  },
  {
    en: "Source location not found",
    ar: "لم يتم العثور على موقع المصدر",
    fr: "Emplacement source introuvable",
  },
  {
    en: "Destination location not found",
    ar: "لم يتم العثور على موقع الوجهة",
    fr: "Emplacement de destination introuvable",
  },
  {
    en: "Invalid item or quantity: ${JSON.stringify(i)}",
    ar: "صنف أو كمية غير صالحة: {0}",
    fr: "Article ou quantité non valide : {0}",
  },
  {
    en: "Stock item ${stockItemId} not found",
    ar: "لم يتم العثور على عنصر المخزون {0}",
    fr: "Article de stock {0} introuvable",
  },
  {
    en: "Quantity ${qty} for stock item ${stockItemId} exceeds available stock (${currentStock})",
    ar: "الكمية {0} لعنصر المخزون {1} تتجاوز المخزون المتاح ({2})",
    fr: "La quantité {0} de l’article de stock {1} dépasse le stock disponible ({2})",
  },
  {
    en: "Could not read PDF: ${getErrorMessage(pdfErr)}",
    ar: "تعذرت قراءة ملف PDF: {0}",
    fr: "Impossible de lire le PDF : {0}",
  },
  {
    en: "PDF appears to be empty or is image-only (no extractable text)",
    ar: "يبدو ملف PDF فارغًا أو يحتوي على صور فقط، ولا يوجد نص قابل للاستخراج",
    fr: "Le PDF semble vide ou composé uniquement d’images, sans texte extractible",
  },
  {
    en: "AI could not find any purchase order items in this PDF. Make sure the PDF contains readable text.",
    ar: "لم يتمكن الذكاء الاصطناعي من العثور على أصناف أمر شراء في ملف PDF. تأكد من أن الملف يحتوي على نص مقروء.",
    fr: "L’IA n’a trouvé aucun article de bon de commande dans ce PDF. Vérifiez que le PDF contient du texte lisible.",
  },
  {
    en: "CSV file has no data rows",
    ar: "ملف CSV لا يحتوي على صفوف بيانات",
    fr: "Le fichier CSV ne contient aucune ligne de données",
  },
  {
    en: "Could not read file: ${getErrorMessage(xlErr)}",
    ar: "تعذرت قراءة الملف: {0}",
    fr: "Impossible de lire le fichier : {0}",
  },
  {
    en: "File has no data rows",
    ar: "الملف لا يحتوي على صفوف بيانات",
    fr: "Le fichier ne contient aucune ligne de données",
  },
  {
    en: "Could not find item rows in the file. Expected columns like Item_Name / Quantity / Rate, or the file may be in an unusual layout.",
    ar: "تعذر العثور على صفوف أصناف في الملف. كان متوقعًا أعمدة مثل Item_Name أو Quantity أو Rate، أو قد يكون تنسيق الملف غير معتاد.",
    fr: "Impossible de trouver des lignes d’articles dans le fichier. Des colonnes telles que Item_Name, Quantity ou Rate étaient attendues, ou le fichier utilise peut-être une disposition inhabituelle.",
  },
];
