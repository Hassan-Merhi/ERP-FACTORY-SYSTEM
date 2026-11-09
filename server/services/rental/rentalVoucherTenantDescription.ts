/** Append a contract's tenant name without changing the original voucher accounting. */
export function appendRentalTenantName(
  narration: string | null,
  tenantName: string | null | undefined,
): string | null {
  const name = tenantName?.trim();
  if (!name) return narration;
  const current = narration?.trim() ?? "";
  if (current.toLocaleLowerCase().includes(`tenant: ${name}`.toLocaleLowerCase())) {
    return narration;
  }
  return current ? `${current} - Tenant: ${name}` : `Tenant: ${name}`;
}
