import { Switch, Route, Redirect } from "wouter";
import {
  POS,
  LocationInventory,
  LocationMonthlySummary,
  LocationVouchers,
  POSDaybook,
  POSDashboard,
  POSCustomers,
  POSImport,
  Vouchers,
  Chat,
  POSSettings,
  POSPriceList,
  PosTransferOrders,
  POSContainerTracking,
  POSContainerDetail,
  RetailPOS,
  MySettings,
} from "@/lazyPages";
import type { AuthMe } from "@shared/apiTypes";
import { useCompany } from "@/contexts/CompanyContext";

interface PosRoutesProps {
  user: AuthMe;
  posImportEnabled?: boolean;
}

/**
 * Route tree for POS users.
 * Rendered by AppRoutes when user.role === "POS".
 * No auth checks beyond that — Router already guards the entry point.
 */
export function PosRoutes({ user, posImportEnabled }: PosRoutesProps) {
  const { selectedCompany } = useCompany();

  if (selectedCompany?.companyType === "retail") {
    return (
      <Switch>
        <Route path="/">{() => <RetailPOS />}</Route>
        <Route path="/pos">{() => <RetailPOS />}</Route>
        <Route path="/retail/pos">{() => <RetailPOS />}</Route>
        <Route path="/my-settings" component={MySettings} />
        <Route>{() => <Redirect to="/" />}</Route>
      </Switch>
    );
  }

  return (
    <Switch>
      <Route path="/">{() => <POSContainerTracking posUser={user} />}</Route>
      <Route path="/pos">{() => <POS posUser={user} />}</Route>
      <Route path="/pos/edit/:id">{(params) => <POS posUser={user} editVoucherId={params.id} />}</Route>
      <Route path="/pos-containers/:id">{() => <POSContainerDetail />}</Route>
      <Route path="/pos-containers">{() => <POSContainerTracking posUser={user} />}</Route>
      <Route path="/location-inventory">{() => <LocationInventory posUser={user} />}</Route>
      <Route path="/locations/:locationId/stock-items/:stockItemId/history">
        {() => <LocationMonthlySummary posUser={user} />}
      </Route>
      <Route path="/locations/:locationId/stock-items/:stockItemId/vouchers/:year/:month">
        {() => <LocationVouchers posUser={user} />}
      </Route>
      <Route path="/pos-daybook" component={POSDaybook} />
      <Route path="/pos-dashboard">{() => <POSDashboard posUser={user} />}</Route>
      <Route path="/pos-customers">{() => <POSCustomers />}</Route>
      <Route path="/pos-import">{() => (posImportEnabled ? <POSImport /> : <Redirect to="/" />)}</Route>
      <Route path="/vouchers">{() => <Vouchers posUser={user} />}</Route>
      <Route path="/pos-chat" component={Chat} />
      <Route path="/pos-settings" component={POSSettings} />
      <Route path="/pos-price-list">{() => <POSPriceList posUser={user} />}</Route>
      <Route path="/pos-transfer-orders">{() => <PosTransferOrders posUser={user} />}</Route>
      <Route path="/my-settings" component={MySettings} />
      <Route>{() => <Redirect to="/" />}</Route>
    </Switch>
  );
}
