/**
 * The stats route modules live in this folder, but the registration order the
 * server actually runs is owned by ../statsRoutes.ts.
 *
 * This file used to keep its own copy of that list. The copy drifted: it
 * registered the compact Sales Report endpoints that the built client requests,
 * while the mounted registry did not, so /api/sales-report/summary fell through
 * to the SPA fallback and the Sales Report page rendered its error state. There
 * is now exactly one list, and this barrel only re-exports it so a future edit
 * cannot create a second, silently-dead registration path.
 */
export { registerStatsRoutes } from "../statsRoutes";
