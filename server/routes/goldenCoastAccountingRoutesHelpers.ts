// Extracted from ./goldenCoastAccountingRoutes.ts
import type { Request, Response } from "express";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { bankAccounts, companies, ledgerAccounts, locations, voucherEntries, vouchers } from "@shared/schema";
import { db } from "../db";
import { getErrorMessage } from "../lib/httpHandlers";
import { logger } from "../lib/logger";
import { type CentralPostingResult } from "../services/accounting/centralPostingEngine";
import {
  GOLDEN_COAST_PHASE1_ACCOUNT_DEFS,
  GOLDEN_COAST_PHASE1_LEDGER_SUBTYPES,
  GoldenCoastPhase1InputError,
  buildGoldenCoastPhase1Preview,
} from "../services/accounting/goldenCoastPhase1Posting";

export type PersistedPostingResult = CentralPostingResult<
  typeof vouchers.$inferSelect,
  typeof voucherEntries.$inferSelect
>;

export type DatabaseTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function assertGoldenCoastAccountingCompany(companyId: number): Promise<void> {
  const [company] = await db
    .select({ id: companies.id, companyType: companies.companyType, baseCurrency: companies.baseCurrency })
    .from(companies)
    .where(eq(companies.id, companyId))
    .limit(1);

  if (!company) throw new GoldenCoastPhase1InputError("Selected company was not found");
  if (company.companyType !== "supplier_partner") {
    throw new GoldenCoastPhase1InputError("Golden Coast Phase 1 accounting requires a supplier_partner company");
  }
  if (String(company.baseCurrency ?? "USD").toUpperCase() !== "USD") {
    throw new GoldenCoastPhase1InputError("Golden Coast Phase 1 accounting currently requires USD as base currency");
  }
}

export function selectedCompanyId(req: Request): number {
  const companyId = Number(req.session.currentCompanyId);
  if (!Number.isInteger(companyId) || companyId <= 0) {
    throw new GoldenCoastPhase1InputError("No company selected");
  }
  return companyId;
}

function accountOverrides(value: unknown): Map<string, { code?: string; name?: string }> {
  if (value == null) return new Map();
  if (!Array.isArray(value)) throw new GoldenCoastPhase1InputError("accounts must be an array when supplied");

  const allowed = new Set(GOLDEN_COAST_PHASE1_LEDGER_SUBTYPES);
  const result = new Map<string, { code?: string; name?: string }>();
  for (const raw of value) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new GoldenCoastPhase1InputError("Each account override must be an object");
    }
    const input = raw as Record<string, unknown>;
    const subType = typeof input.subType === "string" ? input.subType.trim() : "";
    if (!subType || !allowed.has(subType)) {
      throw new GoldenCoastPhase1InputError(`Unknown Phase 1 account subType: ${subType || "(missing)"}`);
    }
    const code = typeof input.code === "string" && input.code.trim() ? input.code.trim() : undefined;
    const name = typeof input.name === "string" && input.name.trim() ? input.name.trim() : undefined;
    result.set(subType, { code, name });
  }
  return result;
}

export async function handlePhase1SetupAccounts(req: Request, res: Response): Promise<void> {
  try {
    const companyId = selectedCompanyId(req);
    await assertGoldenCoastAccountingCompany(companyId);
    const overrides = accountOverrides(req.body?.accounts);

    const result = await db.transaction(async (tx) => {
      await tx
        .update(ledgerAccounts)
        .set({ active: true, deletedAt: null })
        .where(
          and(
            eq(ledgerAccounts.companyId, companyId),
            inArray(ledgerAccounts.subType, GOLDEN_COAST_PHASE1_LEDGER_SUBTYPES)
          )
        );

      const existingRows = await tx
        .select({
          id: ledgerAccounts.id,
          subType: ledgerAccounts.subType,
          code: ledgerAccounts.code,
          name: ledgerAccounts.name,
        })
        .from(ledgerAccounts)
        .where(
          and(
            eq(ledgerAccounts.companyId, companyId),
            inArray(ledgerAccounts.subType, GOLDEN_COAST_PHASE1_LEDGER_SUBTYPES),
            eq(ledgerAccounts.active, true),
            isNull(ledgerAccounts.deletedAt)
          )
        );
      const existingBySubType = new Map(existingRows.map((row) => [row.subType, row]));
      const created: Array<{ id: number; subType: string; code: string; name: string }> = [];

      for (const definition of GOLDEN_COAST_PHASE1_ACCOUNT_DEFS) {
        if (existingBySubType.has(definition.subType)) continue;
        const override = overrides.get(definition.subType);
        const [account] = await tx
          .insert(ledgerAccounts)
          .values({
            companyId,
            code: override?.code ?? definition.code,
            name: override?.name ?? definition.name,
            accountType: definition.accountType,
            subType: definition.subType,
            active: true,
          })
          .returning({
            id: ledgerAccounts.id,
            subType: ledgerAccounts.subType,
            code: ledgerAccounts.code,
            name: ledgerAccounts.name,
          });
        created.push({
          id: Number(account.id),
          subType: String(account.subType),
          code: account.code,
          name: account.name,
        });
      }

      return { existing: existingRows, created };
    });

    res.json({ success: true, ...result });
  } catch (error: unknown) {
    if (error instanceof GoldenCoastPhase1InputError) {
      res.status(400).json({ message: error.message, code: "GC_PHASE1_INPUT_INVALID" });
      return;
    }
    logger.error("Golden Coast Phase 1 account setup failed", { error });
    res.status(500).json({ message: getErrorMessage(error) });
  }
}

