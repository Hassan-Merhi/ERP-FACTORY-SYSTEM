/**
 * Whether a string is a number as a numeric column reads it (so "5kg", which
 * Postgres would reject, fails validation instead of the insert) and passes
 * `test`. Only the sign is checked, so no money arithmetic happens here.
 */
export const numericStringWhere = (test: (value: number) => boolean) => (val: string) =>
  val.trim() !== "" && Number.isFinite(Number(val)) && test(Number(val));
export const isPositiveNumeric = numericStringWhere((value) => value > 0);
export const isNonNegativeNumeric = numericStringWhere((value) => value >= 0);
