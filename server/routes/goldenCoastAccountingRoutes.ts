import type { Express, Request, Response } from "express";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { bankAccounts, companies, ledgerAccounts, locations } from "@shared/schema";
import { requireAuth, requireNonPOS, requireRole } from "../auth";
import { db } from "../db";
import { getErrorMessage } from "../lib/httpHandlers";
import { logger } from "../lib/logger";
import {
  privilegedMutationRateLimit,
  privilegedReadRateLimit,
  privilegedRequestBudget,
} from "../middleware/privilegedEndpointSecurity";
import {
  GOLDEN_COAST_PHASE1_LEDGER_SUBTYPES,
  GoldenCoastPhase1InputError,
  buildGoldenCoastPhase1Preview,
} from "../services/accounting/goldenCoastPhase1Posting";
import { respondGoldenCoastPhase1Retired } from "./goldenCoastLegacyPostingRetirement";

/*
 * Phase 1 setup-accounts and post are retired: goldenCoastLegacyPostingRetirement
 * answers them with 410 before these routes. The routes stay registered (with
 * their original guards) and answer the same 410, so a path the retirement
 * mount does not match exactly (for example a trailing slash) cannot reach the
 * old posting logic, which has been removed. Lookup and preview stay live.
 */
const phase1RequestBudget = privilegedRequestBudget({ maxBodyBytes: 64 * 1024, maxCollectionItems: 50 });

async function assertGoldenCoastAccountingCompany(companyId: number): Promise<void> {
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

function selectedCompanyId(req: Request): number {
  const companyId = Number(req.session.currentCompanyId);
  if (!Number.isInteger(companyId) || companyId <= 0) {
    throw new GoldenCoastPhase1InputError("No company selected");
  }
  return companyId;
}

async function handlePhase1Preview(req: Request, res: Response): Promise<void> {
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

async function handlePhase1Accounts(req: Request, res: Response): Promise<void> {
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

export function registerGoldenCoastAccountingRoutes(app: Express): void {
  app.post(
    "/api/golden-coast/accounting/phase1/setup-accounts",
    privilegedMutationRateLimit,
    phase1RequestBudget,
    requireAuth,
    requireRole("Developer"),
    (req, res) => respondGoldenCoastPhase1Retired(req, res)
  );
  app.get(
    "/api/golden-coast/accounting/phase1/accounts",
    privilegedReadRateLimit,
    requireAuth,
    requireNonPOS,
    (req, res) => void handlePhase1Accounts(req, res)
  );
  app.post(
    "/api/golden-coast/accounting/phase1/preview",
    privilegedReadRateLimit,
    phase1RequestBudget,
    requireAuth,
    requireNonPOS,
    (req, res) => void handlePhase1Preview(req, res)
  );
  app.post(
    "/api/golden-coast/accounting/phase1/post",
    privilegedMutationRateLimit,
    phase1RequestBudget,
    requireAuth,
    requireNonPOS,
    (req, res) => respondGoldenCoastPhase1Retired(req, res)
  );
}