export async function handlePhase1Preview(req: Request, res: Response): Promise<void> {
  try {
    const companyId = selectedCompanyId(req);
    await assertGoldenCoastAccountingCompany(companyId);
    res.json(buildGoldenCoastPhase1Preview(req.body?.event));
  } catch (error: unknown) {
    if (error instanceof GoldenCoastPhase1InputError) {
      res.status(400).json({ message: error.message, code: "GC_PHASE1_INPUT_INVALID" });
      return;
    }
    logger.error("Golden Coast Phase 1 preview failed", { error });
    res.status(500).json({ message: getErrorMessage(error) });
  }
}

export async function handlePhase1Accounts(req: Request, res: Response): Promise<void> {
  try {
    const companyId = selectedCompanyId(req);
    await assertGoldenCoastAccountingCompany(companyId);

    const [phase1Ledgers, cashLedgers, banks, companyLocations] = await Promise.all([
      db
        .select({
          id: ledgerAccounts.id,
          code: ledgerAccounts.code,
          name: ledgerAccounts.name,
          accountType: ledgerAccounts.accountType,
          subType: ledgerAccounts.subType,
        })
        .from(ledgerAccounts)
        .where(
          and(
            eq(ledgerAccounts.companyId, companyId),
            eq(ledgerAccounts.active, true),
            isNull(ledgerAccounts.deletedAt),
            inArray(ledgerAccounts.subType, GOLDEN_COAST_PHASE1_LEDGER_SUBTYPES)
          )
        ),
      db
        .select({
          id: ledgerAccounts.id,
          code: ledgerAccounts.code,
          name: ledgerAccounts.name,
          accountType: ledgerAccounts.accountType,
          subType: ledgerAccounts.subType,
        })
        .from(ledgerAccounts)
        .where(
          and(
            eq(ledgerAccounts.companyId, companyId),
            eq(ledgerAccounts.active, true),
            isNull(ledgerAccounts.deletedAt),
            inArray(ledgerAccounts.accountType, ["Cash", "Bank"])
          )
        ),
      db
        .select({
          id: bankAccounts.id,
          code: bankAccounts.code,
          name: bankAccounts.name,
          bankName: bankAccounts.bankName,
        })
        .from(bankAccounts)
        .where(
          and(eq(bankAccounts.companyId, companyId), eq(bankAccounts.active, true), isNull(bankAccounts.deletedAt))
        ),
      db
        .select({ id: locations.id, code: locations.code, name: locations.name })
        .from(locations)
        .where(and(eq(locations.companyId, companyId), eq(locations.active, true), isNull(locations.deletedAt))),
    ]);

    const foundSubTypes = new Set(phase1Ledgers.map((account) => account.subType).filter(Boolean));
    const missingRequiredSubTypes = GOLDEN_COAST_PHASE1_LEDGER_SUBTYPES.filter(
      (subType) => !foundSubTypes.has(subType)
    );

    res.json({
      ledgerAccounts: phase1Ledgers,
      cashLedgerAccounts: cashLedgers,
      bankAccounts: banks,
      locations: companyLocations,
      missingRequiredSubTypes,
    });
  } catch (error: unknown) {
    if (error instanceof GoldenCoastPhase1InputError) {
      res.status(400).json({ message: error.message, code: "GC_PHASE1_INPUT_INVALID" });
      return;
    }
    logger.error("Golden Coast Phase 1 account lookup failed", { error });
    res.status(500).json({ message: getErrorMessage(error) });
  }
}
