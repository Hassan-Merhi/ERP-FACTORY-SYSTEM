/**
 * Identity of the Golden Coast Phase 11 monthly close, in a leaf module.
 *
 * The close planner and the central posting engine both need this value: the
 * planner stamps it on the posting request, and the engine's finalized-period
 * guard matches against it to decide whether a month is frozen. The engine
 * cannot import it from the planner — that would close a runtime cycle,
 * because the planner reaches `genericVoucherPosting`, which imports
 * `PostingValidationError` as a value from the engine.
 *
 * Keeping it here, with no imports of its own, lets both sides share one
 * definition. Duplicating the literal instead would let a rename silently
 * stop freezing finalized periods.
 */
export const GOLDEN_COAST_PHASE11_SOURCE_TYPE = "golden-coast-phase11-monthly-close";
