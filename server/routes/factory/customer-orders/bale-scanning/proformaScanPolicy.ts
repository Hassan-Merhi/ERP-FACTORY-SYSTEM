export function normalizeLoadingArticleCode(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLowerCase();
}

export function sumProformaQuantityLimit(lines: Array<{ quantity: unknown }>): number {
  return lines.reduce((sum, line) => {
    const quantity = Number(line.quantity);
    return sum + (Number.isFinite(quantity) && quantity > 0 ? quantity : 0);
  }, 0);
}

export function shouldEnforceProformaOverload(options: {
  ignoreProforma: boolean;
  allowBypassOverload: boolean;
  isReinstatingRemovedBale?: boolean;
}): boolean {
  return !options.ignoreProforma && !options.allowBypassOverload && !options.isReinstatingRemovedBale;
}

export function shouldRequireProformaMembership(options: {
  ignoreProforma: boolean;
  hasProformaLine: boolean;
}): boolean {
  return !options.ignoreProforma && !options.hasProformaLine;
}
