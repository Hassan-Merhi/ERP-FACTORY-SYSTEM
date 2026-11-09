/**
 * Read-only tenant labels for previously posted Properties rental vouchers.
 * Do not rewrite immutable historical GL vouchers or voucher-entry narrations.
 */
import { and, eq, inArray, or } from "drizzle-orm";
import { db } from "../../db";
import { propertyContracts, propertyPayments } from "@shared/schema";
import { appendRentalTenantName } from "./rentalVoucherTenantDescription";

type VoucherRow = {
  id: number;
  voucherNumber: string;
  voucherType: string;
  description: string | null;
};

export async function withPropertiesRentalTenantNames<T extends VoucherRow>(
  companyId: number,
  rows: T[],
): Promise<T[]> {
  const cashVouchers = rows.filter((row) => row.voucherType === "Payment" || row.voucherType === "Receipt");
  const rentVoucherIds = cashVouchers
    .filter((row) => row.voucherNumber.startsWith("RENT-"))
    .map((row) => row.id);
  const guaranteeContractByVoucher = new Map<number, number>();
  for (const voucher of cashVouchers) {
    const match = /^GUAR(?:-(?:CASH|RENT|REFUND))?-\d+-(\d+)$/.exec(voucher.voucherNumber);
    if (match) guaranteeContractByVoucher.set(voucher.id, Number(match[1]));
  }
  if (rentVoucherIds.length === 0 && guaranteeContractByVoucher.size === 0) return rows;

  const namesByVoucher = new Map<number, string>();
  if (rentVoucherIds.length) {
    const matches = await db
      .select({ voucherId: propertyPayments.voucherId, tenantName: propertyContracts.tenantName })
      .from(propertyPayments)
      .innerJoin(propertyContracts, eq(propertyPayments.contractId, propertyContracts.id))
      .where(
        and(
          eq(propertyPayments.companyId, companyId),
          eq(propertyPayments.module, "PROPERTIES"),
          // Shared external contracts can belong to a linked company, while
          // their actual payment voucher belongs to the selected Properties company.
          or(eq(propertyContracts.companyId, companyId), eq(propertyContracts.linkedCompanyId, companyId)),
          inArray(propertyPayments.voucherId, rentVoucherIds),
        ),
      );
    for (const match of matches) {
      if (match.voucherId != null) namesByVoucher.set(match.voucherId, match.tenantName);
    }
  }
  if (guaranteeContractByVoucher.size) {
    const contracts = await db
      .select({ id: propertyContracts.id, tenantName: propertyContracts.tenantName })
      .from(propertyContracts)
      .where(
        and(
          eq(propertyContracts.companyId, companyId),
          eq(propertyContracts.module, "PROPERTIES"),
          inArray(propertyContracts.id, [...new Set(guaranteeContractByVoucher.values())]),
        ),
      );
    const nameByContractId = new Map(contracts.map((contract) => [contract.id, contract.tenantName]));
    for (const [voucherId, contractId] of guaranteeContractByVoucher) {
      const name = nameByContractId.get(contractId);
      if (name) namesByVoucher.set(voucherId, name);
    }
  }
  return rows.map((voucher) => {
    const tenantName = namesByVoucher.get(voucher.id);
    if (!tenantName) return voucher;
    return { ...voucher, description: appendRentalTenantName(voucher.description, tenantName) };
  });
}
