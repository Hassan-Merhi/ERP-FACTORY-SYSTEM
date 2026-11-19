import Decimal from "decimal.js";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { accountingPostingRequests, ledgerAccounts, vouchers } from "@shared/schema";
import type { DbTransaction } from "../../db";
import { assertTransactionCompanyScope } from "../security/transactionCompanyScope";
import { getGoldenCoastAccountDefinition } from "../accounting/goldenCoastPhase2Accounts";
import {
  postBalancedVoucherTx,
  type PostingActor,
  type CentralPostingRequest,
} from "../accounting/centralPostingEngine";
import { removeFactoryDaybookMirrorTx } from "../accounting/factoryDaybookMirrorRemoval";
import {
  GOLDEN_COAST_POS_SETTLEMENT_SOURCE_TYPE,
  activeSingleAccount,
  digest,
  findHadiPostingLocation,
  findMatchingHadiCashTarget,
  idempotencyKey,
  money,
  postingDependencies,
  resolveCashTarget,
  resolvePair,
  sourceId,
  target,
  type PersistedPostingResult,
} from "./goldenCoastPosAccountingResolveCashTarget";
import {
  buildPosting,
  requireGoldenCoastSettlementClientSaleId,
  isGeneratedGoldenCoastSettlementVoucher,
} from "./goldenCoastPosAccountingHelpers";
export { GOLDEN_COAST_POS_SETTLEMENT_SOURCE_TYPE } from "./goldenCoastPosAccountingResolveCashTarget";

export async function isGoldenCoastPosCompany(tx: DbTransaction, companyId: number): Promise<boolean> {
  const rows = await tx
    .select({ subType: ledgerAccounts.subType })
    .from(ledgerAccounts)
    .where(
      and(
        eq(ledgerAccounts.companyId, companyId),
        inArray(ledgerAccounts.subType, ["gc_partner_capital", "gc_owner_capital"]),
        eq(ledgerAccounts.active, true),
        isNull(ledgerAccounts.deletedAt)
      )
    );
  const roles = new Set(rows.map((row) => row.subType));
  return roles.has("gc_partner_capital") && roles.has("gc_owner_capital");
}

export async function postGoldenCoastPosAccountingTx(input: {
  tx: DbTransaction;
  companyId: number;
  locationId: number;
  clientSaleId: string;
  revision: string;
  saleDate: string;
  amountUsd: number;
  paymentAccountType: "cash" | "bank";
  paymentAccountId: number;
  supplierPayableAccountId: number;
  payableAmountUsd: number;
  actor?: PostingActor;
}): Promise<void> {
  requireGoldenCoastSettlementClientSaleId(input.clientSaleId);
  if (input.amountUsd <= 0) return;

  const { tx, companyId } = input;
  const { parentCompanyId } = await resolvePair(tx, companyId);
  await assertTransactionCompanyScope(tx, companyId);
  const sourceCash = await resolveCashTarget(tx, companyId, input.paymentAccountType, input.paymentAccountId);
  const gcSalesCash = await activeSingleAccount(
    tx,
    companyId,
    getGoldenCoastAccountDefinition("gc_sales_cash").subType,
    "GC Sales Cash",
    getGoldenCoastAccountDefinition("gc_sales_cash").acceptedAccountTypes
  );
  const gcIntercompany = await activeSingleAccount(
    tx,
    companyId,
    "sp_hadi_intercompany",
    "Golden Coast HADI intercompany account",
    ["Intercompany"]
  );

  await assertTransactionCompanyScope(tx, parentCompanyId);
  const hadiCash = await findMatchingHadiCashTarget(tx, parentCompanyId, sourceCash.name);
  const hadiLocationId = await findHadiPostingLocation(tx, parentCompanyId);
  const hadiIntercompany = await activeSingleAccount(
    tx,
    parentCompanyId,
    "hadi_sp_intercompany",
    "HADI Golden Coast intercompany account",
    ["Intercompany"]
  );
  await assertTransactionCompanyScope(tx, companyId);

  const amount = money(input.amountUsd);
  const payable = money(input.payableAmountUsd);
  const settlementDigest = digest({
    companyId,
    parentCompanyId,
    locationId: input.locationId,
    saleDate: input.saleDate,
    amount,
    payable,
    sourceCash,
    hadiCash,
    gcSalesCash: gcSalesCash.id,
    supplierPayable: input.supplierPayableAccountId,
  });
  const label = input.revision;
  const actor = input.actor;
  const postings: Array<{ companyId: number; request: Promise<CentralPostingRequest> }> = [];

  if (new Decimal(payable).greaterThan(0) && input.supplierPayableAccountId !== gcSalesCash.id) {
    postings.push({
      companyId,
      request: buildPosting({
        companyId,
        locationId: input.locationId,
        voucherDate: input.saleDate,
        voucherNumber: `GC-POS-${input.clientSaleId}-${label}-PAYABLE`,
        description: "Golden Coast POS payable reclassification",
        amount: payable,
        clientRequestId: `${input.clientSaleId}:${label}:payable`,
        sourceId: sourceId(input.clientSaleId, settlementDigest, label, "payable_reclass"),
        idempotencyKey: idempotencyKey(companyId, input.clientSaleId, label, "payable_reclass"),
        entries: [
          { ledgerAccountId: input.supplierPayableAccountId, debitAmount: payable, creditAmount: "0" },
          { ledgerAccountId: gcSalesCash.id, debitAmount: "0", creditAmount: payable },
        ],
        actor,
      }),
    });
  }

  postings.push(
    {
      companyId,
      request: buildPosting({
        companyId,
        locationId: input.locationId,
        voucherDate: input.saleDate,
        voucherNumber: `GC-POS-${input.clientSaleId}-${label}-CASH`,
        description: "Golden Coast POS cash transferred to HADI",
        amount,
        clientRequestId: `${input.clientSaleId}:${label}:gc-cash`,
        sourceId: sourceId(input.clientSaleId, settlementDigest, label, "gc_cash_transfer"),
        idempotencyKey: idempotencyKey(companyId, input.clientSaleId, label, "gc_cash_transfer"),
        entries: [
          { ledgerAccountId: gcIntercompany.id, debitAmount: amount, creditAmount: "0" },
          { ...target(sourceCash), debitAmount: "0", creditAmount: amount },
        ],
        actor,
      }),
    },
    {
      companyId: parentCompanyId,
      request: buildPosting({
        companyId: parentCompanyId,
        locationId: hadiLocationId,
        voucherDate: input.saleDate,
        voucherNumber: `GC-POS-${input.clientSaleId}-${label}-CASH-HADI`,
        description: "Golden Coast POS cash received by HADI",
        amount,
        clientRequestId: `${input.clientSaleId}:${label}:hadi-cash`,
        sourceId: sourceId(input.clientSaleId, settlementDigest, label, "hadi_cash_receipt"),
        idempotencyKey: idempotencyKey(parentCompanyId, input.clientSaleId, label, "hadi_cash_receipt"),
        entries: [
          { ...target(hadiCash), debitAmount: amount, creditAmount: "0" },
          { ledgerAccountId: hadiIntercompany.id, debitAmount: "0", creditAmount: amount },
        ],
        actor,
      }),
    }
  );

  for (const item of postings) {
    await assertTransactionCompanyScope(tx, item.companyId);
    const request = await item.request;
    const posted = (await postBalancedVoucherTx(tx, request, postingDependencies)) as PersistedPostingResult;
    if (posted.replayed) {
      // Replays are valid after a transport retry. The source sale itself is
      // locked by clientSaleId, so no non-transactional side effect is needed.
      continue;
    }
  }
  await assertTransactionCompanyScope(tx, companyId);
}

