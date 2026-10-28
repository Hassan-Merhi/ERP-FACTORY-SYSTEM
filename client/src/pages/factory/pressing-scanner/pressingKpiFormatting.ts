/** Pressing KPI: display confirmed KG / 40 as a whole-number bale equivalent.
 * Round to the nearest unit (not nearest ten); exact halves round up.
 * For example, 3,770 KG -> 94 and 8,500 KG -> 213.
 * The original KG totals remain unchanged.
 */
export function approx40KgText(kg: number): string {
  return Math.round(kg / 40).toLocaleString("en-US", { maximumFractionDigits: 0 });
}
