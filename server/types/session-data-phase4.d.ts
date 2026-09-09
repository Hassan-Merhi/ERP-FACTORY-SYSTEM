import "express-session";

declare module "express-session" {
  interface SessionData {
    csrfToken?: string;
    role?: string;
    factoryRole?: string;
    /** Epoch ms until which a factory admin override grants elevated access. */
    factoryAdminOverrideUntil?: number;
    /** Username of the admin whose credentials opened the override window. */
    factoryAdminOverrideBy?: string;
    /** Cached display name for the pinned factory company (hint only). */
    factoryCompanyName?: string;
    currentCompanyName?: string | null;
    ip?: string | null;
    userAgent?: string | null;
    loginAt?: string;
    name?: string;
    email?: string;
    passkeyChallenge?: string;
    /**
     * Named security permissions cached on the session by
     * hydrateSessionNamedPermissions, together with the company they were
     * loaded for. Both are written by that function and read by every named
     * permission check; declaring them here removes the `SecuritySession`
     * casts each security adapter used to redeclare for itself.
     */
    securityPermissions?: string[];
    securityPermissionsCompanyId?: number | null;
    user?: {
      role?: string;
    };
  }
}
