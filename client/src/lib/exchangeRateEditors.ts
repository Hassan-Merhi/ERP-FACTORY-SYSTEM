/**
 * Who may save or remove an exchange rate (accounting audit wave 14, owner
 * decision 2). The server enforces it (requireRole on POST /api/exchange-rates
 * and POST/DELETE /api/factory/fx-rates); the client only hides the editing
 * controls and the daily rate prompt from everyone else.
 */
export const EXCHANGE_RATE_EDITOR_ROLES: readonly string[] = ["Admin", "Owner", "Developer"];

export function canEditExchangeRates(role: string | null | undefined): boolean {
  return !!role && EXCHANGE_RATE_EDITOR_ROLES.includes(role);
}

/**
 * Who is prompted for, and may set, TODAY's company rate. The first user to
 * set it sets it for the whole company; only the editor roles above can change
 * it afterwards. View Only / Create Only and view-only POS users never save a rate.
 */
export function canSetDailyExchangeRate(role: string | null | undefined, posViewOnly?: boolean | null): boolean {
  return !!role && role !== "View Only" && role !== "Create Only" && !posViewOnly;
}
