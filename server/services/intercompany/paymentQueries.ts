/** Phase 4 read models expose only one verified Properties<->ERP company pair. */
import { and, asc, eq, inArray, isNull, or } from "drizzle-orm";
import {
  bankAccounts,
  intercompanyContainerPayments,
  intercompanyImportBatchContainers,
  intercompanyPaymentAllocations,
  intercompanyRelationshipPolicies,
  intercompanyTrades,
  ledgerAccounts,
} from "@shared/schema";
import { db } from "../../db";
import { MoneyDecimal } from "../../lib/money";
import { accessiblePaymentPair } from "./paymentSync";
import { canAccessPairedCash, pairedCashMemberships } from "./pairedPaymentAuthorization";
import { type EditIdentity, rejectEdit, withTradeScope } from "./tradeSync";
import { cents } from "./tradeRevisionMath";
import { pairCreditsTx, paymentAvailableTx, tradeAppliedTx } from "./paymentAllocationCore";

export async function listPaymentRelationships(actor: EditIdentity) {
  return withTradeScope(actor, [], async () => {
    const relationships = await db
      .select()
      .from(intercompanyRelationshipPolicies)
      .where(
        and(
          or(
            eq(intercompanyRelationshipPolicies.sourceCompanyId, actor.initiatingCompanyId),
            eq(intercompanyRelationshipPolicies.destinationCompanyId, actor.initiatingCompanyId)
          ),
          eq(intercompanyRelationshipPolicies.relationshipType, "container_trade")
        )
      );
    const eligible = [];
    for (const pair of relationships) {
      const membership = await pairedCashMemberships(pair, actor);
      if (canAccessPairedCash(pair, actor, membership)) {
        eligible.push({
          relationshipId: pair.id,
          sourceCompanyId: pair.sourceCompanyId,
          destinationCompanyId: pair.destinationCompanyId,
          tradeEnabled: pair.tradeEnabled,
        });
      }
    }
    return { relationships: eligible };
  });
}
export async function getPairPaymentSetup(relationshipId: number, actor: EditIdentity) {
  const pair = await accessiblePaymentPair(relationshipId, actor, false);
  return withTradeScope(actor, [pair.sourceCompanyId, pair.destinationCompanyId], async () => {
    const [cash, bank, allTrades] = await Promise.all([
      db
        .select({ id: ledgerAccounts.id, companyId: ledgerAccounts.companyId, name: ledgerAccounts.name })
        .from(ledgerAccounts)
        .where(
          and(
            inArray(ledgerAccounts.companyId, [pair.sourceCompanyId, pair.destinationCompanyId]),
            eq(ledgerAccounts.accountType, "Cash"),
            eq(ledgerAccounts.active, true),
            isNull(ledgerAccounts.deletedAt)
          )
        ),
      db
        .select({ id: bankAccounts.id, companyId: bankAccounts.companyId, name: bankAccounts.name })
        .from(bankAccounts)
        .where(
          and(
            inArray(bankAccounts.companyId, [pair.sourceCompanyId, pair.destinationCompanyId]),
            eq(bankAccounts.active, true),
            isNull(bankAccounts.deletedAt)
          )
        ),
      db
        .select()
        .from(intercompanyTrades)
        .where(and(eq(intercompanyTrades.relationshipId, pair.id), eq(intercompanyTrades.state, "active"))),
    ]);
    return db.transaction(async (tx) => {
      const imports = allTrades.length
        ? await tx
            .select()
            .from(intercompanyImportBatchContainers)
            .where(
              inArray(
                intercompanyImportBatchContainers.tradeId,
                allTrades.map((t) => t.id)
              )
            )
        : [];
      const pos = [];
      for (const trade of allTrades) {
        const importRow = imports.find((row) => row.tradeId === trade.id);
        if (!importRow) continue;
        if (importRow.confirmedLandedCost == null) rejectEdit("Linked PO lacks a confirmed landed cost");
        const applied = await tradeAppliedTx(tx, trade.id);
        const due = cents(importRow.confirmedLandedCost).minus(applied);
        if (due.lt(0)) rejectEdit("Linked PO payment allocation is not reconciled");
        pos.push({
          tradeId: trade.id,
          version: trade.version,
          containerNumber: importRow.containerNumber,
          landedCost: importRow.confirmedLandedCost,
          applied: applied.toFixed(2),
          unpaid: due.toFixed(2),
        });
      }
      const credits = await pairCreditsTx(tx, pair.id);
      return {
        relationshipId: pair.id,
        tradeEnabled: pair.tradeEnabled,
        sourceCompanyId: pair.sourceCompanyId,
        destinationCompanyId: pair.destinationCompanyId,
        cashAccounts: [
          ...cash.map((a) => ({ id: a.id, companyId: a.companyId, type: "cash", name: a.name })),
          ...bank.map((a) => ({ id: a.id, companyId: a.companyId, type: "bank", name: a.name })),
        ],
        purchaseOrders: pos,
        credits: credits.map((c) => ({
          paymentId: c.id,
          available: c.available.toFixed(2),
          originalPaymentDate: c.paymentDate,
        })),
      };
    });
  });
}
export async function getPairPaymentHistory(relationshipId: number, actor: EditIdentity) {
  const pair = await accessiblePaymentPair(relationshipId, actor, false);
  return withTradeScope(actor, [pair.sourceCompanyId, pair.destinationCompanyId], async () => {
    const all = await db
      .select()
      .from(intercompanyContainerPayments)
      .where(eq(intercompanyContainerPayments.relationshipId, relationshipId))
      .orderBy(asc(intercompanyContainerPayments.paymentDate), asc(intercompanyContainerPayments.id));
    return db.transaction(async (tx) => {
      const history = [];
      for (const row of all) {
        const [events, available] = await Promise.all([
          tx.select().from(intercompanyPaymentAllocations).where(eq(intercompanyPaymentAllocations.paymentId, row.id)),
          paymentAvailableTx(tx, row.id),
        ]);
        const allocatedByTrade = new Map<number, ReturnType<typeof cents>>();
        for (const e of events)
          allocatedByTrade.set(
            e.tradeId,
            (allocatedByTrade.get(e.tradeId) ?? new MoneyDecimal(0)).plus(cents(e.amount))
          );
        history.push({
          id: row.id,
          status: row.status,
          paymentDate: row.paymentDate,
          transferReference: row.transferReference,
          currency: row.transactionCurrency,
          nativeAmount: row.transactionAmount,
          historicalRate: row.historicalRate,
          baseAmount: row.baseAmount,
          credit: row.status === "confirmed" ? available.toFixed(2) : "0.00",
          sourceVoucherId: row.sourceReceiptVoucherId,
          destinationVoucherId: row.destinationPaymentVoucherId,
          sourceReversalVoucherId: row.sourceReversalVoucherId,
          destinationReversalVoucherId: row.destinationReversalVoucherId,
          applied: [...allocatedByTrade]
            .filter(([_, v]) => v.gt(0))
            .map(([tradeId, amount]) => ({
              tradeId,
              amount: amount.toFixed(2),
            })),
        });
      }
      return { relationshipId, history };
    });
  });
}
