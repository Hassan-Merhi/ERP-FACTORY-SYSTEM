/**
 * Rate revisions do not touch historical voucher amounts. They DO change
 * presentational USD translations, so they must clear financial read caches
 * after (and only after) the audited company rate transaction commits.
 *
 * This handles the current Node process. Current group snapshots bypass their
 * five-minute cache separately so other Render workers cannot serve old FX.
 */
import { _invalidateCachedWhere } from "../shared/ttlCache";
import { _icCache } from "../../routes/import-cycle/_helpers";

export function invalidateCompanyFxRateCaches(companyId: number): number {
  if (!Number.isSafeInteger(companyId) || companyId <= 0) return 0;

  const financialPrefixes = [
    `net-profit:${companyId}:`,
    `ratios:${companyId}:`,
    `expense-breakdown:${companyId}:`,
  ];
  const invalidatedShared = _invalidateCachedWhere((key) => {
    if (financialPrefixes.some((prefix) => key.startsWith(prefix))) return true;
    if (!key.startsWith("group-net-position:")) return false;
    const parts = key.split(":");
    // group-net-position:asOfDate:live|historical:authorized-company-id-list
    if (parts.length !== 4) return false;
    return parts[3].split(",").some((id) => id === String(companyId));
  });
  const icKey = `import-cycle-balance:${companyId}`;
  const invalidatedImportCycle = _icCache.delete(icKey) ? 1 : 0;
  return invalidatedShared + invalidatedImportCycle;
}
