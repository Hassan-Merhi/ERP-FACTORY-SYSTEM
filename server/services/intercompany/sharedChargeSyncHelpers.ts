// Extracted from ./sharedChargeSync.ts
import { eq, inArray } from "drizzle-orm";
import {
  containers,
  intercompanySharedChargeAllocations,
  intercompanySharedChargeInvoices,
  intercompanyTrades,
} from "@shared/schema";
import { db } from "../../db";
import { type EditIdentity, rejectEdit } from "./tradeSync";
import {
  createTenantDatabaseScope,
  getDatabaseScopeRuntimeContext,
  runWithDatabaseScopeRuntimeContext,
} from "../security/databaseScopeRuntimeContext";
import {
  getCompanyRequestRuntimeContext,
  runWithCompanyRequestRuntimeContext,
} from "../security/companyRequestRuntimeContext";
import { hasSharedChargeGrant, type SharedChargeEntry } from "./previewSharedChargeAllocation";

export type ReviseSharedChargeInput = {
  invoiceId: number;
  expectedInvoiceVersion: number;
  postingDate: string;
  requestKey: string;
  reason: string;
  allocations: SharedChargeEntry[];
};

/** Only invoked AFTER explicit related-invoice permission verification. */
export async function withGrantedInvoiceScope<T>(
  identity: EditIdentity,
  companies: readonly number[],
  work: () => Promise<T>
) {
  const ctx = getCompanyRequestRuntimeContext(),
    dbScope = getDatabaseScopeRuntimeContext();
  if (
    (ctx && ctx.companyId !== identity.initiatingCompanyId) ||
    (dbScope?.kind === "tenant" && dbScope.companyId !== identity.initiatingCompanyId)
  ) {
    rejectEdit("Session company changed during invoice revision", "IC_CHARGE_SCOPE", 403);
  }
  const ids = [...new Set([identity.initiatingCompanyId, ...companies])];
  const run = () =>
    runWithDatabaseScopeRuntimeContext(
      createTenantDatabaseScope(identity.initiatingCompanyId, ids, "authorized-companies"),
      work
    );
  return ctx
    ? runWithCompanyRequestRuntimeContext(
        { ...ctx, authorizedCompanyIds: [...new Set([...(ctx.authorizedCompanyIds ?? []), ...ids])] },
        run
      )
    : run();
}

/** Returns only this invoiced set of linked containers; unrelated finances are never exposed. */
export async function sharedInvoiceDetail(invoiceId: number, identity: EditIdentity) {
  if (!Number.isSafeInteger(invoiceId) || invoiceId < 1) rejectEdit("Invalid shared invoice", "IC_CHARGE_INPUT", 422);
  const [invoice] = await db
    .select()
    .from(intercompanySharedChargeInvoices)
    .where(eq(intercompanySharedChargeInvoices.id, invoiceId));
  if (!invoice || invoice.state !== "confirmed") rejectEdit("Shared invoice not found", "IC_CHARGE_NOT_FOUND", 404);
  const entries = await db
    .select()
    .from(intercompanySharedChargeAllocations)
    .where(eq(intercompanySharedChargeAllocations.invoiceId, invoiceId));
  const trades = await db
    .select()
    .from(intercompanyTrades)
    .where(
      inArray(
        intercompanyTrades.id,
        entries.map((e) => e.tradeId)
      )
    );
  const relations = trades.map((t) => t.relationshipId);
  if (
    !trades.some((t) => [t.sourceCompanyId, t.destinationCompanyId].includes(identity.initiatingCompanyId)) ||
    !(await hasSharedChargeGrant(identity, invoice.externalInvoiceKey, relations, invoice.sourceCompanyId))
  ) {
    rejectEdit("Shared invoice requires a dedicated editor grant", "IC_CHARGE_FORBIDDEN", 403);
  }
  return withGrantedInvoiceScope(
    identity,
    trades.flatMap((t) => [t.sourceCompanyId, t.destinationCompanyId]),
    async () => {
      const physical = await db
        .select({ id: containers.id, containerNumber: containers.containerNumber })
        .from(containers)
        .where(
          inArray(
            containers.id,
            trades.map((t) => t.physicalContainerId)
          )
        );
      return {
        invoiceId: invoice.id,
        externalInvoiceKey: invoice.externalInvoiceKey,
        chargeType: invoice.chargeType,
        faceAmount: invoice.faceAmount,
        evidenceReference: invoice.evidenceReference,
        version: invoice.version,
        allocations: entries.map((e) => {
          const trade = trades.find((t) => t.id === e.tradeId)!;
          return {
            tradeId: e.tradeId,
            amount: e.amount,
            expectedVersion: trade.version,
            relationshipId: trade.relationshipId,
            containerNumber: physical.find((p) => p.id === trade.physicalContainerId)?.containerNumber ?? "Unknown",
            sourceCompanyId: trade.sourceCompanyId,
            destinationCompanyId: trade.destinationCompanyId,
          };
        }),
      };
    }
  );
}
