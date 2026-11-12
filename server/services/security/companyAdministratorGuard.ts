/**
 * Company administrator safety rules for role assignment changes.
 *
 * - The last Admin of a company cannot be demoted or removed: the company
 *   would be left with nobody who can manage its users and permissions.
 *   Developer is a cross-company support role and does not count.
 * - A person cannot change or remove their OWN company role (only another
 *   administrator, or a Developer, can), so nobody authorizes themselves.
 *
 * The last-Admin check locks the company's Admin rows inside the caller's
 * transaction, so two administrators demoting each other at the same moment
 * cannot both succeed.
 */
import { sql } from "drizzle-orm";

export const COMPANY_ADMIN_ROLE = "Admin";

export class CompanyAdministratorGuardError extends Error {
  constructor(
    public readonly status: 403 | 409,
    public readonly code: "LAST_COMPANY_ADMINISTRATOR" | "SELF_ROLE_CHANGE_FORBIDDEN",
    message: string
  ) {
    super(message);
    this.name = "CompanyAdministratorGuardError";
  }
}

/**
 * True when changing `targetRowId` (currently `targetRole`) to `nextRole`
 * (null = removed) leaves the company without any Admin row, given the ids of
 * the company's Admin rows before the change.
 */
export function wouldRemoveLastAdministrator(input: {
  adminRowIds: readonly number[];
  targetRowId: number;
  targetRole: string;
  nextRole: string | null;
}): boolean {
  if (input.targetRole !== COMPANY_ADMIN_ROLE) return false;
  if (input.nextRole === COMPANY_ADMIN_ROLE) return false;
  const remaining = input.adminRowIds.filter((id) => id !== input.targetRowId);
  // A company that has no Admin rows at all (Developer-managed) is not made
  // worse by this change; only removing the final Admin is refused.
  return input.adminRowIds.includes(input.targetRowId) && remaining.length === 0;
}

/** Refuse a non-Developer changing or removing their own role assignment. */
export function refuseSelfRoleChange(input: {
  actorUserId: string | null | undefined;
  actorRole: string | null | undefined;
  targetUserId: string;
  previousRole: string;
  nextRole: string | null | undefined;
  removing: boolean;
}): CompanyAdministratorGuardError | null {
  if (input.actorRole === "Developer") return null;
  if (!input.actorUserId || input.actorUserId !== input.targetUserId) return null;
  const roleChanges = input.removing || (input.nextRole !== undefined && input.nextRole !== input.previousRole);
  if (!roleChanges) return null;
  return new CompanyAdministratorGuardError(
    403,
    "SELF_ROLE_CHANGE_FORBIDDEN",
    "You cannot change or remove your own company role. Ask another administrator."
  );
}

type SqlExecutor = { execute: (query: ReturnType<typeof sql>) => Promise<{ rows: unknown[] }> };

/**
 * Lock the company's Admin rows in the current transaction and refuse a change
 * that would leave the company without one.
 */
export async function assertCompanyKeepsAdministrator(
  tx: SqlExecutor,
  input: { companyId: number; targetRowId: number; targetRole: string; nextRole: string | null }
): Promise<void> {
  if (input.targetRole !== COMPANY_ADMIN_ROLE || input.nextRole === COMPANY_ADMIN_ROLE) return;
  const result = await tx.execute(
    sql`SELECT id FROM user_company_roles WHERE company_id = ${input.companyId} AND role = ${COMPANY_ADMIN_ROLE} ORDER BY id FOR UPDATE`
  );
  const adminRowIds = result.rows.map((row) => Number((row as { id: unknown }).id));
  if (
    wouldRemoveLastAdministrator({
      adminRowIds,
      targetRowId: input.targetRowId,
      targetRole: input.targetRole,
      nextRole: input.nextRole,
    })
  ) {
    throw new CompanyAdministratorGuardError(
      409,
      "LAST_COMPANY_ADMINISTRATOR",
      "This is the company's last administrator. Assign another Admin before changing or removing this role."
    );
  }
}
