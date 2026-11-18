// Extracted from ./sharedChargeSync.ts to keep that module under the source-size cap.
import type Decimal from "decimal.js";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { intercompanyPermissionGrants, intercompanyTrades, userCompanyRoles } from "@shared/schema";
import { db, type DbTransaction } from "../../db";
import { sumMoney } from "../../lib/money";
import {
  type EditIdentity,
  loadTradeTx,
  postingDay,
  rejectEdit,
  requireUnreceived,
  validateRequestKey,
  withTradeScope,
} from "./tradeSync";
import { allocateByWeights, cents } from "./tradeRevisionMath";

export type ChargeField = "freight" | "surcharge" | "fumigation" | "documentCharges" | "otherCharges";

const FIELDS = new Set<ChargeField>(["freight", "surcharge", "fumigation", "documentCharges", "otherCharges"]);

export const CODES: Record<ChargeField, string> = {
  freight: "Freight",
  surcharge: "Surcharge",
  fumigation: "Fumigation",
  documentCharges: "Document Charges",
  otherCharges: "Other Charges",
};

const IMPORT_LOCK = 741235;

export type SharedChargeEntry = { tradeId: number; expectedVersion: number; amount: string };

export type ConfirmSharedChargeInput = {
  sourceCompanyId: number;
  invoiceKey: string;
  chargeType: ChargeField;
  faceAmount: string;
  evidenceReference: string;
  postingDate: string;
  requestKey: string;
  reason: string;
  allocations: SharedChargeEntry[];
};

export function requireInputs(input: { postingDate: string; requestKey: string; reason: string }) {
  postingDay(input.postingDate);
  validateRequestKey(input.requestKey);
  if (typeof input.reason !== "string" || input.reason.trim().length < 3 || input.reason.length > 1000) {
    rejectEdit("Enter a meaningful invoice allocation reason", "IC_CHARGE_REASON", 422);
  }
}

export function validateAllocations(allocations: SharedChargeEntry[], face: Decimal) {
  if (!Array.isArray(allocations) || !allocations.length || allocations.length > 100) {
    rejectEdit("Select one to one hundred eligible containers", "IC_CHARGE_ALLOCATION", 422);
  }
  if (new Set(allocations.map((x) => x.tradeId)).size !== allocations.length) {
    rejectEdit("Each container must appear only once on the invoice", "IC_CHARGE_DUPLICATE", 422);
  }
  const values = allocations.map((x) => {
    if (
      !Number.isSafeInteger(x.tradeId) ||
      x.tradeId <= 0 ||
      !Number.isSafeInteger(x.expectedVersion) ||
      x.expectedVersion <= 0 ||
      typeof x.amount !== "string" ||
      !/^\d+(\.\d{1,2})?$/.test(x.amount)
    ) {
      rejectEdit(
        "Container allocation requires a positive trade ID, version and cent-exact amount",
        "IC_CHARGE_ALLOCATION",
        422
      );
    }
    const value = cents(x.amount);
    if (value.lt(0)) rejectEdit("Shared charge allocation cannot be negative");
    return value;
  });
  if (!sumMoney(values).eq(face)) {
    rejectEdit(
      "Shared allocation total must equal the unchanged external invoice face amount",
      "IC_CHARGE_TOTAL_MISMATCH",
      422
    );
  }
  return values;
}

export function assertInvoiceInput(input: ConfirmSharedChargeInput) {
  requireInputs(input);
  if (
    !Number.isSafeInteger(input.sourceCompanyId) ||
    input.sourceCompanyId <= 0 ||
    !/^[A-Za-z0-9._/:-]{3,120}$/.test(input.invoiceKey) ||
    !FIELDS.has(input.chargeType) ||
    !input.evidenceReference?.trim() ||
    input.evidenceReference.trim().length < 3 ||
    input.evidenceReference.length > 500 ||
    typeof input.faceAmount !== "string" ||
    !/^\d+(\.\d{1,2})?$/.test(input.faceAmount)
  ) {
    rejectEdit("Invalid original supplier invoice reference, type, evidence or USD amount", "IC_CHARGE_INVALID", 422);
  }
  const face = cents(input.faceAmount);
  if (!face.gt(0)) rejectEdit("External shared invoice amount must be positive", "IC_CHARGE_INVALID", 422);
  return face;
}

