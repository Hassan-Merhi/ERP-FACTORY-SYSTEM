/**
 * Christmas Mode is opt-in, not a company-wide entitlement.
 *
 * A developer enables the master flag and chooses an explicit allowlist of
 * user IDs. Missing/malformed settings fail closed: an existing globally ON
 * value from the old feature must never expose decorations to every user.
 */
export const CHRISTMAS_MASTER_KEY = "christmas_mode_enabled";
export const CHRISTMAS_ALLOWED_USERS_KEY = "christmas_mode_allowed_user_ids";
export const christmasModeUserPreferenceKey = (userId: string): string => `christmas_mode_user_pref:${userId}`;

export const CHRISTMAS_VISUALS_KEY = "christmas_mode_visuals_v2";

export const CHRISTMAS_EFFECT_KEYS = ["snowfall", "santa", "garlands", "countdown", "gifts", "ambient"] as const;
export type ChristmasEffectKey = (typeof CHRISTMAS_EFFECT_KEYS)[number];
export type ChristmasIntensity = "subtle" | "balanced" | "full";
export type ChristmasVisualSettings = {
  effects: Record<ChristmasEffectKey, boolean>;
  intensity: ChristmasIntensity;
};

/** A new installation defaults to the agreed six features at balanced intensity. */
export const DEFAULT_CHRISTMAS_VISUALS: ChristmasVisualSettings = {
  effects: {
    snowfall: true,
    santa: true,
    garlands: true,
    countdown: true,
    gifts: true,
    ambient: true,
  },
  intensity: "balanced",
};

/** Legacy/missing/malformed display configuration falls back to safe presentation defaults. */
export function parseChristmasVisualSettings(raw: string | null | undefined): ChristmasVisualSettings {
  if (!raw)
    return {
      effects: { ...DEFAULT_CHRISTMAS_VISUALS.effects },
      intensity: DEFAULT_CHRISTMAS_VISUALS.intensity,
    };
  try {
    const decoded: unknown = JSON.parse(raw);
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
      return parseChristmasVisualSettings(null);
    }
    const data = decoded as Record<string, unknown>;
    const flags = data.effects;
    const effects: ChristmasVisualSettings["effects"] = { ...DEFAULT_CHRISTMAS_VISUALS.effects };
    if (flags && typeof flags === "object" && !Array.isArray(flags)) {
      for (const key of CHRISTMAS_EFFECT_KEYS) {
        const flag = (flags as Record<string, unknown>)[key];
        if (typeof flag === "boolean") effects[key] = flag;
      }
    }
    const intensity = data.intensity === "subtle" || data.intensity === "full" ? data.intensity : "balanced";
    return { effects, intensity };
  } catch {
    return parseChristmasVisualSettings(null);
  }
}

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
  preferenceEnabled = true
): boolean {
  if (masterValue !== "true" || !userId || !preferenceEnabled) return false;
  return parseChristmasAllowedUserIds(allowedIdsRaw).includes(userId);
}
