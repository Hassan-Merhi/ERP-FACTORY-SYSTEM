/**
 * Shared state and helpers for the factoryStockAllocationV5Routes routes.
 *
 * Extracted verbatim from the former single-file factoryStockAllocationV5Routes.ts.
 */

// ─── V5 Guard Convention ─────────────────────────────────────────────────────
// V5 orders are identified by: customer_orders.proforma_id_used IS NOT NULL
// V2/V3 orders have proforma_id_used = null and must follow legacy bale lifecycle.
// Do NOT add a dedicated isV5Order column unless proforma_id_used proves unreliable.
// Every place this guard is applied, add the comment: "// V5 guard: proformaIdUsed IS NOT NULL"
// ─────────────────────────────────────────────────────────────────────────────

// ─── Status constants ────────────────────────────────────────────────────────
// Active order statuses from schema enum:
//   DRAFT | LOADING | PENDING_VERIFICATION | VERIFIED | FINALIZED | CANCELLED
//
// NOTE: These constants will be restructured in Phase B when the formula switches
// to customer_order_expected_lines (DRAFT only) and customer_order_bales (LOADING only).
// They are kept here temporarily for reference.
//
// expectedToLoad  — orders that represent real loading intent (excludes CANCELLED)
export const ACTIVE_ORDER_STATUSES = ["DRAFT", "LOADING", "PENDING_VERIFICATION", "VERIFIED", "FINALIZED"];

// totalLoaded     — bales that have been physically committed to a container
//                   (all statuses where bales were actually scanned in)

// V5 formula (Phase B — corrected):
//   stockAvailable  = IN_STOCK bales
//   totalLoaded     = bales scanned into LOADING containers (status = 'LOADING')
//   expectedToLoad  = remaining expected for DRAFT + LOADING containers:
//                       DRAFT:   expected_qty (loaded = 0)
//                       LOADING: max(expected_qty − loaded_qty, 0)
//   freeToPromise   = stockAvailable − expectedToLoad − totalLoaded
//     < 0 → shortage (need more bales)   → red
//     = 0 → exactly covered              → neutral
//     > 0 → surplus available            → green
