/**
 * Build a continuation plan from one loading's expected quantities, minus
 * only the physical bales scanned into that loading. Never subtract sibling
 * loadings that reuse the same master proforma.
 */
export interface RemainingLoadingSourceLine {
  articleCode: string | null;
  productName: string | null;
  expectedQty: number;
  proformaLineId: number | null;
}

export interface RemainingLoadingLine {
  articleCode: string;
  productName: string | null;
  expectedQty: number;
  proformaLineId: number | null;
}

export function buildRemainingLoadingPlan(
  source: readonly RemainingLoadingSourceLine[],
  loadedByArticle: ReadonlyMap<string, number>
): { lines: RemainingLoadingLine[]; remainingBales: number } {
  const normalize = (value: string | null | undefined) => (value || "").trim().toLowerCase();
  const grouped = new Map<string, RemainingLoadingLine>();

  for (const line of source) {
    const code = normalize(line.articleCode);
    if (!code) continue;
    const qty = Number(line.expectedQty);
    if (!Number.isSafeInteger(qty) || qty < 0) {
      throw new Error("Invalid expected quantity in loading plan");
    }
    const previous = grouped.get(code);
    if (previous) {
      previous.expectedQty += qty;
    } else {
      grouped.set(code, {
        articleCode: line.articleCode!.trim(),
        productName: line.productName,
        expectedQty: qty,
        proformaLineId: line.proformaLineId,
      });
    }
  }

  const lines: RemainingLoadingLine[] = [];
  let remainingBales = 0;
  for (const [code, line] of grouped) {
    const loaded = loadedByArticle.get(code) ?? 0;
    if (!Number.isSafeInteger(loaded) || loaded < 0) {
      throw new Error("Invalid loaded quantity in loading plan");
    }
    const remaining = Math.max(0, line.expectedQty - loaded);
    if (remaining > 0) {
      lines.push({ ...line, expectedQty: remaining });
      remainingBales += remaining;
    }
  }
  return { lines, remainingBales };
}
