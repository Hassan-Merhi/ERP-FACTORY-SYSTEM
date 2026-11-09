import { lazyRetry as lazy } from "@/lib/lazyRetry";
import { Switch, Route, Redirect } from "wouter";
import PropertiesRentalsHub from "@/pages/properties/PropertiesRentalsHub";
import { useCompany } from "@/contexts/CompanyContext";
import { canUsePropertiesCapability, PROPERTIES_LEGACY_RENTAL_REDIRECTS } from "@/properties/config/propertiesNavigation";
import { AccountingToolbox } from "@/lazyPages";

const PropertiesHelpTraining = lazy(() =>
  import("@/pages/HelpTrainingWorkspaces").then((m) => ({ default: m.PropertiesHelpTraining }))
);
import type { AuthenticatedUser } from "@/contracts/sessionContracts";
import {
  AccountGroups,
  AccountingOpenItems,
  CashBankReconciliation,
  MonetaryFxAccounting,
  UnifiedRentalAccounting,
  GroupConsolidationAccounting,
  HistoricalAccounting,
  ProfessionalFinancialStatements,
  FiscalCloseReview,
  UnifiedAccountingDashboard,
  UnifiedAccountingRollout,
  Agents,
  BalanceRepair,
  ChatbotSettings,
  CompanyDataReset,
  CompanyTransfer,
  DeletedItems,
  ImportCycleDiagnostics,
  InventoryRepair,
  MySettings,
  NetProfitDetails,
  OrphanedRecords,
  PropertiesAccounts,
  PropertiesAnalytics,
  PropertiesCreate,
  PropertiesDashboard,
  PropertiesDaybook,
  PropertiesLedgerMonthly,
  PropertiesLedgerVouchers,
  PropertiesSettings,
  PropertiesVoucherDetail,
  PropertiesVoucherEdit,
  PropertiesVouchers,
} from "@/lazyPages";

interface PropertiesRoutesProps {
  user: Pick<AuthenticatedUser, "role">;
}

/**
 * Route switch for the Properties company shell.
 * All canonical workspace routes live under `/properties/*`.
 */
export function PropertiesRoutes({ user }: PropertiesRoutesProps) {
  const { selectedCompany } = useCompany();
  const isAdmin = canUsePropertiesCapability("admin", user, selectedCompany);
  const isDeveloper = canUsePropertiesCapability("developer", user, selectedCompany);
  const canOpenPersonalSettings = canUsePropertiesCapability("personal", user, selectedCompany);

  return (
    <Switch>
      <Route path="/properties/help-training">{() => <PropertiesHelpTraining user={user} />}</Route>
      <Route path="/properties/dashboard" component={PropertiesDashboard} />
      <Route path="/properties/accounts" component={PropertiesAccounts} />
      {isDeveloper && <Route path="/properties/accounting/toolbox" component={AccountingToolbox} />}
      {isDeveloper && <Route path="/properties/accounting/open-items" component={AccountingOpenItems} />}
      {isDeveloper && <Route path="/properties/accounting/cash-bank" component={CashBankReconciliation} />}
      {isDeveloper && <Route path="/properties/accounting/monetary-fx" component={MonetaryFxAccounting} />}
      {isDeveloper && <Route path="/properties/accounting/rentals" component={UnifiedRentalAccounting} />}
      {isDeveloper && <Route path="/properties/accounting/consolidation" component={GroupConsolidationAccounting} />}
      {isDeveloper && <Route path="/properties/accounting/history" component={HistoricalAccounting} />}
      {isDeveloper && <Route path="/properties/accounting/statements" component={ProfessionalFinancialStatements} />}
      {isDeveloper && <Route path="/properties/accounting/fiscal-review" component={FiscalCloseReview} />}
      {isDeveloper && <Route path="/properties/accounting/dashboard" component={UnifiedAccountingDashboard} />}
      {isDeveloper && <Route path="/properties/accounting/rollout" component={UnifiedAccountingRollout} />}
      <Route path="/properties/vouchers/:id/edit" component={PropertiesVoucherEdit} />
      <Route path="/properties/voucher-detail/:voucherId" component={PropertiesVoucherDetail} />
      <Route path="/properties/vouchers">{() => <PropertiesVouchers />}</Route>
      <Route path="/properties/create" component={PropertiesCreate} />
      <Route path="/properties/analytics" component={PropertiesAnalytics} />
      <Route path="/properties/agents" component={Agents} />
      <Route path="/properties/daybook" component={PropertiesDaybook} />

      <Route path="/properties/rentals" component={PropertiesRentalsHub} />
      <Route path="/properties/rental/warehouses">{() => <Redirect replace to={PROPERTIES_LEGACY_RENTAL_REDIRECTS["/properties/rental/warehouses"]} />}</Route>
      <Route path="/properties/rental/shops">{() => <Redirect replace to={PROPERTIES_LEGACY_RENTAL_REDIRECTS["/properties/rental/shops"]} />}</Route>
      <Route path="/properties/rental/payments">
        {() => <Redirect replace to={PROPERTIES_LEGACY_RENTAL_REDIRECTS["/properties/rental/payments"]} />}
      </Route>

      {isDeveloper && <Route path="/properties/transfer" component={CompanyTransfer} />}
      <Route path="/properties/ledger-monthly/:accountId" component={PropertiesLedgerMonthly} />
      <Route path="/properties/ledger-vouchers/:accountId/:year/:month" component={PropertiesLedgerVouchers} />
      {isAdmin && <Route path="/properties/settings" component={PropertiesSettings} />}
      {isAdmin && <Route path="/properties/net-position-details" component={NetProfitDetails} />}
      {isAdmin && <Route path="/properties/deleted-items" component={DeletedItems} />}
      {isAdmin && <Route path="/properties/orphaned-records" component={OrphanedRecords} />}
      {isAdmin && <Route path="/properties/chatbot-settings" component={ChatbotSettings} />}
      {isAdmin && <Route path="/properties/import-cycle-diagnostics" component={ImportCycleDiagnostics} />}
      {isAdmin && <Route path="/properties/inventory-repair" component={InventoryRepair} />}
      {isAdmin && <Route path="/properties/company-data-reset" component={CompanyDataReset} />}
      {isAdmin && <Route path="/properties/account-groups" component={AccountGroups} />}
      {isAdmin && <Route path="/properties/balance-repair" component={BalanceRepair} />}
      {canOpenPersonalSettings && <Route path="/properties/my-settings" component={MySettings} />}

      <Route>
        <Redirect replace to="/properties/daybook" />
      </Route>
    </Switch>
  );
}
