/**
 * erp schema, split by domain.
 *
 * Every part is re-exported here, so `@shared/schema` continues to expose
 * exactly the names it did before the split - which is the only thing that
 * has to hold, since these are declarations rather than ordered registrations.
 */
export * from "./parties";
export * from "./vouchers";
export * from "./recurring-journals";
export * from "./accounting-posting-requests";
export * from "./stock-movements";
export * from "./sales-intercompany";
export * from "./payroll-advances";
export * from "./dashboards";
export * from "./ai";
export * from "./documents";
export * from "./worker-payroll";
export * from "./accounts-reservations";
export * from "./status-reporting";
export * from "./agents-approvals";
export * from "./alerts-notifications";
