// Extracted from ./getTradingSetup.ts
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  companies,
  containers,
  importLogs,
  intercompanyImportBatches,
  intercompanyRelationshipPolicies,
  ledgerAccounts,
  purchaseOrders,
  stockItemCodeAliases,
  stockItems,
} from "@shared/schema";
import { companyScopedSuppliers } from "@shared/schema/supplierCompanyScope";
import { type DbTransaction } from "../../db";
import { planDestinationStockMapping } from "./destinationStockMapping";
import { logAudit } from "../../routes/_helpers";
import {
  assert,
  type IntercompanyImportInput,
  normalizedName,
  TradingImportError,
  validateWorkbookSelections,
  type WorkbookPreview,
} from "./containerTradingWorkbook";

export const IMPORT_LOCK = 741235;

export type Policy = typeof intercompanyRelationshipPolicies.$inferSelect;

type Account = typeof ledgerAccounts.$inferSelect;

function verifyAccount(all: Account[], companyId: number, id: number | null, kind: RegExp, purpose: string): number {
  const match = all.find((a) => a.id === id && a.companyId === companyId && !a.deletedAt);
  assert(match && kind.test(match.accountType), purpose + " must be a correctly typed account in company " + companyId);
  return match.id;
}

export function validatedAccounts(p: Policy, all: Account[]) {
  return {
    ar: verifyAccount(all, p.sourceCompanyId, p.sourceReceivableAccountId, /asset/i, "Receivable"),
    ap: verifyAccount(all, p.destinationCompanyId, p.destinationPayableAccountId, /liability/i, "Payable"),
    sales: verifyAccount(all, p.sourceCompanyId, p.sourceSalesAccountId, /income|sales|revenue/i, "Sales"),
    purchase: verifyAccount(all, p.sourceCompanyId, p.sourcePurchaseAccountId, /expense|cost/i, "Purchases"),
    cogs: verifyAccount(all, p.sourceCompanyId, p.sourceCostAccountId, /expense|cost/i, "COGS"),
    charges: verifyAccount(all, p.sourceCompanyId, p.sourceChargeAccrualAccountId, /liability/i, "Charge accrual"),
    git: verifyAccount(all, p.destinationCompanyId, p.destinationGitAccountId, /asset/i, "Goods in transit"),
  };
}

export function assertUsdPair(a: { baseCurrency: string | null }, b: { baseCurrency: string | null }) {
  assert(
    (a.baseCurrency || "USD").toUpperCase() === "USD" && (b.baseCurrency || "USD").toUpperCase() === "USD",
    "Phase 2 only supports USD-base companies; historical FX is planned for Phase 4"
  );
}

export type IntercompanyImportTxContext = {
  sourceCompanyId: number;
  userId: string;
  username: string;
  preview: WorkbookPreview;
  input: IntercompanyImportInput;
  ids: number[];
  destinations: number[];
  plans: ReturnType<typeof validateWorkbookSelections>;
  policies: (typeof intercompanyRelationshipPolicies.$inferSelect)[];
};

