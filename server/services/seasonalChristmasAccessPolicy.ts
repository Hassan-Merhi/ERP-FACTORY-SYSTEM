/**
 * Christmas Mode is opt-in, not a company-wide entitlement.
 *
 * A developer enables the master flag and chooses an explicit allowlist of
 * user IDs. Missing/malformed settings fail closed: an existing globally ON
 * value from the old feature must never expose decorations to every user.
 */
export const CHRISTMAS_MASTER_KEY = "christmas_mode_enabled";
export const CHRISTMAS_ALLOWED_USERS_KEY = "christmas_mode_allowed_user_ids";

export function parseChristmasAllowedUserIds(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    if (parsed.length > 5000) return [];
    if (!parsed.every((id) => typeof id === "string" && id.length > 0 && id.length <= 128)) return [];
    return [...new Set(parsed as string[])];
  } catch {
    return [];
  }
}

export function christmasModeEnabledForUser(
  masterValue: string | null | undefined,
  allowedIdsRaw: string | null | undefined,
  userId: string | null | undefined,
): boolean {
  if (masterValue !== "true" || !userId) return false;
  return parseChristmasAllowedUserIds(allowedIdsRaw).includes(userId);
}
