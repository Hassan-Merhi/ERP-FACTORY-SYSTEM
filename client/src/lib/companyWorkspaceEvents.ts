/** UI-only safety signal; never changes the authenticated server session. */
export const COMPANY_WORKSPACE_TRANSITION_EVENT = "erp:company-workspace-transition";

/**
 * Cancel pending company-owned prompts before a new session may take effect.
 * The workspace itself is hidden by the CompanyProvider loading boundary.
 */
export function announceCompanyWorkspaceTransition(): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(COMPANY_WORKSPACE_TRANSITION_EVENT));
  }
}
