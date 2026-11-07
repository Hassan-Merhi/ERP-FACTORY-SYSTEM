/**
 * Create Only assignment activation switch.
 *
 * The Create Only role is fully enforced on the server (global write guard,
 * canonical tenant-boundary check, per-route verified business actions and the
 * offline sync apply handlers). Assigning it to a person is a separate, explicit
 * release decision: it stays off until an operator sets
 * PERMISSIONS_V2_CREATE_ONLY_ASSIGNMENT=enabled after the release gates in
 * config/permissions-v2-release-readiness.json are verified.
 *
 * Turning the switch off again never widens anyone's access: people who already
 * hold the role keep the same fail-closed restrictions; only new assignments
 * are refused.
 */
export const CREATE_ONLY_ROLE = "Create Only";

export function isCreateOnlyAssignmentEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PERMISSIONS_V2_CREATE_ONLY_ASSIGNMENT === "enabled";
}

export interface CreateOnlyAssignmentRefusal {
  status: 409;
  code: "CREATE_ONLY_ASSIGNMENT_NOT_ACTIVATED";
  message: string;
}

/**
 * Returns a refusal when a request would newly grant Create Only while the
 * switch is off. Keeping an existing Create Only assignment unchanged, or
 * moving someone off the role, is always allowed.
 */
export function refuseInactiveCreateOnlyAssignment(
  input: { requestedRole: string | null | undefined; previousRole?: string | null },
  env: NodeJS.ProcessEnv = process.env
): CreateOnlyAssignmentRefusal | null {
  if (input.requestedRole !== CREATE_ONLY_ROLE) return null;
  if (input.previousRole === CREATE_ONLY_ROLE) return null;
  if (isCreateOnlyAssignmentEnabled(env)) return null;
  return {
    status: 409,
    code: "CREATE_ONLY_ASSIGNMENT_NOT_ACTIVATED",
    message: "The Create Only role is not activated for assignment yet.",
  };
}
