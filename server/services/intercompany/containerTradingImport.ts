/**
 * Phase 2 intercompany trading. Every PO, GIT balance, and journal in one Excel
 * workbook shares ONE PostgreSQL transaction. No cash or stock movement occurs.
 */
import { createHash } from "node:crypto";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import {
  companies,
  containers,
  containerCharges,
  importLogs,
  intercompanyAuditEvents,
  intercompanyImportBatchContainers,
  intercompanyImportBatches,
  intercompanyRelationshipPolicies,
  intercompanyTrades,
  intercompanyTradeSourcePos,
  intercompanyTradeLineLinks,
  ledgerAccounts,
  poLineItems,
  purchaseOrders,
  stockItemCodeAliases,
  stockItems,
  userCompanyRoles,
} from "@shared/schema";
import { companyScopedSuppliers } from "@shared/schema/supplierCompanyScope";
import { db } from "../../db";
import { sumMoney } from "../../lib/money";
import { postErpVoucherTx, type ErpVoucherLine } from "../accounting/erpVoucherPosting";
import { destinationContainerGitPostingLines } from "./containerDestinationPosting";
import { autoAllocateNewTradeCreditTx } from "./paymentAllocationCore";
import {
  createTenantDatabaseScope,
  getDatabaseScopeRuntimeContext,
  runWithDatabaseScopeRuntimeContext,
} from "../security/databaseScopeRuntimeContext";
import {
  getCompanyRequestRuntimeContext,
  runWithCompanyRequestRuntimeContext,
} from "../security/companyRequestRuntimeContext";
import { type ImportLine } from "./containerImportPlan";

import {
  TradingImportError,
  assert,
  generatedPoNumber,
  money,
  normalizedName,
  validateWorkbookSelections,
  type IntercompanyImportInput,
  type WorkbookPreview,
} from "./containerTradingWorkbook";

export {
  TradingImportError,
  importInputSchema,
  parseIntercompanyWorkbook,
  validateWorkbookSelections,
  type IntercompanyImportInput,
  type WorkbookPreview,
} from "./containerTradingWorkbook";

const IMPORT_LOCK = 741235;
const positive = z.number().int().positive();
type Policy = typeof intercompanyRelationshipPolicies.$inferSelect;
type Account = typeof ledgerAccounts.$inferSelect;
type Stock = typeof stockItems.$inferSelect;

function verifyAccount(all: Account[], companyId: number, id: number | null, kind: RegExp, purpose: string): number {
  const match = all.find((a) => a.id === id && a.companyId === companyId && !a.deletedAt);
  assert(match && kind.test(match.accountType), purpose + " must be a correctly typed account in company " + companyId);
  return match.id;
}

