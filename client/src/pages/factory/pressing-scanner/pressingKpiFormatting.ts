/** Pressing KPI: actual confirmed kilograms expressed as equivalent 40 KG bales.
 * Confirmed weights use 3 decimals; dividing by 40 can require 5 decimals.
 * Never round to tens or an integer, or 3,770 KG incorrectly displays as 90.
 */
export function approx40KgText(kg: number): string {
  return (kg / 40).toLocaleString("en-US", {
    maximumFractionDigits: 5,
  });
}
