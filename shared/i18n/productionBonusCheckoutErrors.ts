/** Shared pure-validation error copy lives in the i18n source catalog. */
export const productionBonusCheckoutErrors = {
  missingLink: "Worker is not a member of linked production",
  missingCategory: "Produced bale is missing its category",
  invalidQuantities: "Invalid category bonus quantities",
  excessExceedsProduced: "Extra bales exceed worker production",
} as const;
