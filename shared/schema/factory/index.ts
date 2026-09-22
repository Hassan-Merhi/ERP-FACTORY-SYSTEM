/**
 * factory schema, split by domain.
 *
 * Every part is re-exported here, so `@shared/schema` continues to expose
 * exactly the names it did before the split - which is the only thing that
 * has to hold, since these are declarations rather than ordered registrations.
 */
export * from "./production";
export * from "./suppliers-containers";
export * from "./raw-stock-mix";
export * from "./customer-orders";
export * from "./daybook-fx";
export * from "./workers-payroll";
export * from "./worker-bonuses";
export * from "./production-positions";
export * from "./bale-production-attribution";
export * from "./production-bonuses";
export * from "./settings-analytics";
export * from "./pos-transport";
export * from "./loading-shipping";
export * from "./dispatch-recode";
export * from "./container-planner";
export * from "./ais-vessel-tracking";
export * from "./ais-position-history";