/** A specific grant makes ordinary users eligible. Admin is not a default charge editor. */
export async function hasSharedChargeGrant(
  identity: EditIdentity,
  invoiceKey: string,
  relations: readonly number[],
  scopeSourceId: number
) {
  if (identity.initiatingCompanyId === scopeSourceId && ["Owner", "Developer"].includes(identity.actorRole))
    return true;
  const [member] = await db
    .select()
    .from(userCompanyRoles)
    .where(
      and(
        eq(userCompanyRoles.userId, identity.actorUserId),
        eq(userCompanyRoles.companyId, identity.initiatingCompanyId)
      )
    );
  if (!member && identity.actorRole !== "Developer") return false;
  const grants = await db
    .select()
    .from(intercompanyPermissionGrants)
    .where(
      and(
        eq(intercompanyPermissionGrants.userId, identity.actorUserId),
        eq(intercompanyPermissionGrants.grantingCompanyId, identity.initiatingCompanyId),
        eq(intercompanyPermissionGrants.permission, "shared_charge_editor"),
        isNull(intercompanyPermissionGrants.revokedAt),
        inArray(intercompanyPermissionGrants.relationshipId, [...relations])
      )
    );
  const invoiceGrant = grants.some((g) => g.scope === "invoice" && g.invoiceKey === invoiceKey);
  const relationshipCoverage = relations.every((id) =>
    grants.some((g) => g.scope === "relationship" && g.relationshipId === id)
  );
  return invoiceGrant || relationshipCoverage;
}

export async function lockSource(tx: DbTransaction, sourceCompanyId: number) {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(${IMPORT_LOCK}, ${sourceCompanyId})`);
}

export function poSplit(data: Awaited<ReturnType<typeof loadTradeTx>>, amount: Decimal) {
  const groups = data.source;
  const weights = groups.map((g) => cents(g.po.itemsTotal ?? "0"));
  return allocateByWeights(amount, weights).map((share, i) => ({ poId: groups[i].po.id, amount: share }));
}

/** Suggested allocation is purchase-value weighted, but is NEVER confirmed without user approval. */
export async function previewSharedChargeAllocation(
  input: {
    sourceCompanyId: number;
    tradeIds: number[];
    amount: string;
  },
  identity: EditIdentity
) {
  if (input.sourceCompanyId !== identity.initiatingCompanyId || !["Owner", "Developer"].includes(identity.actorRole)) {
    rejectEdit("Only the Properties Owner/Developer can create a shared invoice", "IC_CHARGE_FORBIDDEN", 403);
  }
  if (
    !Array.isArray(input.tradeIds) ||
    !input.tradeIds.length ||
    input.tradeIds.length > 100 ||
    new Set(input.tradeIds).size !== input.tradeIds.length ||
    !/^\d+(\.\d{1,2})?$/.test(input.amount)
  ) {
    rejectEdit("Select unique trade IDs and a cent-exact confirmed amount", "IC_CHARGE_INPUT", 422);
  }
  const face = cents(input.amount);
  if (!face.gt(0)) rejectEdit("Shared invoice amount must be positive");
  const tradeRows = await db.select().from(intercompanyTrades).where(inArray(intercompanyTrades.id, input.tradeIds));
  if (
    tradeRows.length !== input.tradeIds.length ||
    tradeRows.some((trade) => trade.sourceCompanyId !== input.sourceCompanyId || trade.state !== "active")
  ) {
    rejectEdit("All shared invoice containers must be active and belong to one Properties source");
  }
  return withTradeScope(
    identity,
    tradeRows.map((trade) => trade.destinationCompanyId),
    async () => {
      return db.transaction(async (tx) => {
        const records = [];
        for (const id of input.tradeIds) {
          const data = await loadTradeTx(tx, id, false);
          requireUnreceived(data);
          records.push({
            tradeId: id,
            version: data.trade.version,
            containerNumber: data.physical.containerNumber,
            weight: cents(data.physical.itemsTotal ?? "0"),
          });
        }
        const proposed = allocateByWeights(
          face,
          records.map((r) => r.weight)
        );
        return {
          faceAmount: face.toFixed(2),
          allocations: records.map((r, i) => ({
            tradeId: r.tradeId,
            containerNumber: r.containerNumber,
            expectedVersion: r.version,
            suggestedAmount: proposed[i].toFixed(2),
          })),
        };
      });
    }
  );
}
