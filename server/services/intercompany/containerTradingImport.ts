import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import {
  companies,
  importLogs,
  intercompanyAuditEvents,
  intercompanyImportBatches,
  intercompanyRelationshipPolicies,
  intercompanyTrades,
  ledgerAccounts,
} from "@shared/schema";
import { companyScopedSuppliers } from "@shared/schema/supplierCompanyScope";
import { db, type DbTransaction } from "../../db";
import { sumMoney } from "../../lib/money";

import {
  assert,
  normalizedName,
  validateWorkbookSelections,
  type IntercompanyImportInput,
  type WorkbookPreview,
} from "./containerTradingWorkbook";
import {
  IMPORT_LOCK,
  assertUsdPair,
  eligibleDestinations,
  postIntercompanyImportTxStep1,
  postIntercompanyImportTxStep2,
  validatedAccounts,
  withinTrustedPair,
  type IntercompanyImportTxContext,
  type Policy,
} from "./getTradingSetup";
import { postIntercompanyImportTxStep3 } from "./postIntercompanyImportTxStep3";
export { eligibleDestinations, getTradingSetup, withinTrustedPair } from "./getTradingSetup";

export {
  TradingImportError,
  importInputSchema,
  parseIntercompanyWorkbook,
  validateWorkbookSelections,
  type IntercompanyImportInput,
  type WorkbookPreview,
} from "./containerTradingWorkbook";
const positive = z.number().int().positive();

export const relationshipInputSchema = z.object({
  destinationCompanyId: positive,
  sourceReceivableAccountId: positive,
  destinationPayableAccountId: positive,
  sourceSalesAccountId: positive,
  sourcePurchaseAccountId: positive,
  sourceCostAccountId: positive,
  sourceChargeAccrualAccountId: positive,
  destinationGitAccountId: positive,
  destinationSupplierId: positive,
});

