/**
 * Non-serializable markers for trusted server-side POS edit flows.
 * JSON clients cannot manufacture symbol-keyed properties, so these are safe
 * for narrowly-scoped internal overrides that must never be request-controlled.
 */
export const POS_INTERNAL_TOTAL_SALES_OVERRIDE = Symbol("pos-internal-total-sales-override");
