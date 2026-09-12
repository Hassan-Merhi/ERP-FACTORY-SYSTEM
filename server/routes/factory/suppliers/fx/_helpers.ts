/**
 * Container-payability predicate for the supplier FX routes.
 *
 * The former single-file supplierFxRoutes.ts carried a ~500-line preamble that
 * also defined buildBrokerStatement. Nothing in these routes ever called it -
 * it was one of three near-identical copies across the supplier route files -
 * so only the two symbols the FX handlers actually use are kept here.
 */
export const PAYABLE_CONTAINER_STATUSES = new Set(["OFFLOADED", "RECEIVED", "PARTIALLY_RECEIVED"]);

export const isPayableContainer = (c: Record<string, unknown>) => PAYABLE_CONTAINER_STATUSES.has(String(c.status || "").toUpperCase());