function validatedAccounts(p: Policy, all: Account[]) {
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

function resolveCompanyStock(items: Stock[], aliases: (typeof stockItemCodeAliases.$inferSelect)[]) {
  const active = items.filter((row) => row.active && !row.deletedAt);
  const byCode = new Map(active.map((item) => [item.companyId + ":" + item.code.toLowerCase(), item]));
  const byName = new Map<string, Stock[]>();
  for (const row of active) {
    const key = row.companyId + ":" + normalizedName(row.name);
    byName.set(key, [...(byName.get(key) || []), row]);
  }
  for (const alias of aliases) {
    const match = active.find((row) => row.id === alias.stockItemId && row.companyId === alias.companyId);
    if (match) byCode.set(alias.companyId + ":" + alias.aliasCode.toLowerCase(), match);
  }
  return (companyId: number, line: ImportLine): Stock => {
    const direct = line.barcode ? byCode.get(companyId + ":" + line.barcode.toLowerCase()) : null;
    if (direct) return direct;
    const matches = byName.get(companyId + ":" + normalizedName(line.itemName)) ?? [];
    if (matches.length === 1) return matches[0];
    throw new TradingImportError(
      400,
      "Excel row " +
        line.rowNum +
        ": no unique stock-item mapping for " +
        (line.barcode || line.itemName) +
        " in company " +
        companyId
    );
  };
}

function assertUsdPair(a: { baseCurrency: string | null }, b: { baseCurrency: string | null }) {
  assert(
    (a.baseCurrency || "USD").toUpperCase() === "USD" && (b.baseCurrency || "USD").toUpperCase() === "USD",
    "Phase 2 only supports USD-base companies; historical FX is planned for Phase 4"
  );
}

function withinTrustedPair<T>(source: number, destinations: number[], operation: () => Promise<T>): Promise<T> {
  const scope = getDatabaseScopeRuntimeContext();
  if (scope?.kind === "tenant" && scope.companyId !== source) {
    throw new TradingImportError(403, "Company context differs from authenticated Properties company");
  }
  const execute = () =>
    runWithDatabaseScopeRuntimeContext(
      createTenantDatabaseScope(source, destinations, "authorized-companies"),
      operation
    );
  const request = getCompanyRequestRuntimeContext();
  if (!request) return execute();
  return runWithCompanyRequestRuntimeContext(
    {
      ...request,
      authorizedCompanyIds: [...new Set([...(request.authorizedCompanyIds ?? []), ...destinations])],
    },
    execute
  );
}

export async function eligibleDestinations(sourceCompanyId: number, userId: string, role: string) {
  const [source] = await db.select().from(companies).where(eq(companies.id, sourceCompanyId));
  assert(
    source?.companyType === "properties" && source.active,
    "Trading is available only from an active Properties company"
  );
  assert(role === "Developer" || role === "Owner", "Only Owners and Developers may import containers");
  const memberships = await db.select().from(userCompanyRoles).where(eq(userCompanyRoles.userId, userId));
  const ids = memberships.filter((m) => m.role === "Owner" || m.role === "Developer").map((m) => m.companyId);
  const candidates =
    role === "Developer"
      ? await db.select().from(companies).where(eq(companies.active, true))
      : await db
          .select()
          .from(companies)
          .where(and(eq(companies.active, true), inArray(companies.id, ids.length ? ids : [-1])));
  return candidates.filter((c) => c.id !== sourceCompanyId && c.companyType === "erp" && c.active);
}

export async function getTradingSetup(sourceCompanyId: number, userId: string, role: string) {
  const destinations = await eligibleDestinations(sourceCompanyId, userId, role);
  return withinTrustedPair(
    sourceCompanyId,
    destinations.map((c) => c.id),
    async () => {
      const companiesInView = [sourceCompanyId, ...destinations.map((c) => c.id)];
      const [accounts, suppliers, policies] = await Promise.all([
        db
          .select({
            id: ledgerAccounts.id,
            companyId: ledgerAccounts.companyId,
            code: ledgerAccounts.code,
            name: ledgerAccounts.name,
            accountType: ledgerAccounts.accountType,
          })
          .from(ledgerAccounts)
          .where(and(inArray(ledgerAccounts.companyId, companiesInView), isNull(ledgerAccounts.deletedAt))),
        db
          .select({
            id: companyScopedSuppliers.id,
            companyId: companyScopedSuppliers.companyId,
            legalName: companyScopedSuppliers.legalName,
            code: companyScopedSuppliers.code,
          })
          .from(companyScopedSuppliers)
          .where(
            and(
              inArray(companyScopedSuppliers.companyId, companiesInView),
              eq(companyScopedSuppliers.active, true),
              isNull(companyScopedSuppliers.deletedAt)
            )
          ),
        db
          .select()
          .from(intercompanyRelationshipPolicies)
          .where(
            and(
              eq(intercompanyRelationshipPolicies.sourceCompanyId, sourceCompanyId),
              eq(intercompanyRelationshipPolicies.relationshipType, "container_trade")
            )
          ),
      ]);
      return { sourceCompanyId, destinations, accounts, suppliers, policies };
    }
  );
}

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
      await tx.execute(sql.raw("SELECT pg_advisory_xact_lock(" + IMPORT_LOCK + ", " + sourceCompanyId + ")"));
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
  role: string;
  preview: WorkbookPreview;
  input: IntercompanyImportInput;
}) {
  const { sourceCompanyId, userId, role, preview, input } = args;
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
    db.transaction(async (tx) => {
      await tx.execute(sql.raw("SELECT pg_advisory_xact_lock(" + IMPORT_LOCK + ", " + sourceCompanyId + ")"));
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
      const itemFor = resolveCompanyStock(stock, aliases);
      // Validate all destination items before the first write. No partial import.
      const mapped = plans.map((plan) => {
        const policy = policies.find((p) => p.id === plan.relationshipId)!;
        const items = plan.lines.map((line) => {
          const sourceItem = itemFor(sourceCompanyId, line);
          const destItem = itemFor(policy.destinationCompanyId, line);
          assert(
            sourceItem.uom.toLowerCase() === destItem.uom.toLowerCase(),
            "Stock unit mismatch on Excel row " + line.rowNum
          );
          return { line, sourceItemId: sourceItem.id, destItemId: destItem.id };
        });
        return { plan, policy, items, accounts: mappedAccounts.get(policy.id)! };
      });
      const fingerprint = createHash("sha256")
        .update(JSON.stringify({ file: preview.sha256, input }))
        .digest("hex");
      const [batch] = await tx
        .insert(intercompanyImportBatches)
        .values({
          sourceCompanyId,
          fileName: preview.fileName,
          fileSha256: preview.sha256,
          requestFingerprint: fingerprint,
          state: "pending",
          createdBy: userId,
        })
        .returning();
      const usedNumbers = new Set(priorPos.map((p) => p.companyId + ":" + p.poNumber));
      const results: Array<{
        containerNumber: string;
        containerId: number;
        destinationCompanyId: number;
        sourcePoIds: number[];
        destinationPoId: number;
        tradeId: number;
        landedTotal: string;
      }> = [];

      for (const { plan, policy, items, accounts: acct } of mapped) {
        const [physical] = await tx
          .insert(containers)
          .values({
            companyId: sourceCompanyId,
            containerNumber: plan.containerNumber,
            supplierId: external.id,
            status: "OTW",
            importDate: input.importDate,
            itemsTotal: plan.goodsTotal,
            chargesTotal: plan.chargesNet,
            grandTotal: plan.landedTotal,
          })
          .returning();

        const sourcePoIds: number[] = [];
        const supplierVoucherIds: number[] = [];
        const sourceLineIdsByExcelRow = new Map<number, number>();
        for (const [index, group] of plan.sourcePos.entries()) {
          const key = preview.sha256 + ":" + plan.containerNumber + ":" + index;
          let poNumber = group.originalPoNumber || generatedPoNumber("HP-EXT-", plan.containerNumber, key);
          if (usedNumbers.has(sourceCompanyId + ":" + poNumber))
            poNumber = generatedPoNumber("HP-EXT-", plan.containerNumber, key);
          assert(!usedNumbers.has(sourceCompanyId + ":" + poNumber), "Source PO number collision");
          usedNumbers.add(sourceCompanyId + ":" + poNumber);

          // Cost is recognized at the immediate at-cost resale, not as held HP stock.
          // Only verified supplier and confirmed charge liabilities are credited.
          const lines: ErpVoucherLine[] = [
            {
              ledgerAccountId: acct.purchase,
              debit: group.grandTotal,
              narration: "External goods and confirmed landed cost",
            },
          ];
          if (money(group.supplierCredit).gt(0))
            lines.push({
              supplierId: external.id,
              credit: group.supplierCredit,
              narration: "Eurogulf/external supplier payable",
            });
          if (money(group.chargeAccrualCredit).gt(0))
            lines.push({
              ledgerAccountId: acct.charges,
              credit: group.chargeAccrualCredit,
              narration: "Confirmed charges payable (not cash)",
            });
          const journal = await postErpVoucherTx(tx, {
            companyId: sourceCompanyId,
            voucherType: "Purchase",
            voucherDate: input.importDate,
            description: "Original supplier PO " + (group.originalPoNumber || poNumber) + " - " + plan.containerNumber,
            lines,
            source: { type: "ic-container-external", id: batch.id + ":" + physical.id + ":" + index },
            actor: { userId, reason: "Intercompany at-cost external purchase" },
          });
          const [sourcePo] = await tx
            .insert(purchaseOrders)
            .values({
              companyId: sourceCompanyId,
              poNumber,
              containerId: physical.id,
              supplierId: external.id,
              voucherId: journal.voucher.id,
              currency: "USD",
              itemsTotal: group.itemsTotal,
              freight: group.freight,
              surcharge: group.surcharge,
              fumigation: group.fumigation,
              documentCharges: group.documentCharges,
              discount: group.discount,
              otherCharges: group.otherCharges,
              status: "Open",
            })
            .returning();
          const insertedSourceLines = await tx
            .insert(poLineItems)
            .values(
              group.lines.map((line) => {
                const stockMatch = items.find((i) => i.line === line)!;
                return {
                  poId: sourcePo.id,
                  stockItemId: stockMatch.sourceItemId,
                  itemName: line.itemName,
                  quantity: line.quantity,
                  rate: line.rate,
                  lineTotal: line.lineTotal,
                };
              })
            )
            .returning({ id: poLineItems.id });
          assert(insertedSourceLines.length === group.lines.length, "Source PO line insertion was incomplete");
          group.lines.forEach((line, index) => {
            assert(!sourceLineIdsByExcelRow.has(line.rowNum), "Original Excel row is not uniquely identified");
            sourceLineIdsByExcelRow.set(line.rowNum, insertedSourceLines[index].id);
          });
          sourcePoIds.push(sourcePo.id);
          supplierVoucherIds.push(journal.voucher.id);
        }

        const targetPoNumber = generatedPoNumber(
          "HP-IC-",
          plan.containerNumber,
          sourceCompanyId + ":" + policy.destinationCompanyId + ":" + plan.containerNumber
        );
        assert(
          !usedNumbers.has(policy.destinationCompanyId + ":" + targetPoNumber),
          "A destination PO with this number already exists"
        );
        usedNumbers.add(policy.destinationCompanyId + ":" + targetPoNumber);
        const destVoucher = await postErpVoucherTx(tx, {
          companyId: policy.destinationCompanyId,
          voucherType: "Purchase",
          voucherDate: input.importDate,
          description: source.name + " linked container purchase - " + plan.containerNumber,
          lines: destinationContainerGitPostingLines({
            goodsInTransitLedgerAccountId: acct.git,
            propertiesSupplierId: policy.destinationSupplierId!,
            confirmedLandedCost: plan.landedTotal,
            sourceCompanyName: source.name,
          }),
          source: { type: "ic-container-destination", id: batch.id + ":" + physical.id },
          actor: { userId, reason: "Paired at-cost purchase, not an external payment" },
        });
        const [destPo] = await tx
          .insert(purchaseOrders)
          .values({
            companyId: policy.destinationCompanyId,
            poNumber: targetPoNumber,
            containerId: physical.id,
            supplierId: policy.destinationSupplierId!,
            voucherId: destVoucher.voucher.id,
            currency: "USD",
            itemsTotal: plan.goodsTotal,
            ...plan.charges,
            status: "Open",
          })
          .returning();
        const insertedDestinationLines = await tx
          .insert(poLineItems)
          .values(
            items.map(({ line, destItemId }) => ({
              poId: destPo.id,
              stockItemId: destItemId,
              itemName: line.itemName,
              quantity: line.quantity,
              rate: line.rate,
              lineTotal: line.lineTotal,
            }))
          )
          .returning({ id: poLineItems.id });
        assert(insertedDestinationLines.length === items.length, "Destination PO lines were incomplete");

        const [trade] = await tx
          .insert(intercompanyTrades)
          .values({
            relationshipId: policy.id,
            physicalContainerId: physical.id,
            sourceCompanyId,
            destinationCompanyId: policy.destinationCompanyId,
            originalSupplierPoId: sourcePoIds[0],
            destinationPoId: destPo.id,
            state: "pending",
          })
          .returning();
        await tx.insert(intercompanyTradeSourcePos).values(
          plan.sourcePos.map((p, index) => ({
            tradeId: trade.id,
            sourcePoId: sourcePoIds[index],
            originalPoNumber: p.originalPoNumber || "(blank in workbook)",
          }))
        );
        // Immutable row mapping avoids guessing by item names, barcodes or order on later edits.
        await tx.insert(intercompanyTradeLineLinks).values(
          items.map(({ line }, index) => {
            const sourceLineId = sourceLineIdsByExcelRow.get(line.rowNum);
            assert(
              sourceLineId && insertedDestinationLines[index]?.id,
              "Missing verified original-to-destination row link"
            );
            return {
              tradeId: trade.id,
              sourceLineId,
              destinationLineId: insertedDestinationLines[index].id,
              originalExcelRow: line.rowNum,
            };
          })
        );
        const saleVoucher = await postErpVoucherTx(tx, {
          companyId: sourceCompanyId,
          voucherType: "Sales",
          voucherDate: input.importDate,
          description: "At-cost container resale to " + policy.destinationCompanyId + " - " + plan.containerNumber,
          lines: [
            { ledgerAccountId: acct.ar, debit: plan.landedTotal, narration: "Intercompany receivable" },
            {
              ledgerAccountId: acct.sales,
              credit: plan.landedTotal,
              narration: "Intercompany sales at full confirmed cost",
            },
          ],
          source: { type: "ic-container-source-sale", id: trade.id },
          actor: { userId, reason: "Zero-markup intercompany resale" },
        });
        // Reclassify purchased cost to COGS when HP immediately resells the goods.
        // Purchases nets to zero, and sale proceeds exactly equal COGS (no markup).
        const costVoucher = await postErpVoucherTx(tx, {
          companyId: sourceCompanyId,
          voucherType: "Journal",
          voucherDate: input.importDate,
          description: "At-cost goods transferred out - " + plan.containerNumber,
          lines: [
            { ledgerAccountId: acct.cogs, debit: plan.landedTotal, narration: "Internal sale cost of goods sold" },
            { ledgerAccountId: acct.purchase, credit: plan.landedTotal, narration: "Release original purchase cost" },
          ],
          source: { type: "ic-container-source-cost", id: trade.id },
          actor: { userId, reason: "Cost of goods sold on at-cost intercompany resale" },
        });
        for (const [name, value] of [
          ["Freight", plan.charges.freight],
          ["Surcharge", plan.charges.surcharge],
          ["Fumigation", plan.charges.fumigation],
          ["Document Charges", plan.charges.documentCharges],
          ["Discount", money(plan.charges.discount).negated().toFixed(2)],
        ] as const)
          if (!money(value).isZero()) {
            await tx.insert(containerCharges).values({ containerId: physical.id, chargeType: name, amount: value });
          }
        await tx.update(intercompanyTrades).set({ state: "active" }).where(eq(intercompanyTrades.id, trade.id));
        await tx.insert(intercompanyImportBatchContainers).values({
          batchId: batch.id,
          containerNumber: plan.containerNumber,
          destinationCompanyId: policy.destinationCompanyId,
          physicalContainerId: physical.id,
          tradeId: trade.id,
          chargesConfirmed: plan.chargesConfirmed,
          chargeEvidenceReference: plan.chargeEvidenceReference,
          confirmedLandedCost: plan.landedTotal,
        });
        // Only at NEW PO import: reuse older verified credit of this exact company pair.
        // Credit allocation has no voucher entries; the original cash receipt already posted.
        const previousCredit = await autoAllocateNewTradeCreditTx(tx, {
          tradeId: trade.id,
          relationshipId: policy.id,
          confirmedLandedCost: plan.landedTotal,
        });
        await tx.insert(intercompanyAuditEvents).values({
          eventKey: "ic-container-import:" + batch.id + ":" + trade.id,
          relationshipId: policy.id,
          sourceCompanyId,
          actorUserId: userId,
          eventType: "container-import-confirmed",
          sourceReference: preview.sha256,
          payload: {
            physicalContainerId: physical.id,
            sourcePoIds,
            originalSupplierVoucherIds: supplierVoucherIds,
            sourceSaleVoucherId: saleVoucher.voucher.id,
            sourceCostVoucherId: costVoucher.voucher.id,
            destinationPoId: destPo.id,
            destinationVoucherId: destVoucher.voucher.id,
            landedCost: plan.landedTotal,
            previousCreditAllocated: previousCredit.applied,
            unpaidAfterExistingCredit: previousCredit.remainingDue,
            chargesConfirmed: plan.chargesConfirmed,
            chargeEvidenceReference: plan.chargeEvidenceReference,
            proposedCharges: plan.proposedCharges,
          },
        });
        results.push({
          containerNumber: plan.containerNumber,
          containerId: physical.id,
          destinationCompanyId: policy.destinationCompanyId,
          sourcePoIds,
          destinationPoId: destPo.id,
          tradeId: trade.id,
          landedTotal: plan.landedTotal,
        });
      }

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
      return {
        success: true,
        batchId: batch.id,
        containerCount: results.length,
        totalIntercompanyCost: total.toFixed(2),
        containers: results,
      };
    })
  );
}
