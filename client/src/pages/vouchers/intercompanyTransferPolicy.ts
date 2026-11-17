/**
 * Voucher-only presentation gate. The server independently enforces
 * company membership, company pair, actual cash evidence and idempotency.
 * A normal Supplier Payment must never be reclassified as a mirrored transfer.
 */
export type VoucherTransferCompany =
  | {
      companyType: string;
      role?: string | null;
    }
  | null
  | undefined;

export function canOpenIntercompanyVoucherTransfer(
  company: VoucherTransferCompany,
  isPos: boolean,
  isEditingVoucher: boolean
): boolean {
  if (!company || isPos || isEditingVoucher) return false;
  if (company.companyType === "properties") return ["Owner", "Developer"].includes(company.role ?? "");
  if (company.companyType === "erp") return ["Owner", "Admin", "Developer"].includes(company.role ?? "");
  return false;
}

export function intercompanyVoucherDetailPath(
  companyType: string,
  sourceCompanyId: number,
  destinationCompanyId: number,
  selectedCompanyId: number,
  sourceReceiptVoucherId: number,
  destinationPaymentVoucherId: number
): string | null {
  if (companyType === "properties" && selectedCompanyId === sourceCompanyId && sourceReceiptVoucherId > 0) {
    return `/properties/voucher-detail/${sourceReceiptVoucherId}`;
  }
  if (companyType === "erp" && selectedCompanyId === destinationCompanyId && destinationPaymentVoucherId > 0) {
    return `/voucher-detail/${destinationPaymentVoucherId}`;
  }
  return null;
}
