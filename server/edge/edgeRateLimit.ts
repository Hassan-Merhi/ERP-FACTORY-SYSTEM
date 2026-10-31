/**
 * Rate limits for the factory edge routes. Direct express-rate-limit
 * constructions (not a wrapper) so static analysis can see them.
 */
import rateLimit from "express-rate-limit";

/** LAN identity probe and per-operation status lookups. */
export const edgeStatusRateLimit = rateLimit({
  windowMs: 60_000,
  max: 240,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => res.status(429).json({ code: "EDGE_STATUS_RATE_LIMITED" }),
});

/** Signed LAN -> cloud staging and receipt queries (batched, a few per minute). */
export const edgeSyncRateLimit = rateLimit({
  windowMs: 60_000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => res.status(429).json({ code: "EDGE_SYNC_RATE_LIMITED" }),
});
