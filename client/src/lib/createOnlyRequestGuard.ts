/**
 * Client-side mirror of the server's Create Only write boundary.
 *
 * The server refuses every Create Only business write that is not a
 * handler-verified create, so this guard only spares the user a round trip and
 * gives one readable explanation before anything is sent or queued offline.
 * It never allows anything: when in doubt it lets the request through for the
 * server to decide. Frontend checks never replace backend enforcement.
 */
import { isCreateOnlyRole, isCreateOnlyVerifiedSignature } from "@shared/createOnlyRolePolicy";

export const CREATE_ONLY_CLIENT_DENIAL_MESSAGE =
  "This action is not available to Create Only users. You can add approved new records, but not change existing ones.";

const PASSIVE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
// Session, presence and remote-support transport writes are not business data.
const LIFECYCLE_PREFIXES = ["/api/auth/", "/api/user-presence", "/api/screen-feed"];

function pathOf(url: string): string {
  try {
    return new URL(url, "http://local.invalid").pathname;
  } catch {
    return url.split("?", 1)[0] ?? url;
  }
}

/** True when a Create Only user's request would be refused by the server. */
export function isCreateOnlyClientWriteBlocked(role: string | null | undefined, method: string, url: string): boolean {
  if (!isCreateOnlyRole(role)) return false;
  const verb = method.toUpperCase();
  if (PASSIVE_METHODS.has(verb)) return false;
  const path = pathOf(url);
  if (!path.toLowerCase().startsWith("/api/")) return false;
  if (LIFECYCLE_PREFIXES.some((prefix) => path.startsWith(prefix))) return false;
  return !isCreateOnlyVerifiedSignature(verb, path);
}

export class CreateOnlyActionNotAvailableError extends Error {
  readonly code = "BUSINESS_ACTION_NOT_VERIFIED";
  constructor() {
    super(CREATE_ONLY_CLIENT_DENIAL_MESSAGE);
    this.name = "CreateOnlyActionNotAvailableError";
  }
}
