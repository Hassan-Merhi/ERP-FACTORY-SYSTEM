/** Display-only Factory MHD names and stable Excel-defined product ordering. */
export type FactoryMhdDisplayMode = "standard" | "mhd";
export type FactoryMhdEntry = { articleCode: string; itemName: string; sortOrder: number };

export const normalizeFactoryMhdCode = (code: string | null | undefined): string =>
  String(code ?? "")
    .trim()
    .toUpperCase();

export function factoryMhdLookup(rows: readonly FactoryMhdEntry[]): ReadonlyMap<string, FactoryMhdEntry> {
  const lookup = new Map<string, FactoryMhdEntry>();
  for (const row of rows) lookup.set(normalizeFactoryMhdCode(row.articleCode), row);
  return lookup;
}

export function factoryMhdName(
  mode: FactoryMhdDisplayMode,
  lookup: ReadonlyMap<string, FactoryMhdEntry>,
  articleCode: string | null | undefined,
  originalName: string
): string {
  if (mode !== "mhd") return originalName;
  return lookup.get(normalizeFactoryMhdCode(articleCode))?.itemName.trim() || originalName;
}

export function sortFactoryMhdRows<T>(
  mode: FactoryMhdDisplayMode,
  lookup: ReadonlyMap<string, FactoryMhdEntry>,
  rows: readonly T[],
  getArticleCode: (row: T) => string | null | undefined
): T[] {
  if (mode !== "mhd" || !lookup.size) return [...rows];
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => {
      const aOrder = lookup.get(normalizeFactoryMhdCode(getArticleCode(a.row)))?.sortOrder ?? Number.MAX_SAFE_INTEGER;
      const bOrder = lookup.get(normalizeFactoryMhdCode(getArticleCode(b.row)))?.sortOrder ?? Number.MAX_SAFE_INTEGER;
      return aOrder - bOrder || a.index - b.index;
    })
    .map(({ row }) => row);
}