/**
 * Retire every active programme-generated settlement voucher for one itemized
 * Golden Coast POS sale before rebuilding the current settlement.
 *
 * The accounting marker is the canonical lookup, but older production rows can
 * legitimately be missing that marker after manual repair. The voucher-number
 * prefix + programme-owned descriptions are therefore the recovery identity.
 * Old vouchers stay in the database as soft-deleted audit history while their
 * Daybook mirrors and replay markers are removed.
 */
export async function retireGoldenCoastPosAccountingTx(input: {
  tx: DbTransaction;
  companyId: number;
  clientSaleId: string;
}): Promise<{ retiredVoucherIds: number[] }> {
  const { tx, companyId } = input;
  const clientSaleId = requireGoldenCoastSettlementClientSaleId(input.clientSaleId);

  const { parentCompanyId } = await resolvePair(tx, companyId);
  const companyIds = [companyId, parentCompanyId];
  const voucherPrefix = `GC-POS-${clientSaleId}-`;
  const sourcePrefix = `${clientSaleId}:`;
  const retiredVoucherIds: number[] = [];

  for (const markerCompanyId of companyIds) {
    await assertTransactionCompanyScope(tx, markerCompanyId);

    const candidates = await tx
      .select()
      .from(vouchers)
      .where(
        and(
          eq(vouchers.companyId, markerCompanyId),
          isNull(vouchers.deletedAt),
          sql<boolean>`left(${vouchers.voucherNumber}, ${voucherPrefix.length}) = ${voucherPrefix}`
        )
      )
      .for("update");

    const activeSettlementVouchers = candidates.filter((voucher) =>
      isGeneratedGoldenCoastSettlementVoucher(voucher, clientSaleId)
    );
    const companyVoucherIds = activeSettlementVouchers.map((voucher) => Number(voucher.id));

    for (const voucherId of companyVoucherIds) {
      await removeFactoryDaybookMirrorTx({ tx, companyId: markerCompanyId, voucherId });
    }

    if (companyVoucherIds.length > 0) {
      await tx
        .update(vouchers)
        .set({ deletedAt: new Date() })
        .where(
          and(
            eq(vouchers.companyId, markerCompanyId),
            inArray(vouchers.id, companyVoucherIds),
            isNull(vouchers.deletedAt)
          )
        );
      retiredVoucherIds.push(...companyVoucherIds);
    }

    const markerRows = await tx
      .select({ id: accountingPostingRequests.id, sourceId: accountingPostingRequests.sourceId })
      .from(accountingPostingRequests)
      .where(
        and(
          eq(accountingPostingRequests.companyId, markerCompanyId),
          eq(accountingPostingRequests.sourceType, GOLDEN_COAST_POS_SETTLEMENT_SOURCE_TYPE),
          sql<boolean>`left(${accountingPostingRequests.sourceId}, ${sourcePrefix.length}) = ${sourcePrefix}`
        )
      );

    const markerIds = markerRows
      .filter((row) => String(row.sourceId).startsWith(sourcePrefix))
      .map((row) => Number(row.id));

    if (markerIds.length > 0) {
      await tx.delete(accountingPostingRequests).where(inArray(accountingPostingRequests.id, markerIds));
    }
  }

  await assertTransactionCompanyScope(tx, companyId);
  return { retiredVoucherIds: [...new Set(retiredVoucherIds)] };
}
