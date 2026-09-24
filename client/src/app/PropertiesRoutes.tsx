import { Switch, Route, Redirect } from "wouter";
import PropertiesRentalsHub from "@/pages/properties/PropertiesRentalsHub";
import type { AuthenticatedUser } from "@/contracts/sessionContracts";
import {
  AccountGroups,
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
  const isAdmin = user.role === "Admin" || user.role === "Developer";
  const isOwner = user.role === "Owner";

  return (
    <Switch>
      <Route path="/properties/dashboard" component={PropertiesDashboard} />
      <Route path="/properties/accounts" component={PropertiesAccounts} />
      <Route path="/properties/vouchers/:id/edit" component={PropertiesVoucherEdit} />
      <Route path="/properties/voucher-detail/:voucherId" component={PropertiesVoucherDetail} />
      <Route path="/properties/vouchers">{() => <PropertiesVouchers />}</Route>
      <Route path="/properties/create" component={PropertiesCreate} />
      {isOwner ? (
        <Route path="/properties/analytics">
          <Redirect replace to="/properties/daybook" />
        </Route>
      ) : (
        <Route path="/properties/analytics" component={PropertiesAnalytics} />
      )}
      <Route path="/properties/agents" component={Agents} />
      <Route path="/properties/daybook" component={PropertiesDaybook} />

      <Route path="/properties/rentals" component={PropertiesRentalsHub} />
      <Route path="/properties/rental/warehouses">{() => <Redirect replace to="/properties/rentals" />}</Route>
      <Route path="/properties/rental/shops">{() => <Redirect replace to="/properties/rentals?tab=shops" />}</Route>
      <Route path="/properties/rental/payments">
        {() => <Redirect replace to="/properties/rentals?tab=payments" />}
      </Route>

      {user?.role === "Developer" && <Route path="/properties/transfer" component={CompanyTransfer} />}
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
      <Route path="/properties/my-settings" component={MySettings} />

      <Route>
        <Redirect replace to="/properties/daybook" />
      </Route>
    </Switch>
  );
}
