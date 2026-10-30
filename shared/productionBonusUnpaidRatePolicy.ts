/** Latest saved bonus rates apply to ALL unpaid worker-days.
 * Date stamps are retained for audit, not as a cutoff for unpaid previews.
 * Paid/reversed claims preserve their original financial snapshot.
 */
export interface LatestBonusRateVersion {
  scope: unknown;
  workerId: unknown;
  enabled: unknown;
  rate: unknown;
}
export function latestUnpaidWorkerRate(
  versions: readonly LatestBonusRateVersion[],
  workerId: number,
): string | null {
  const version=versions.find(v=>v.scope==="worker"&&Number(v.workerId)===workerId)
    ?? versions.find(v=>v.scope==="company");
  if(!version||version.enabled!==true)return null;
  const rate=String(version.rate);
  const amount=Number(rate);
  return Number.isFinite(amount)&&amount>0?rate:null;
}
export function rateChangeMayRepriceReview(
  reviewStatus: unknown,
  paymentStatus: unknown,
): boolean {
  return reviewStatus==="approved" && (paymentStatus===null||paymentStatus===undefined);
}
