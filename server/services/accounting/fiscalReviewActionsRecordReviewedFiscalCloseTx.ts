// Extracted from ./fiscalReviewActions.ts
import { sql } from "drizzle-orm";
import type { DbTransaction } from "../../db";
import { writeAuditEvent } from "../audit";
import { type Reviewer } from "./fiscalReviewShared";

export async function recordReviewedFiscalCloseTx(
  tx: DbTransaction,
  input: {
    companyId: number;
    closureId: number;
    voucherId: number;
    accountingSignoffId: number;
    ownerSignoffId: number;
    evidenceHash: string;
    actor: Reviewer;
  }
) {
  await tx.execute(sql`
 INSERT INTO accounting_fiscal_reviewed_closures
 (company_id,fiscal_closure_id,closing_voucher_id,accounting_signoff_id,
  owner_signoff_id,evidence_hash,reviewed_by)
 VALUES(${input.companyId},${input.closureId},${input.voucherId},
  ${input.accountingSignoffId},${input.ownerSignoffId},
  ${input.evidenceHash},${input.actor.userId})
 `);
  await writeAuditEvent(
    {
      companyId: input.companyId,
      userId: input.actor.userId,
      username: input.actor.username,
      action: "approve",
      tableName: "accounting_fiscal_reviewed_closures",
      recordId: input.closureId,
      changes: {
        accountingSignoffId: { new: input.accountingSignoffId },
        ownerSignoffId: { new: input.ownerSignoffId },
        closingVoucherId: { new: input.voucherId },
        evidenceHash: { new: input.evidenceHash },
      },
    },
    tx
  );
}
