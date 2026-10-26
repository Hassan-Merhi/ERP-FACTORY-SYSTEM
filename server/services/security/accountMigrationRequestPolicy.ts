/**
 * Intentional cross-company account picker for the Admin migration utility.
 * The endpoint still requires an authenticated session, an Admin/Developer
 * role, and canonical company membership in both the tenant param guard and
 * the migration handler. This classifier does not grant company membership.
 */
export function isAccountMigrationSourceReadPath(method: string, path: string): boolean {
  return method.toUpperCase() === "GET" && /^\/api\/admin\/account-migration\/accounts\/[1-9]\d*$/.test(path);
}

export function canReadAccountMigrationSource(method: string, path: string, role: string | null | undefined): boolean {
  return isAccountMigrationSourceReadPath(method, path) && (role === "Admin" || role === "Developer");
}