export async function postIntercompanyImportTxStep1Part1(tx: DbTransaction, ctx: IntercompanyImportTxContext) {
  const { sourceCompanyId, userId, username, preview, input, ids, destinations, plans, policies } = ctx;
  await tx.execute(sql`SELECT pg_advisory_xact_lock(${IMPORT_LOCK}, ${sourceCompanyId})`);
  // Partner settings may have changed while the request awaited the source lock.
  // Never post under a stale account map or a now-disabled relationship.
  const freshPolicies = await tx
    .select()
    .from(intercompanyRelationshipPolicies)
    .where(inArray(intercompanyRelationshipPolicies.id, ids))
    .for("update");
  const postingKeys = [
    "sourceReceivableAccountId",
    "destinationPayableAccountId",
    "sourceSalesAccountId",
    "sourcePurchaseAccountId",
    "sourceCostAccountId",
    "sourceChargeAccrualAccountId",
    "destinationGitAccountId",
    "destinationSupplierId",
  ] as const;
  for (const selected of policies) {
    const current = freshPolicies.find((p) => p.id === selected.id);
    assert(
      current &&
        current.tradeEnabled &&
        current.version === selected.version &&
        current.sourceCompanyId === sourceCompanyId &&
        current.destinationCompanyId === selected.destinationCompanyId &&
        postingKeys.every((key) => current[key] === selected[key]),
      "Partner account mapping changed during import. Preview again before confirming."
    );
  }
  const [existing] = await tx
    .select({ id: intercompanyImportBatches.id })
    .from(intercompanyImportBatches)
    .where(
      and(
        eq(intercompanyImportBatches.sourceCompanyId, sourceCompanyId),
        eq(intercompanyImportBatches.fileSha256, preview.sha256)
      )
    )
    .limit(1);
  const [legacy] = await tx
    .select({ id: importLogs.id })
    .from(importLogs)
    .where(eq(importLogs.fileHash, preview.md5))
    .limit(1);
  if (existing || legacy) throw new TradingImportError(409, "This Excel file has already been imported");
  const collisions = await tx
    .select({ containerNumber: containers.containerNumber })
    .from(containers)
    .where(
      inArray(
        sql`UPPER(BTRIM(${containers.containerNumber}))`,
        plans.map((p) => p.containerNumber.trim().toUpperCase())
      )
    )
    .limit(1);
  if (collisions.length)
    throw new TradingImportError(409, "Container already exists: " + collisions[0].containerNumber);

  const [source] = await tx.select().from(companies).where(eq(companies.id, sourceCompanyId));
  const otherCompanies = await tx.select().from(companies).where(inArray(companies.id, destinations));
  assert(
    source?.companyType === "properties" && source.active && otherCompanies.length === destinations.length,
    "Configured companies are not active"
  );
  for (const dest of otherCompanies) assertUsdPair(source, dest);
  const [external] = await tx
    .select()
    .from(companyScopedSuppliers)
    .where(
      and(
        eq(companyScopedSuppliers.id, input.externalSupplierId),
        eq(companyScopedSuppliers.companyId, sourceCompanyId),
        eq(companyScopedSuppliers.active, true),
        isNull(companyScopedSuppliers.deletedAt)
      )
    );
  assert(external, "External supplier must belong to the Properties company");
  for (const container of preview.containers) {
    const sheetCode = container.supplierCode?.trim();
    if (sheetCode) {
      assert(
        normalizedName(sheetCode) === normalizedName(external.code) ||
          normalizedName(sheetCode) === normalizedName(external.legalName),
        "External supplier code in container " +
          container.containerNumber +
          " does not match the selected Properties supplier"
      );
    }
  }
  const accounts = await tx
    .select()
    .from(ledgerAccounts)
    .where(
      and(inArray(ledgerAccounts.companyId, [sourceCompanyId, ...destinations]), isNull(ledgerAccounts.deletedAt))
    );
  const mappedAccounts = new Map(policies.map((p) => [p.id, validatedAccounts(p, accounts)]));
  for (const policyAccounts of mappedAccounts.values()) {
    assert(policyAccounts.purchase !== policyAccounts.cogs, "Purchases and COGS accounts must be distinct");
  }
  const partners = await tx
    .select()
    .from(companyScopedSuppliers)
    .where(inArray(companyScopedSuppliers.id, policies.map((p) => p.destinationSupplierId!).filter(Boolean)));
  for (const p of policies) {
    const partner = partners.find(
      (s) => s.id === p.destinationSupplierId && s.companyId === p.destinationCompanyId && s.active && !s.deletedAt
    );
    assert(
      partner && normalizedName(partner.legalName) === normalizedName(source.name),
      "Destination supplier must be the source Properties company"
    );
  }

  const scopeIds = [sourceCompanyId, ...destinations];
  const [stock, aliases, priorPos] = await Promise.all([
    tx.select().from(stockItems).where(inArray(stockItems.companyId, scopeIds)),
    tx.select().from(stockItemCodeAliases).where(inArray(stockItemCodeAliases.companyId, scopeIds)),
    tx
      .select({ companyId: purchaseOrders.companyId, poNumber: purchaseOrders.poNumber })
      .from(purchaseOrders)
      .where(inArray(purchaseOrders.companyId, scopeIds)),
  ]);
  // PHASE 4 — Resolve every source line against verified Properties stock,
  // then check destination code/aliases/name and UOM. A missing destination
  // item is safe to create only when every batch row has passed this
  // read-only plan. Conflicting or ambiguous identities reject the batch.
  const plannedStock = planDestinationStockMapping({
    sourceCompanyId,
    items: stock,
    aliases,
    allowedDestinationIds: destinations,
    lines: plans.flatMap((plan) => {
      const policy = policies.find((p) => p.id === plan.relationshipId)!;
      return plan.lines.map((line) => ({
        containerNumber: plan.containerNumber,
        destinationCompanyId: policy.destinationCompanyId,
        rowNum: line.rowNum,
        barcode: line.barcode,
        itemName: line.itemName,
      }));
    }),
  });

  // The source-level advisory lock already serializes intercompany imports.
  // All newly-created items, the paired POs, GIT journals and audit records
  // are committed or rolled back together in this single transaction.
  const createdStockItemIds = new Map<string, number>();
  for (const missing of plannedStock.creations) {
    const [created] = await tx
      .insert(stockItems)
      .values({
        companyId: missing.companyId,
        code: missing.code,
        name: missing.name,
        uom: missing.uom,
        openingQty: "0",
        openingRate: "0",
        openingValue: "0",
        sellingPrice: "0",
        active: true,
      })
      .returning();
    assert(created && created.companyId === missing.companyId, "Destination stock item creation failed");
    createdStockItemIds.set(missing.key, created.id);
    await logAudit(
      {
        userId,
        username,
        companyId: created.companyId,
        action: "create",
        tableName: "stock_items",
        recordId: created.id,
        recordIdentifier: created.code,
        changes: {
          code: { old: null, new: created.code },
          name: { old: null, new: created.name },
          uom: { old: null, new: created.uom },
          openingQty: { old: null, new: "0" },
          openingValue: { old: null, new: "0" },
          sourcePropertiesItemId: { old: null, new: missing.sourceItemId },
        },
      },
      tx
    );
  }
  return {
    plans,
    policies,
    preview,
    input,
    sourceCompanyId,
    userId,
    source,
    external,
    mappedAccounts,
    priorPos,
    plannedStock,
    createdStockItemIds,
  };
}
