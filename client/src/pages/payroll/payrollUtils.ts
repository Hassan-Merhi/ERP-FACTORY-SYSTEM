export function cleanTxnDesc(desc: string): string {
  if (!desc) return "-";
  return (
    desc
      .replace(/^(SAL-DEP|SAL-WD|SAL-BON)-[\w-]+\s*/i, "")
      .replace(/\s*-\s*(SAL-DEP|SAL-WD|SAL-BON)-[\w-]+$/i, "")
      .trim() || desc
  );
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}

/**
 * Bonus location pickers carry the source company inside the option value.
 *
 * The same physical location row can be offered under several companies: a
 * company that sells at a location it does not own (GC-LSHI) still needs that
 * location ID, paired with its own company, so the bonus reads its sales and
 * not the owner's. A bare location ID cannot express that pairing — and would
 * even collide between the "This Company" and "Other Companies" groups.
 */
export function encodeLocationOption(locationId: number | string, companyId: number | string): string {
  return `${locationId}:${companyId}`;
}

export function decodeLocationOption(value: string): { locationId: string; sourceCompanyId: string } {
  const [locationId = "", sourceCompanyId = ""] = (value || "").split(":");
  return { locationId, sourceCompanyId };
}
