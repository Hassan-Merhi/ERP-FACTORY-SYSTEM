// Extracted from ./containerTradingImport.ts to keep that module under the source-size cap.
import { createHash } from "node:crypto";
import { and, eq, inArray, isNull } from "drizzle-orm";
import {
  companies,
  intercompanyImportBatches,
  intercompanyRelationshipPolicies,
  ledgerAccounts,
  userCompanyRoles,
} from "@shared/schema";
import { companyScopedSuppliers } from "@shared/schema/supplierCompanyScope";
import { db, type DbTransaction } from "../../db";
import { finalizedStockItemId, verifiedStockRowKey } from "./destinationStockMapping";
import {
  createTenantDatabaseScope,
  getDatabaseScopeRuntimeContext,
  runWithDatabaseScopeRuntimeContext,
} from "../security/databaseScopeRuntimeContext";
import {
  getCompanyRequestRuntimeContext,
  runWithCompanyRequestRuntimeContext,
} from "../security/companyRequestRuntimeContext";
import { assert, TradingImportError } from "./containerTradingWorkbook";
import {
  postIntercompanyImportTxStep1Part1,
  type IntercompanyImportTxContext,
} from "./postIntercompanyImportTxStep1Part1";
export {
  IMPORT_LOCK,
  validatedAccounts,
  assertUsdPair,
  type Policy,
  type IntercompanyImportTxContext,
} from "./postIntercompanyImportTxStep1Part1";

export function withinTrustedPair<T>(source: number, destinations: number[], operation: () => Promise<T>): Promise<T> {
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

export async function postIntercompanyImportTxStep1(tx: DbTransaction, ctx: IntercompanyImportTxContext) {
  const {
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
  } = await postIntercompanyImportTxStep1Part1(tx, ctx);
  const plannedRows = new Map(plannedStock.assignments.map((row) => [row.key, row]));
  const mapped = plans.map((plan) => {
    const policy = policies.find((p) => p.id === plan.relationshipId)!;
    const items = plan.lines.map((line) => {
      const verified = plannedRows.get(verifiedStockRowKey(plan.containerNumber, line.rowNum));
      assert(
        verified && verified.destinationCompanyId === policy.destinationCompanyId,
        "Verified stock row is missing"
      );
      return {
        line,
        sourceItemId: verified.sourceItemId,
        destItemId: finalizedStockItemId(verified, createdStockItemIds),
        destinationItemAutoCreated: Boolean(verified.creationKey),
      };
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
  return {
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
  };
}

export function postIntercompanyImportTxStep2() {
  const results: Array<{
    containerNumber: string;
    containerId: number;
    destinationCompanyId: number;
    sourcePoIds: number[];
    destinationPoId: number;
    tradeId: number;
    landedTotal: string;
  }> = [];
  return { results };
}
