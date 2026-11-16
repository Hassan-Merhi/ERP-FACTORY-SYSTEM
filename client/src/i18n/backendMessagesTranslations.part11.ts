import type { Phase7BackendMessagesEntry } from "./backendMessagesTranslationTypes";

/** Bandwidth Phases 1–5 messages reviewed during the final integrated verification pass. */
export const backendMessagesPhase7TranslationsPart11: readonly Phase7BackendMessagesEntry[] = [
  {
    en: "Failed to load location summary (${response.status})",
    ar: "فشل تحميل ملخص المواقع ({0})",
    fr: "Échec du chargement du récapitulatif des emplacements ({0})",
  },
  {
    en: "groupId is required for profile=group",
    ar: "groupId مطلوب عندما يكون profile=group",
    fr: "groupId est requis lorsque profile=group",
  },
  {
    en: "Stock group not found",
    ar: "لم يتم العثور على مجموعة المخزون",
    fr: "Groupe de stock introuvable",
  },
  {
    en: "Barcode code is required",
    ar: "رمز الباركود مطلوب",
    fr: "Le code-barres est requis",
  },
  {
    en: "Barcode code is too long",
    ar: "رمز الباركود طويل جدًا",
    fr: "Le code-barres est trop long",
  },
  {
    en: "format must be svg or png",
    ar: "يجب أن يكون التنسيق svg أو png",
    fr: "Le format doit être svg ou png",
  },
  {
    en: "Invalid section",
    ar: "قسم غير صالح",
    fr: "Section invalide",
  },
  {
    en: "Invalid productId",
    ar: "معرّف المنتج غير صالح",
    fr: "productId invalide",
  },
  {
    en: "No location found for this user",
    ar: "لم يتم العثور على موقع لهذا المستخدم",
    fr: "Aucun emplacement trouvé pour cet utilisateur",
  },
  {
    en: "Location not found",
    ar: "لم يتم العثور على الموقع",
    fr: "Emplacement introuvable",
  },
  {
    en: "No WhatsApp group configured for this location",
    ar: "لم يتم إعداد مجموعة واتساب لهذا الموقع",
    fr: "Aucun groupe WhatsApp configuré pour cet emplacement",
  },
  {
    en: "PDF pagination error detected: ${pageCount} pages generated for ${rowCount} stock items (expected ≤${maxAllowedPages}). Report not sent to WhatsApp.",
    ar: "تم اكتشاف خطأ في تقسيم صفحات PDF: تم إنشاء {0} صفحة لـ {1} عنصر مخزون (المتوقع ≤{2}). لم يتم إرسال التقرير إلى واتساب.",
    fr: "Erreur de pagination PDF détectée : {0} pages générées pour {1} articles en stock (≤{2} attendu). Le rapport n’a pas été envoyé sur WhatsApp.",
  },
  {
    en: "voucherId is required",
    ar: "voucherId مطلوب",
    fr: "voucherId est requis",
  },
  {
    en: "Invalid voucherId",
    ar: "voucherId غير صالح",
    fr: "voucherId invalide",
  },
  {
    en: "Voucher has no location",
    ar: "القسيمة ليس لها موقع",
    fr: "Le bon n’a aucun emplacement",
  },
  {
    en: "PDF generation failed: invalid or empty PDF",
    ar: "فشل إنشاء PDF: الملف غير صالح أو فارغ",
    fr: "Échec de génération du PDF : PDF invalide ou vide",
  },
  {
    en: "PDF page count (${pageCount}) is excessive for ${itemCount} items — aborting WhatsApp send",
    ar: "عدد صفحات PDF ({0}) كبير جدًا بالنسبة إلى {1} عنصر — تم إيقاف الإرسال عبر واتساب",
    fr: "Le nombre de pages PDF ({0}) est excessif pour {1} articles — envoi WhatsApp annulé",
  },
  {
    en: "pdfBase64 is required",
    ar: "pdfBase64 مطلوب",
    fr: "pdfBase64 est requis",
  },
  {
    en: "locationId is required",
    ar: "locationId مطلوب",
    fr: "locationId est requis",
  },
  {
    en: "No WhatsApp target configured for this account",
    ar: "لم يتم إعداد وجهة واتساب لهذا الحساب",
    fr: "Aucune destination WhatsApp configurée pour ce compte",
  },
  {
    en: "Green API blocked this WhatsApp group because the configured Developer plan has reached its monthly chat limit. The ERP also tried its fallback delivery path. Configure/upgrade an instance that is allowed to message this group.",
    ar: "حظرت Green API مجموعة واتساب هذه لأن خطة المطور المهيأة وصلت إلى حد المحادثات الشهري. حاول نظام ERP أيضًا مسار الإرسال الاحتياطي. قم بتهيئة أو ترقية مثيل مسموح له بمراسلة هذه المجموعة.",
    fr: "Green API a bloqué ce groupe WhatsApp car le forfait Developer configuré a atteint sa limite mensuelle de conversations. L’ERP a également essayé le mode d’envoi de secours. Configurez ou mettez à niveau une instance autorisée à envoyer des messages à ce groupe.",
  },
  {
    en: "Green API monthly quota has been reached. The ERP also tried its fallback delivery path, but the provider still blocked the send.",
    ar: "تم بلوغ الحصة الشهرية لـ Green API. حاول نظام ERP أيضًا مسار الإرسال الاحتياطي، لكن المزود ما زال يمنع الإرسال.",
    fr: "Le quota mensuel de Green API a été atteint. L’ERP a également essayé le mode d’envoi de secours, mais le fournisseur bloque toujours l’envoi.",
  },
  {
    en: "Invalid companyId in request path.",
    ar: "معرّف الشركة غير صالح في مسار الطلب.",
    fr: "Identifiant de société invalide dans le chemin de la requête.",
  },
  {
    en: 'Container "${containerNumber}" already has ${existingPOs.length} PO(s) imported (${existingPOs.map((p) => p.poNumber).join(", ")}). To avoid duplicates, please delete the existing POs first or use a different container number.',
    ar: "تحتوي الحاوية «{0}» بالفعل على {1} أمر شراء مستورد ({2}). لتجنب التكرار، احذف أوامر الشراء الحالية أولاً أو استخدم رقم حاوية مختلفًا.",
    fr: "Le conteneur « {0} » contient déjà {1} bon(s) de commande importé(s) ({2}). Pour éviter les doublons, supprimez d’abord les bons existants ou utilisez un autre numéro de conteneur.",
  },
  {
    en: "startDate cannot be after endDate",
    ar: "لا يمكن أن يكون تاريخ البدء بعد تاريخ الانتهاء",
    fr: "La date de début ne peut pas être postérieure à la date de fin",
  },
  {
    en: "Statement PDF generation returned an invalid or empty PDF buffer",
    ar: "أعاد إنشاء كشف الحساب PDF ملف PDF غير صالح أو فارغ",
    fr: "La génération du relevé PDF a renvoyé un PDF invalide ou vide",
  },
  {
    en: "Stock transfer belongs to a different company",
    ar: "تحويل المخزون يخص شركة أخرى",
    fr: "Le transfert de stock appartient à une autre société",
  },
  {
    en: "Revision item or source location is outside the current company",
    ar: "صنف المراجعة أو موقع المصدر خارج نطاق الشركة الحالية",
    fr: "L’article de la révision ou l’emplacement source se trouve en dehors de la société actuelle",
  },
  {
    en: "Transfer changed while saving the revision. Reload the transfer and try again.",
    ar: "تغيّر التحويل أثناء حفظ المراجعة. أعد تحميل التحويل وحاول مرة أخرى.",
    fr: "Le transfert a changé pendant l’enregistrement de la révision. Rechargez le transfert et réessayez.",
  },
  {
    en: "Revision is stale for item ${result.stockItemId} at source ${result.sourceLocationId}. Expected ${result.expected} or saved value ${result.proposed}, current transfer quantity is ${result.current}.",
    ar: "المراجعة قديمة للصنف {0} في المصدر {1}. المتوقع {2} أو القيمة المحفوظة {3}، وكمية التحويل الحالية هي {4}.",
    fr: "La révision est obsolète pour l’article {0} à la source {1}. Attendu {2} ou valeur enregistrée {3}, la quantité de transfert actuelle est {4}.",
  },
  {
    en: "Failed to save stock transfer revision",
    ar: "فشل حفظ مراجعة تحويل المخزون",
    fr: "Échec de l’enregistrement de la révision du transfert de stock",
  },
  {
    en: "Failed to create stock transfer revision",
    ar: "فشل إنشاء مراجعة تحويل المخزون",
    fr: "Échec de la création de la révision du transfert de stock",
  },
  {
    en: "Password must be at least 6 characters",
    ar: "يجب ألا تقل كلمة المرور عن 6 أحرف",
    fr: "Le mot de passe doit comporter au moins 6 caractères",
  },
  {
    en: "User not found in this company",
    ar: "لم يتم العثور على المستخدم في هذه الشركة",
    fr: "Utilisateur introuvable dans cette société",
  },
  {
    en: "Cannot modify this account",
    ar: "لا يمكن تعديل هذا الحساب",
    fr: "Impossible de modifier ce compte",
  },
  {
    en: "Only Developer can change global user credentials",
    ar: "يمكن للمطور فقط تغيير بيانات اعتماد المستخدم العامة",
    fr: "Seul le Développeur peut modifier les identifiants globaux de l’utilisateur",
  },
  {
    en: "You cannot remove your own account",
    ar: "لا يمكنك إزالة حسابك الخاص",
    fr: "Vous ne pouvez pas supprimer votre propre compte",
  },
  {
    en: "Cannot remove this account",
    ar: "لا يمكن إزالة هذا الحساب",
    fr: "Impossible de supprimer ce compte",
  },
  {
    en: "User access removed from this company",
    ar: "تمت إزالة وصول المستخدم من هذه الشركة",
    fr: "L’accès de l’utilisateur a été supprimé de cette société",
  },
  {
    en: "Browser mutation request contained an invalid Origin or Referer.",
    ar: "احتوى طلب تعديل المتصفح على قيمة Origin أو Referer غير صالحة.",
    fr: "La requête de modification du navigateur contenait un en-tête Origin ou Referer non valide.",
  },
  {
    en: "Article code for grade ${grade} must start with ${targetPrefix}",
    ar: "يجب أن يبدأ رمز الصنف للدرجة {0} بالبادئة {1}",
    fr: "Le code article de la qualité {0} doit commencer par {1}",
  },
  {
    en: "Row ${rowNumber}: ${label} is not a valid number",
    ar: "الصف {0}: {1} ليس رقمًا صالحًا",
    fr: "Ligne {0} : {1} n’est pas un nombre valide",
  },
  {
    en: "Row ${rowNumber}: ${label} must be zero or greater",
    ar: "الصف {0}: يجب أن يكون {1} صفرًا أو أكبر",
    fr: "Ligne {0} : {1} doit être supérieur ou égal à zéro",
  },
  {
    en: "Row ${rowNumber}: ${label} is too large",
    ar: "الصف {0}: {1} كبير جدًا",
    fr: "Ligne {0} : {1} est trop grand",
  },
  {
    en: "Invalid supplier or proforma id",
    ar: "معرّف المورد أو الفاتورة المبدئية غير صالح",
    fr: "Identifiant de fournisseur ou de proforma non valide",
  },
  {
    en: "Import is limited to ${MAX_IMPORT_LINES.toLocaleString()} lines at a time",
    ar: "الاستيراد محدود بـ {0} سطر في المرة الواحدة",
    fr: "L’import est limité à {0} lignes à la fois",
  },
  {
    en: "Import stopped: ${reported}${suffix}",
    ar: "توقف الاستيراد: {0}{1}",
    fr: "Import interrompu : {0}{1}",
  },
  {
    en: "Import could not be saved. No rows were imported. Check the spreadsheet values and try again.",
    ar: "تعذر حفظ الاستيراد. لم يتم استيراد أي صفوف. تحقق من قيم الجدول وحاول مرة أخرى.",
    fr: "L’import n’a pas pu être enregistré. Aucune ligne n’a été importée. Vérifiez les valeurs du tableur et réessayez.",
  },
  {
    en: "The rows were imported but the proforma could not be reloaded. Refresh the page instead of importing again.",
    ar: "تم استيراد الصفوف لكن تعذر إعادة تحميل الفاتورة المبدئية. حدّث الصفحة بدلاً من الاستيراد مرة أخرى.",
    fr: "Les lignes ont été importées mais le proforma n’a pas pu être rechargé. Actualisez la page au lieu de relancer l’import.",
  },
];
