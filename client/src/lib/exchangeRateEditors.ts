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
