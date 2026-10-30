/** User-facing bonus workflow messages; kept in the translation source directory. */
const messages={
  daybookForbidden:{
    en:"Only Admin/Developer, or Owner for a bonus payment, can delete entries",
    ar:"يمكن للمسؤول أو المطور حذف القيود، ويمكن للمالك حذف دفع المكافآت",
    fr:"Seul un administrateur/développeur peut supprimer une ligne, ou le propriétaire pour une prime",
  },
  daybookReversed:{
    en:"Bonus payment reversed and removed from Daybook. Accounting audit retained.",
    ar:"تم عكس المكافأة وإخفاؤها من دفتر اليومية مع الاحتفاظ بسجل التدقيق.",
    fr:"Prime annulée et retirée du journal. La piste d’audit est conservée.",
  },
  categoryRequired:{
    en:"Assign this category in Production Targets before setting a rate",
    ar:"حدّد هذه الفئة في أهداف الإنتاج قبل إدخال السعر",
    fr:"Attribuez d’abord cette catégorie dans les objectifs de production.",
  },
  checkoutCompany:{en:"Factory company required",ar:"يجب تحديد شركة المصنع",fr:"Sélectionnez une société d’usine"},
  checkoutMethod:{en:"Select a production date and bonus method",ar:"اختر تاريخ الإنتاج وطريقة المكافأة",fr:"Choisissez la date de production et le mode de prime"},
  checkoutFailed:{en:"Unable to calculate production bonus",ar:"تعذّر حساب المكافأة",fr:"Impossible de calculer la prime"},
  paymentFailed:{en:"Unable to post bonus; no partial payment was saved",ar:"تعذّر دفع المكافأة، ولم يتم حفظ أي دفع جزئي",fr:"Impossible de payer la prime ; aucun paiement partiel enregistré"},
} as const;
export type BonusServerMessageKey=keyof typeof messages;
export function bonusServerText(language:string|undefined,key:BonusServerMessageKey):string{
  const lang=language?.toLowerCase().startsWith("ar")?"ar":
    language?.toLowerCase().startsWith("fr")?"fr":"en";
  return messages[key][lang];
}
