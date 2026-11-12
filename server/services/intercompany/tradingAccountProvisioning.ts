/**
 * Transactional, idempotent provisioning for a Properties -> ERP container
 * trading pair. This only provisions master data and the mapping policy:
 * it never writes voucher entries, stock, opening balances, or cash.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  companies,
  intercompanyAuditEvents,
  intercompanyRelationshipPolicies,
  intercompanyTrades,
  ledgerAccounts,
} from "@shared/schema";
import { companyScopedSuppliers } from "@shared/schema/supplierCompanyScope";
import { db } from "../../db";
import { logAudit } from "../../routes/_helpers";
import { classifyAccountType } from "../accounting/accountClassification";
import { eligibleDestinations, withinTrustedPair } from "./containerTradingImport";
import { TradingImportError } from "./containerTradingWorkbook";
import {
  normalizedTradingName,
  propertiesSupplierCode,
  tradingAccountSpecs,
  uniquePropertiesSupplier,
  type TradingAccountKey,
  type TradingAccountSpec,
} from "./tradingProvisioningPlan";

type AccountRow = typeof ledgerAccounts.$inferSelect;
type SupplierRow = typeof companyScopedSuppliers.$inferSelect;
type Policy = typeof intercompanyRelationshipPolicies.$inferSelect;
type Mapping = Record<TradingAccountKey, number>;

const PROVISIONING_LOCK = 741235; // Same source-level transaction lock as manual setup and import.
const invalid = (message: string) => new TradingImportError(409, message, "INTERCOMPANY_SETUP_CONFLICT");

function usableAccount(account: AccountRow | undefined, spec: TradingAccountSpec): account is AccountRow {
  return Boolean(
    account &&
      account.companyId === spec.companyId &&
      account.deletedAt === null &&
      account.active &&
      classifyAccountType(account.accountType, account.subType) === spec.accountType.toLowerCase()
  );
}

function validatedMappedAccount(
  accounts: AccountRow[],
  spec: TradingAccountSpec,
  id: number
): AccountRow {
  const account = accounts.find((entry) => entry.id === id);
  if (!usableAccount(account, spec)) {
    throw invalid(`Mapped ${spec.field} account is inactive, misclassified, or belongs to another company`);
  }
  return account;
}

function supplierForPolicy(suppliers: SupplierRow[], policy: Policy, sourceName: string): SupplierRow {
  const supplier = suppliers.find((entry) => entry.id === policy.destinationSupplierId);
  if (!supplier || !supplier.active || supplier.deletedAt || normalizedTradingName(supplier.legalName) !== normalizedTradingName(sourceName)) {
    throw invalid("Existing destination Properties supplier is missing, inactive, or has a different name");
  }
  return supplier;
}

export async function autoProvisionTradingRelationship(args: {
  sourceCompanyId: number;
  destinationCompanyId: number;
  userId: string;
  username: string;
  role: string;
}) {
  const { sourceCompanyId, destinationCompanyId, userId, username, role } = args;
  const allowed = await eligibleDestinations(sourceCompanyId, userId, role);
  if (!allowed.some((company) => company.id === destinationCompanyId)) {
    throw new TradingImportError(403, "Destination company is not authorized", "INTERCOMPANY_DESTINATION_FORBIDDEN");
  }

  return withinTrustedPair(sourceCompanyId, [destinationCompanyId], () =>
    db.transaction(async (tx) => {
      // Serializes concurrent initial setup, manual mapping, and import for a source.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${PROVISIONING_LOCK}::integer, ${sourceCompanyId}::integer)`);

      const [source, destination] = await Promise.all([
        tx.select().from(companies).where(eq(companies.id, sourceCompanyId)),
        tx.select().from(companies).where(eq(companies.id, destinationCompanyId)),
      ]).then(([sources, destinations]) => [sources[0], destinations[0]]);
      if (!source?.active || source.companyType !== "properties" || !destination?.active || destination.companyType !== "erp") {
        throw invalid("Trading requires an active Properties company and an active ERP destination");
      }
      if ((source.baseCurrency || "USD").toUpperCase() !== "USD" ||
          (destination.baseCurrency || "USD").toUpperCase() !== "USD") {
        throw invalid("Intercompany container setup currently supports USD-base companies only");
      }
      if (!normalizedTradingName(source.name)) throw invalid("The Properties company must have a valid legal name");

      const [existing] = await tx
        .select()
        .from(intercompanyRelationshipPolicies)
        .where(
          and(
            eq(intercompanyRelationshipPolicies.sourceCompanyId, sourceCompanyId),
            eq(intercompanyRelationshipPolicies.destinationCompanyId, destinationCompanyId),
            eq(intercompanyRelationshipPolicies.relationshipType, "container_trade")
          )
        );

      const accounts = await tx
        .select()
        .from(ledgerAccounts)
        .where(inArray(ledgerAccounts.companyId, [sourceCompanyId, destinationCompanyId]));
      const suppliers = await tx
        .select()
        .from(companyScopedSuppliers)
        .where(eq(companyScopedSuppliers.companyId, destinationCompanyId));
      const specs = tradingAccountSpecs(source, destination);

      // Completed mappings are immutable through the auto-provisioning action.
      // A repeated click must never rewrite a historical mapping or create an audit version.
      if (existing?.tradeEnabled && specs.every((spec) => existing[spec.field] !== null) &&
          existing.destinationSupplierId !== null) {
        for (const spec of specs) validatedMappedAccount(accounts, spec, existing[spec.field]!);
        const supplier = supplierForPolicy(suppliers, existing, source.name);
        return {
          relationshipId: existing.id,
          sourceCompanyId,
          destinationCompanyId,
          tradeEnabled: true,
          status: "already_ready" as const,
          createdAccounts: 0,
          reusedAccounts: specs.length,
          createdSupplier: false,
          supplierId: supplier.id,
        };
      }

      if (existing) {
        const trades = await tx
          .select({ id: intercompanyTrades.id })
          .from(intercompanyTrades)
          .where(eq(intercompanyTrades.relationshipId, existing.id))
          .limit(1);
        if (trades.length) throw invalid("Relationship has historical trades; its account mapping cannot be changed");
      }

      const resolved = {} as Mapping;
      const created: AccountRow[] = [];
      let reusedAccounts = 0;
      for (const spec of specs) {
        const mappedId = existing?.[spec.field];
        if (mappedId !== undefined && mappedId !== null) {
          resolved[spec.field] = validatedMappedAccount(accounts, spec, mappedId).id;
          reusedAccounts += 1;
          continue;
        }

        const matches = accounts.filter((entry) => entry.companyId === spec.companyId && entry.code === spec.code);
        if (matches.length > 1) throw invalid(`Duplicate ledger code ${spec.code} in company ${spec.companyId}`);
        const match = matches[0];
        if (match) {
          if (!usableAccount(match, spec)) {
            throw invalid(`Ledger code ${spec.code} already exists with the wrong type or an inactive/deleted record`);
          }
          resolved[spec.field] = match.id;
          reusedAccounts += 1;
          continue;
        }

        const [newAccount] = await tx
          .insert(ledgerAccounts)
          .values({
            companyId: spec.companyId,
            code: spec.code,
            name: spec.name,
            accountType: spec.accountType,
            active: true,
            openingBalance: "0",
          })
          .returning();
        accounts.push(newAccount);
        created.push(newAccount);
        resolved[spec.field] = newAccount.id;
      }
      if (resolved.sourcePurchaseAccountId === resolved.sourceCostAccountId) {
        throw invalid("Purchases and COGS must be different accounts");
      }

      let destinationSupplier: SupplierRow | undefined;
      if (existing?.destinationSupplierId != null) {
        destinationSupplier = supplierForPolicy(suppliers, existing, source.name);
      } else {
        try {
          destinationSupplier = uniquePropertiesSupplier(suppliers, source.name);
        } catch (error) {
          throw invalid(error instanceof Error ? error.message : "Ambiguous destination supplier");
        }
      }

      let createdSupplier = false;
      if (!destinationSupplier) {
        const code = propertiesSupplierCode(sourceCompanyId, destinationCompanyId);
        const collision = suppliers.find((entry) => entry.code === code);
        if (collision) {
          throw invalid("Reserved Properties supplier code is already used by another supplier: " + code);
        }
        const [supplier] = await tx
          .insert(companyScopedSuppliers)
          .values({
            companyId: destinationCompanyId,
            code,
            legalName: source.name,
            email: "",
            openingBalance: "0",
            active: true,
          })
          .returning();
        destinationSupplier = supplier;
        createdSupplier = true;
      }

      const mapping = {
        ...resolved,
        destinationSupplierId: destinationSupplier.id,
      };

      const [policy] = existing
        ? await tx
            .update(intercompanyRelationshipPolicies)
            .set({ ...mapping, tradeEnabled: true, baseCurrency: "USD", version: existing.version + 1, updatedAt: new Date() })
            .where(eq(intercompanyRelationshipPolicies.id, existing.id))
            .returning()
        : await tx
            .insert(intercompanyRelationshipPolicies)
            .values({
              sourceCompanyId,
              destinationCompanyId,
              relationshipType: "container_trade",
              tradeEnabled: true,
              baseCurrency: "USD",
              ...mapping,
            })
            .returning();

      for (const account of created) {
        await logAudit(
          {
            userId,
            username,
            companyId: account.companyId,
            action: "create",
            tableName: "ledger_accounts",
            recordId: account.id,
            recordIdentifier: account.code,
            changes: {
              name: { old: null, new: account.name },
              code: { old: null, new: account.code },
              accountType: { old: null, new: account.accountType },
              openingBalance: { old: null, new: "0" },
            },
          },
          tx
        );
      }
      if (createdSupplier) {
        await logAudit(
          {
            userId,
            username,
            companyId: destinationCompanyId,
            action: "create",
            tableName: "suppliers",
            recordId: destinationSupplier.id,
            recordIdentifier: destinationSupplier.legalName,
            changes: {
              name: { old: null, new: destinationSupplier.legalName },
              code: { old: null, new: destinationSupplier.code },
              openingBalance: { old: null, new: "0" },
            },
          },
          tx
        );
      }
      await tx.insert(intercompanyAuditEvents).values({
        eventKey: `ic-container-partner:${policy.id}:${policy.version}`,
        relationshipId: policy.id,
        sourceCompanyId,
        actorUserId: userId,
        eventType: "trading-relationship-auto-provisioned",
        sourceReference: "Owner/Developer automatic company-pair setup",
        payload: {
          destinationCompanyId,
          version: policy.version,
          accountMapping: mapping,
          createdAccountIds: created.map((account) => account.id),
          reusedAccounts,
          createdSupplier,
          supplierId: destinationSupplier.id,
          noOpeningBalancesOrVouchersPosted: true,
        },
      });

      return {
        relationshipId: policy.id,
        sourceCompanyId,
        destinationCompanyId,
        tradeEnabled: true,
        status: "configured" as const,
        createdAccounts: created.length,
        reusedAccounts,
        createdSupplier,
        supplierId: destinationSupplier.id,
      };
    })
  );
}
