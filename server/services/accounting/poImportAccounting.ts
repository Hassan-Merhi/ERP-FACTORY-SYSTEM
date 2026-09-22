export type PoImportCreditTarget =
  { kind: "intercompany"; ledgerAccountId: number } | { kind: "supplier"; supplierId: number | null };

export function resolvePoImportCreditTarget(input: {
  companyType?: string | null;
  hasExplicitParentLink?: boolean;
  configuredIntercompanyCreditAccountId?: number | null;
  supplierId?: number | null;
}): PoImportCreditTarget {
  const configuredAccountId = input.configuredIntercompanyCreditAccountId;
  if (
    input.hasExplicitParentLink === true &&
    input.companyType !== "supplier_partner" &&
    Number.isInteger(configuredAccountId) &&
    Number(configuredAccountId) > 0
  ) {
    return { kind: "intercompany", ledgerAccountId: Number(configuredAccountId) };
  }

  return {
    kind: "supplier",
    supplierId: input.supplierId == null ? null : Number(input.supplierId),
  };
}
