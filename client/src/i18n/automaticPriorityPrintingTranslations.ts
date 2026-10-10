import type { ApplicationLanguage } from "@shared/applicationLanguageContract";

type Translation = Record<ApplicationLanguage, string>;

/** Automatic Priority Printing & Loading: Factory UI and API messages. */
const translations: Record<string, Translation> = {
  "Automatic Priority Printing": {
    en: "Automatic Priority Printing",
    ar: "الطباعة التلقائية حسب الأولوية",
    fr: "Impression automatique par priorité",
  },
  "Unrecognized Priority Scan label color for ${label.referenceNumber}. Printing cancelled.": {
    en: "Unrecognized Priority Scan label color for ${label.referenceNumber}. Printing cancelled.",
    ar: "لون ملصق المسح حسب الأولوية غير معروف للمرجع ${label.referenceNumber}. تم إلغاء الطباعة.",
    fr: "Couleur d’étiquette de priorité non reconnue pour ${label.referenceNumber}. Impression annulée.",
  },
  "Could not prepare priority labels": {
    en: "Could not prepare priority labels",
    ar: "تعذر تجهيز ملصقات الأولوية",
    fr: "Impossible de préparer les étiquettes de priorité",
  },
  "Incomplete priority print response": {
    en: "Incomplete priority print response",
    ar: "استجابة طباعة الأولوية غير مكتملة",
    fr: "Réponse d’impression de priorité incomplète",
  },
  "Invalid priority print response": {
    en: "Invalid priority print response",
    ar: "استجابة طباعة الأولوية غير صالحة",
    fr: "Réponse d’impression de priorité invalide",
  },
  "Priority preparation missing bale ${label.referenceNumber}": {
    en: "Priority preparation missing bale ${label.referenceNumber}",
    ar: "البالة ${label.referenceNumber} مفقودة من تجهيز الأولوية",
    fr: "Balle ${label.referenceNumber} absente de la préparation de priorité",
  },
  "Bale ${label.referenceNumber} is no longer allocated. Refresh before printing.": {
    en: "Bale ${label.referenceNumber} is no longer allocated. Refresh before printing.",
    ar: "البالة ${label.referenceNumber} لم تعد مخصصة. حدّث الصفحة قبل الطباعة.",
    fr: "La balle ${label.referenceNumber} n’est plus affectée. Actualisez avant d’imprimer.",
  },
  "Invalid priority assignment for ${label.referenceNumber}": {
    en: "Invalid priority assignment for ${label.referenceNumber}",
    ar: "تخصيص أولوية غير صالح للمرجع ${label.referenceNumber}",
    fr: "Affectation de priorité invalide pour ${label.referenceNumber}",
  },
  "Loading changed for ${label.referenceNumber}. Refresh before printing.": {
    en: "Loading changed for ${label.referenceNumber}. Refresh before printing.",
    ar: "تغيّرت الحمولة للمرجع ${label.referenceNumber}. حدّث الصفحة قبل الطباعة.",
    fr: "Le chargement a changé pour ${label.referenceNumber}. Actualisez avant d’imprimer.",
  },
  "Priority color changed for ${label.referenceNumber}. Refresh before printing.": {
    en: "Priority color changed for ${label.referenceNumber}. Refresh before printing.",
    ar: "تغيّر لون الأولوية للمرجع ${label.referenceNumber}. حدّث الصفحة قبل الطباعة.",
    fr: "La couleur de priorité a changé pour ${label.referenceNumber}. Actualisez avant d’imprimer.",
  },
  "Incomplete priority reprint audit for ${label.referenceNumber}.": {
    en: "Incomplete priority reprint audit for ${label.referenceNumber}.",
    ar: "سجل تدقيق إعادة طباعة الأولوية غير مكتمل للمرجع ${label.referenceNumber}.",
    fr: "Audit de réimpression de priorité incomplet pour ${label.referenceNumber}.",
  },
  "Select one of the eleven approved Priority Scan colors.": {
    en: "Select one of the eleven approved Priority Scan colors.",
    ar: "اختر أحد ألوان المسح حسب الأولوية الأحد عشر المعتمدة.",
    fr: "Sélectionnez l’une des onze couleurs approuvées pour le scan prioritaire.",
  },
  "Could not record label reprint": {
    en: "Could not record label reprint",
    ar: "تعذر تسجيل إعادة طباعة الملصق",
    fr: "Impossible d’enregistrer la réimpression de l’étiquette",
  },
  "Priority printing failed": {
    en: "Priority printing failed",
    ar: "فشلت طباعة الأولوية",
    fr: "Échec de l’impression de priorité",
  },
  "Reprint preparation failed": {
    en: "Reprint preparation failed",
    ar: "فشل تجهيز إعادة الطباعة",
    fr: "Échec de la préparation de la réimpression",
  },
  "${data.removed} bales removed from stock": {
    en: "${data.removed} bales removed from stock",
    ar: "تمت إزالة ${data.removed} بالة من المخزون",
    fr: "${data.removed} balles retirées du stock",
  },
  "Removed ${data.removed} bale(s) from stock.": {
    en: "Removed ${data.removed} bale(s) from stock.",
    ar: "تمت إزالة ${data.removed} بالة من المخزون.",
    fr: "${data.removed} balle(s) retirée(s) du stock.",
  },
  "Priority labels need a color printer": {
    en: "Priority labels need a color printer",
    ar: "ملصقات الأولوية تحتاج إلى طابعة ملونة",
    fr: "Les étiquettes de priorité nécessitent une imprimante couleur",
  },
  "Bales assigned to a priority loading print through the browser so the priority color box is kept.": {
    en: "Bales assigned to a priority loading print through the browser so the priority color box is kept.",
    ar: "تُطبع البالات المخصصة لحمولة ذات أولوية عبر المتصفح للحفاظ على مربع لون الأولوية.",
    fr: "Les balles affectées à un chargement prioritaire s’impriment via le navigateur afin de conserver le bloc de couleur de priorité.",
  },
  "Could not prepare bale label print": {
    en: "Could not prepare bale label print",
    ar: "تعذر تجهيز طباعة ملصق البالة",
    fr: "Impossible de préparer l’impression de l’étiquette de balle",
  },
  "Could not prepare reprint": {
    en: "Could not prepare reprint",
    ar: "تعذر تجهيز إعادة الطباعة",
    fr: "Impossible de préparer la réimpression",
  },
  "Automatic Priority Printing and Loading": {
    en: "Automatic Priority Printing and Loading",
    ar: "الطباعة والتحميل التلقائي حسب الأولوية",
    fr: "Impression et chargement automatiques par priorité",
  },
  "Unable to read the current setting. No changes are allowed until it loads.": {
    en: "Unable to read the current setting. No changes are allowed until it loads.",
    ar: "تعذرت قراءة الإعداد الحالي. لا يُسمح بأي تغيير حتى يتم تحميله.",
    fr: "Impossible de lire le paramètre actuel. Aucune modification n’est autorisée tant qu’il n’est pas chargé.",
  },
  "Loading company setting…": {
    en: "Loading company setting…",
    ar: "جارٍ تحميل إعداد الشركة…",
    fr: "Chargement du paramètre de la société…",
  },
  "Automatic loading on printing": {
    en: "Automatic loading on printing",
    ar: "التحميل التلقائي عند الطباعة",
    fr: "Chargement automatique à l’impression",
  },
  "Only Admin or Developer users can change this company-wide setting.": {
    en: "Only Admin or Developer users can change this company-wide setting.",
    ar: "يمكن فقط لمستخدمي المسؤول أو المطوّر تغيير هذا الإعداد على مستوى الشركة.",
    fr: "Seuls les utilisateurs Administrateur ou Développeur peuvent modifier ce paramètre de la société.",
  },
  "Setting update failed": {
    en: "Setting update failed",
    ar: "فشل تحديث الإعداد",
    fr: "Échec de la mise à jour du paramètre",
  },
  "Could not change automatic printing": {
    en: "Could not change automatic printing",
    ar: "تعذر تغيير الطباعة التلقائية",
    fr: "Impossible de modifier l’impression automatique",
  },
  "Could not load Automatic Priority Printing setting": {
    en: "Could not load Automatic Priority Printing setting",
    ar: "تعذر تحميل إعداد الطباعة التلقائية حسب الأولوية",
    fr: "Impossible de charger le paramètre d’impression automatique par priorité",
  },
  "Priority print preparation failed": {
    en: "Priority print preparation failed",
    ar: "فشل تجهيز طباعة الأولوية",
    fr: "Échec de la préparation de l’impression de priorité",
  },
  "Bale is not deleted": { en: "Bale is not deleted", ar: "البالة غير محذوفة", fr: "La balle n’est pas supprimée" },
  "This bale has a recorded physical deletion. Use a controlled stock re-entry; restoring its status alone would create phantom inventory or undo the deletion audit.":
    {
      en: "This bale has a recorded physical deletion. Use a controlled stock re-entry; restoring its status alone would create phantom inventory or undo the deletion audit.",
      ar: "لهذه البالة حذف فعلي مسجّل. استخدم إعادة إدخال مخزون مضبوطة؛ فاستعادة حالتها وحدها ستنشئ مخزونًا وهميًا أو تلغي سجل الحذف.",
      fr: "Cette balle a une suppression physique enregistrée. Utilisez une réintégration de stock contrôlée ; restaurer seulement son statut créerait un stock fantôme ou annulerait l’audit de suppression.",
    },
  "Valid baleId required": {
    en: "Valid baleId required",
    ar: "مطلوب معرّف بالة صالح",
    fr: "Identifiant de balle valide requis",
  },
  "Physical bale not found or deleted": {
    en: "Physical bale not found or deleted",
    ar: "البالة الفعلية غير موجودة أو محذوفة",
    fr: "Balle physique introuvable ou supprimée",
  },
  "Expected exactly one boolean field: enabled": {
    en: "Expected exactly one boolean field: enabled",
    ar: "يُتوقع حقل منطقي واحد فقط: enabled",
    fr: "Un seul champ booléen attendu : enabled",
  },
  "Use the protected Automatic Priority Mode endpoint.": {
    en: "Use the protected Automatic Priority Mode endpoint.",
    ar: "استخدم نقطة النهاية المحمية لوضع الأولوية التلقائي.",
    fr: "Utilisez le point d’accès protégé du mode de priorité automatique.",
  },
  "Provide 1–200 unique physical bale IDs": {
    en: "Provide 1–200 unique physical bale IDs",
    ar: "أدخل من 1 إلى 200 معرّف بالة فعلية فريد",
    fr: "Fournissez de 1 à 200 identifiants de balles physiques uniques",
  },
  "Use Physical Bale Removal to remove stock.": {
    en: "Use Physical Bale Removal to remove stock.",
    ar: "استخدم إزالة البالات الفعلية لإزالة المخزون.",
    fr: "Utilisez le retrait physique des balles pour retirer du stock.",
  },
  "A physically deleted bale cannot be reactivated by a status change.": {
    en: "A physically deleted bale cannot be reactivated by a status change.",
    ar: "لا يمكن إعادة تفعيل بالة محذوفة فعليًا بتغيير الحالة.",
    fr: "Une balle supprimée physiquement ne peut pas être réactivée par un changement de statut.",
  },
  "Cannot reset verified/finalized loading bales to stock without controlled return": {
    en: "Cannot reset verified/finalized loading bales to stock without controlled return",
    ar: "لا يمكن إعادة بالات حمولة مدققة/منتهية إلى المخزون دون إرجاع مضبوط",
    fr: "Impossible de remettre en stock des balles d’un chargement vérifié/finalisé sans retour contrôlé",
  },
  "Invalid history filter or limit": {
    en: "Invalid history filter or limit",
    ar: "عامل تصفية السجل أو الحد غير صالح",
    fr: "Filtre ou limite d’historique invalide",
  },
  "Specify baleId, orderId, or referenceNumber": {
    en: "Specify baleId, orderId, or referenceNumber",
    ar: "حدد baleId أو orderId أو referenceNumber",
    fr: "Indiquez baleId, orderId ou referenceNumber",
  },
  "Failed to load Priority Scan allocation history": {
    en: "Failed to load Priority Scan allocation history",
    ar: "فشل تحميل سجل تخصيصات المسح حسب الأولوية",
    fr: "Échec du chargement de l’historique des affectations de priorité",
  },
  "Failed to save Priority Scan allocation history": {
    en: "Failed to save Priority Scan allocation history",
    ar: "فشل حفظ سجل تخصيصات المسح حسب الأولوية",
    fr: "Échec de l’enregistrement de l’historique des affectations de priorité",
  },
  "Cannot delete a bale in a verified/finalized loading. Reverse the order financially first.": {
    en: "Cannot delete a bale in a verified/finalized loading. Reverse the order financially first.",
    ar: "لا يمكن حذف بالة في حمولة مدققة/منتهية. اعكس الطلب ماليًا أولًا.",
    fr: "Impossible de supprimer une balle d’un chargement vérifié/finalisé. Annulez d’abord la commande financièrement.",
  },
  "Cannot delete a bale while its loading is verified, finalized or changing status.": {
    en: "Cannot delete a bale while its loading is verified, finalized or changing status.",
    ar: "لا يمكن حذف بالة بينما حمولتها مدققة أو منتهية أو تتغير حالتها.",
    fr: "Impossible de supprimer une balle pendant que son chargement est vérifié, finalisé ou en changement de statut.",
  },
  "Print batch must contain 1 to 5000 physical bales": {
    en: "Print batch must contain 1 to 5000 physical bales",
    ar: "يجب أن تحتوي دفعة الطباعة على 1 إلى 5000 بالة فعلية",
    fr: "Le lot d’impression doit contenir de 1 à 5000 balles physiques",
  },
  "Invalid print batch item": {
    en: "Invalid print batch item",
    ar: "عنصر دفعة طباعة غير صالح",
    fr: "Élément de lot d’impression invalide",
  },
  "Invalid bale reference": {
    en: "Invalid bale reference",
    ar: "مرجع بالة غير صالح",
    fr: "Référence de balle invalide",
  },
  "Each print requires a physical bale ID or exact reference": {
    en: "Each print requires a physical bale ID or exact reference",
    ar: "تتطلب كل طباعة معرّف بالة فعلية أو مرجعًا مطابقًا",
    fr: "Chaque impression nécessite un identifiant de balle physique ou une référence exacte",
  },
  "Invalid physical bale ID": {
    en: "Invalid physical bale ID",
    ar: "معرّف بالة فعلية غير صالح",
    fr: "Identifiant de balle physique invalide",
  },
  "Bale not found or already deleted in this company": {
    en: "Bale not found or already deleted in this company",
    ar: "البالة غير موجودة أو محذوفة بالفعل في هذه الشركة",
    fr: "Balle introuvable ou déjà supprimée dans cette société",
  },
  "Print reference does not match bale ID": {
    en: "Print reference does not match bale ID",
    ar: "مرجع الطباعة لا يطابق معرّف البالة",
    fr: "La référence d’impression ne correspond pas à l’identifiant de la balle",
  },
  "Provide 1–200 valid bale IDs or reference numbers": {
    en: "Provide 1–200 valid bale IDs or reference numbers",
    ar: "أدخل من 1 إلى 200 معرّف بالة أو رقم مرجع صالح",
    fr: "Fournissez de 1 à 200 identifiants de balles ou numéros de référence valides",
  },
  "Failed to prepare priority labels": {
    en: "Failed to prepare priority labels",
    ar: "فشل تجهيز ملصقات الأولوية",
    fr: "Échec de la préparation des étiquettes de priorité",
  },
  "No unique Priority Scan colors remain": {
    en: "No unique Priority Scan colors remain",
    ar: "لم تتبقَّ ألوان فريدة للمسح حسب الأولوية",
    fr: "Il ne reste aucune couleur de priorité unique",
  },
  "Bale ${loadedRow.referenceNumber} is on a customer loading. Remove it from the loading first.": {
    en: "Bale ${loadedRow.referenceNumber} is on a customer loading. Remove it from the loading first.",
    ar: "البالة ${loadedRow.referenceNumber} ضمن حمولة عميل. أزلها من الحمولة أولًا.",
    fr: "La balle ${loadedRow.referenceNumber} est sur un chargement client. Retirez-la d’abord du chargement.",
  },
  "Removed ${removed.length} bale(s) from factory stock. Supervisor: ${actorName}. Reason: ${reason}": {
    en: "Removed ${removed.length} bale(s) from factory stock. Supervisor: ${actorName}. Reason: ${reason}",
    ar: "تمت إزالة ${removed.length} بالة من مخزون المصنع. المشرف: ${actorName}. السبب: ${reason}",
    fr: "${removed.length} balle(s) retirée(s) du stock de l’usine. Superviseur : ${actorName}. Motif : ${reason}",
  },
  "Only ${selected.length} of ${qty} requested bales are available (unloaded) in stock at this location. Nothing was removed.":
    {
      en: "Only ${selected.length} of ${qty} requested bales are available (unloaded) in stock at this location. Nothing was removed.",
      ar: "تتوفر فقط ${selected.length} من ${qty} بالة مطلوبة (غير محمّلة) في المخزون في هذا الموقع. لم تتم إزالة أي شيء.",
      fr: "Seules ${selected.length} des ${qty} balles demandées sont disponibles (non chargées) en stock à cet emplacement. Rien n’a été retiré.",
    },
};

const PLACEHOLDER_PATTERN = /\$\{[^}]+\}/g;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

interface InterpolatedEntry {
  matcher: RegExp;
  translation: Translation;
}

const interpolatedEntries: InterpolatedEntry[] = Object.entries(translations)
  .filter(([source]) => source.includes("${"))
  .map(([source, translation]) => ({
    matcher: new RegExp(
      `^${source
        .split(PLACEHOLDER_PATTERN)
        .map((literal) => escapeRegExp(literal))
        .join("(.*?)")}$`,
      "s"
    ),
    translation,
  }));

function applyCaptures(template: string, captures: string[]): string {
  let index = 0;
  return template.replace(PLACEHOLDER_PATTERN, () => captures[index++] ?? "");
}

export function translateAutomaticPriorityPrintingText(value: string, language: ApplicationLanguage): string | null {
  const direct = translations[value]?.[language];
  if (direct) return direct;
  for (const entry of interpolatedEntries) {
    const match = entry.matcher.exec(value);
    if (match) return applyCaptures(entry.translation[language], match.slice(1));
  }
  return null;
}
