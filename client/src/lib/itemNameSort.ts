/** Compare displayed purchase item names A–Z without depending on item insertion order. */
const itemNameCollator = new Intl.Collator("en", { sensitivity: "base", numeric: true });

export function compareItemNamesAZ(
  a: string | null | undefined,
  b: string | null | undefined
): number {
  return itemNameCollator.compare((a ?? "").trim(), (b ?? "").trim());
}
