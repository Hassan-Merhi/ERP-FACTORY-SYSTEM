// Extracted from ./goldenCoastPhase6AutoHadi.ts
import { eq } from "drizzle-orm";
import { voucherEntries } from "@shared/schema";
import {
  goldenCoastPhase7IdempotencyKey,
  goldenCoastPhase7SourceId,
  type GoldenCoastPhase7PostingRole,
} from "../../services/accounting/goldenCoastPhase7HadiTransfer";
import { assertTransactionCompanyScope } from "../../services/security/transactionCompanyScope";
import * as core from "./goldenCoastPhase6AutoHadiCore";
import { findPostedVoucher, type DatabaseTransaction } from "./resolveAutomaticHadiCashAccount";

export async function findReplayedAutomaticTransfer(
  tx: DatabaseTransaction,
  pair: core.GoldenCoastAutomaticHadiPair,
  clientRequestId: string,
  transferDigest: string
): Promise<core.GoldenCoastAutomaticHadiResult["postings"] | null> {
  const roles: Array<{ role: GoldenCoastPhase7PostingRole; companyId: number }> = [
    { role: "golden_coast", companyId: pair.goldenCoastCompanyId },
    { role: "hadi", companyId: pair.hadiCompanyId },
  ];
  const found: Array<{
    role: GoldenCoastPhase7PostingRole;
    companyId: number;
    marker: Awaited<ReturnType<typeof findPostedVoucher>>;
  }> = [];

  for (const item of roles) {
    await assertTransactionCompanyScope(tx, item.companyId);
    found.push({
      ...item,
      marker: await findPostedVoucher(
        tx,
        item.companyId,
        goldenCoastPhase7IdempotencyKey(pair.goldenCoastCompanyId, clientRequestId, item.role)
      ),
    });
  }
  await assertTransactionCompanyScope(tx, pair.goldenCoastCompanyId);

  const posted = found.filter((item) => item.marker != null);
  if (posted.length === 0) return null;
  if (posted.length !== roles.length) {
    throw new core.GoldenCoastPhase6AutoHadiError(
      `Automatic HADI collection ${clientRequestId} has a partially recorded cross-company posting pair.`,
      "GC_PHASE6_AUTO_HADI_IDEMPOTENCY_INCONSISTENT",
      409
    );
  }

  for (const item of found) {
    const expectedSourceId = goldenCoastPhase7SourceId("collect_via_hadi", transferDigest, item.role);
    if (item.marker?.sourceId !== expectedSourceId) {
      throw new core.GoldenCoastPhase6AutoHadiError(
        `Automatic HADI collection ${clientRequestId} was already posted with different routing data.`,
        "GC_PHASE6_AUTO_HADI_IDEMPOTENCY_CONFLICT",
        409
      );
    }
  }

  return Promise.all(
    found.map(async (item) => {
      const voucher = item.marker!.voucher;
      return {
        role: item.role,
        voucher,
        entries: await tx.select().from(voucherEntries).where(eq(voucherEntries.voucherId, voucher.id)),
      };
    })
  );
}
