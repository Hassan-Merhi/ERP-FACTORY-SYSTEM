import type { Express } from "express";
import { getErrorMessage } from "../lib/httpHandlers";
import { requireAuth } from "../auth";
import { getLedgerParentGroupOptions } from "../services/ledgerAccountOptionsService";
import { registerLedgerAccountPaginationRoutes } from "./ledgerAccountPaginationRoutes";
import { registerAccountTransactionPaginationRoutes } from "./accountTransactionPaginationRoutes";
import { registerLedgerRoutes as registerLegacyLedgerRoutes } from "./ledger";
import { normalizeAccountOpeningBalance, registerAccountCurrencyRoutes } from "./accountCurrencyRoutes";
import { registerHistoricalCurrencyGuardRoutes } from "./historicalCurrencyGuardRoutes";
import { registerHistoricalCurrencyRepairCenterRoutes } from "./historicalCurrencyRepairCenterRoutes";
import { registerVoucherEntryCurrencyEditRoutes } from "./voucherEntryCurrencyEditRoutes";
import { registerOpeningBalanceResolutionRoutes } from "./openingBalanceResolutionRoutes";
import { registerGoldenCoastSystemAccountPresentation } from "./goldenCoastSystemAccountPresentation";

export function registerLedgerRoutes(app: Express) {
  // This module registers before the legacy bank/account/report/voucher-entry routes.
  // Install write normalization, safe reads, historical-report readiness guards,
  // the controlled repair center, explicit legacy resolution, and the dual-currency
  // editor here so existing URLs remain compatible.
  app.use(normalizeAccountOpeningBalance);
  registerGoldenCoastSystemAccountPresentation(app);
  registerHistoricalCurrencyGuardRoutes(app);
  registerHistoricalCurrencyRepairCenterRoutes(app);
  registerAccountCurrencyRoutes(app);
  registerOpeningBalanceResolutionRoutes(app);
  registerVoucherEntryCurrencyEditRoutes(app);

  app.get("/api/ledger-accounts/parent-groups", requireAuth, async (req, res) => {
    try {
      const requestedCompanyId =
        typeof req.query.companyId === "string" ? Number.parseInt(req.query.companyId, 10) : undefined;
      const sessionCompanyId = req.session.currentCompanyId;
      const companyId = requestedCompanyId || sessionCompanyId;

      if (!companyId) {
        return res.status(400).json({ message: "No company selected" });
      }
      if (requestedCompanyId && sessionCompanyId && requestedCompanyId !== sessionCompanyId) {
        return res.status(403).json({ message: "Access denied for selected company" });
      }

      const options = await getLedgerParentGroupOptions(companyId, req.query.includeHidden === "true");
      return res.json(options);
    } catch (error: unknown) {
      return res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // These native readers register before AccountRoutes later installs its legacy
  // compatibility handlers, so explicit page requests are SQL-bounded end to end.
  registerAccountTransactionPaginationRoutes(app);
  registerLedgerAccountPaginationRoutes(app);
  registerLegacyLedgerRoutes(app);
}