export async function setTradingRelationship(
  sourceCompanyId: number,
  userId: string,
  role: string,
  mapping: z.infer<typeof relationshipInputSchema>
) {
  const allowed = await eligibleDestinations(sourceCompanyId, userId, role);
  assert(
    allowed.some((d) => d.id === mapping.destinationCompanyId),
    "Destination company is not authorized"
  );
  return withinTrustedPair(sourceCompanyId, [mapping.destinationCompanyId], () =>
    db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${IMPORT_LOCK}, ${sourceCompanyId})`);
      const accounts = await tx
        .select()
        .from(ledgerAccounts)
        .where(
          and(
            inArray(ledgerAccounts.companyId, [sourceCompanyId, mapping.destinationCompanyId]),
            isNull(ledgerAccounts.deletedAt)
          )
        );
      const fields = {
        sourceCompanyId,
        ...mapping,
      };
      const selectedAccounts = validatedAccounts(fields as Policy, accounts);
      assert(
        selectedAccounts.purchase !== selectedAccounts.cogs,
        "Purchases and COGS must be distinct ledger accounts"
      );
      const [source] = await tx.select().from(companies).where(eq(companies.id, sourceCompanyId));
      const [dest] = await tx.select().from(companies).where(eq(companies.id, mapping.destinationCompanyId));
      assert(source?.companyType === "properties" && dest?.active, "Company pair is not available");
      assertUsdPair(source, dest);
      const [partner] = await tx
        .select()
        .from(companyScopedSuppliers)
        .where(
          and(
            eq(companyScopedSuppliers.id, mapping.destinationSupplierId),
            eq(companyScopedSuppliers.companyId, mapping.destinationCompanyId),
            eq(companyScopedSuppliers.active, true),
            isNull(companyScopedSuppliers.deletedAt)
          )
        );
      assert(
        partner && normalizedName(partner.legalName) === normalizedName(source.name),
        "Destination supplier must be registered with exactly the Properties company name"
      );
      const [existing] = await tx
        .select()
        .from(intercompanyRelationshipPolicies)
        .where(
          and(
            eq(intercompanyRelationshipPolicies.sourceCompanyId, sourceCompanyId),
            eq(intercompanyRelationshipPolicies.destinationCompanyId, mapping.destinationCompanyId),
            eq(intercompanyRelationshipPolicies.relationshipType, "container_trade")
          )
        );
      if (existing) {
        const trades = await tx
          .select({ id: intercompanyTrades.id })
          .from(intercompanyTrades)
          .where(eq(intercompanyTrades.relationshipId, existing.id))
          .limit(1);
        assert(!trades.length, "Relationship mapping cannot change once a trade has been recorded");
        const [updated] = await tx
          .update(intercompanyRelationshipPolicies)
          .set({
            ...fields,
            tradeEnabled: true,
            version: existing.version + 1,
            updatedAt: new Date(),
          })
          .where(eq(intercompanyRelationshipPolicies.id, existing.id))
          .returning();
        await tx.insert(intercompanyAuditEvents).values({
          eventKey: "ic-container-partner:" + updated.id + ":" + updated.version,
          relationshipId: updated.id,
          sourceCompanyId,
          actorUserId: userId,
          eventType: "trading-relationship-configured",
          sourceReference: "explicit Owner/Developer mapping",
          payload: {
            destinationCompanyId: mapping.destinationCompanyId,
            version: updated.version,
            accountMapping: fields,
          },
        });
        return updated;
      }
      const [created] = await tx
        .insert(intercompanyRelationshipPolicies)
        .values({
          ...fields,
          relationshipType: "container_trade",
          baseCurrency: "USD",
          tradeEnabled: true,
        })
        .returning();
      await tx.insert(intercompanyAuditEvents).values({
        eventKey: "ic-container-partner:" + created.id + ":" + created.version,
        relationshipId: created.id,
        sourceCompanyId,
        actorUserId: userId,
        eventType: "trading-relationship-configured",
        sourceReference: "explicit Owner/Developer mapping",
        payload: {
          destinationCompanyId: mapping.destinationCompanyId,
          version: created.version,
          accountMapping: fields,
        },
      });
      return created;
    })
  );
}

export async function postIntercompanyImport(args: {
  sourceCompanyId: number;
  userId: string;
  username: string;
  role: string;
  preview: WorkbookPreview;
  input: IntercompanyImportInput;
}) {
  const { sourceCompanyId, userId, username, role, preview, input } = args;
  const allowed = await eligibleDestinations(sourceCompanyId, userId, role);
  const plans = validateWorkbookSelections(preview, input);
  const ids = [...new Set(plans.map((p) => p.relationshipId))];
  const policies = await db
    .select()
    .from(intercompanyRelationshipPolicies)
    .where(inArray(intercompanyRelationshipPolicies.id, ids));
  assert(policies.length === ids.length, "Select configured relationships for all containers");
  for (const p of policies) {
    assert(
      p.sourceCompanyId === sourceCompanyId && p.relationshipType === "container_trade" && p.tradeEnabled,
      "Intercompany trading is disabled for this relationship"
    );
    assert(
      allowed.some((d) => d.id === p.destinationCompanyId),
      "You do not have access to the destination company"
    );
  }
  const destinations = [...new Set(policies.map((p) => p.destinationCompanyId))];
  return withinTrustedPair(sourceCompanyId, destinations, () =>
    db.transaction(async (tx) =>
      postIntercompanyImportTx(tx, {
        sourceCompanyId,
        userId,
        username,
        preview,
        input,
        ids,
        destinations,
        plans,
        policies,
      })
    )
  );
}

/** The posting transaction of postIntercompanyImport (runs under the source company's advisory lock). */
async function postIntercompanyImportTx(tx: DbTransaction, ctx: IntercompanyImportTxContext) {
  const {
    batch,
    createdStockItemIds,
    external,
    input,
    mapped,
    plannedStock,
    preview,
    source,
    sourceCompanyId,
    usedNumbers,
    userId,
  } = await postIntercompanyImportTxStep1(tx, ctx);
  const { results } = postIntercompanyImportTxStep2();
  await postIntercompanyImportTxStep3(
    { batch, external, input, mapped, preview, results, source, sourceCompanyId, usedNumbers, userId },
    tx
  );
  const { total } = await postIntercompanyImportTxStep4({ batch, preview, results }, tx);
  return {
    success: true,
    batchId: batch.id,
    containerCount: results.length,
    totalIntercompanyCost: total.toFixed(2),
    createdDestinationStockItems: createdStockItemIds.size,
    reusedDestinationStockLines: plannedStock.reusedCount,
    containers: results,
  };
}

async function postIntercompanyImportTxStep4(
  {
    batch,
    preview,
    results,
  }: Pick<
    Awaited<ReturnType<typeof postIntercompanyImportTxStep1>> &
      Awaited<ReturnType<typeof postIntercompanyImportTxStep2>>,
    "batch" | "preview" | "results"
  >,
  tx: DbTransaction
) {
  await tx.insert(importLogs).values({
    fileName: preview.fileName,
    fileHash: preview.md5,
    rowCount: preview.rowCount,
    containerId: results[0].containerId,
    status: "Success",
  });
  await tx
    .update(intercompanyImportBatches)
    .set({ state: "confirmed", confirmedAt: new Date() })
    .where(eq(intercompanyImportBatches.id, batch.id));
  const total = sumMoney(results.map((r) => r.landedTotal));
  assert(total.gt(0), "Total intercompany cost must be positive");
  return { total };
}
