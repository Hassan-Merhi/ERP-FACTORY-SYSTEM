import { describe, expect, it } from "vitest";
import {
  CHRISTMAS_ALLOWED_USERS_KEY,
  CHRISTMAS_MASTER_KEY,
  CHRISTMAS_VISUALS_KEY,
  christmasModeEnabledForUser,
  parseChristmasVisualSettings,
  christmasModeUserPreferenceKey,
  parseChristmasAllowedUserIds,
} from "./seasonalChristmasAccessPolicy";

describe("Developer-managed Christmas Mode access", () => {
  it("uses distinct persistent keys for master switch and per-user allowlist", () => {
    expect(CHRISTMAS_MASTER_KEY).toBe("christmas_mode_enabled");
    expect(CHRISTMAS_ALLOWED_USERS_KEY).toBe("christmas_mode_allowed_user_ids");
    expect(CHRISTMAS_VISUALS_KEY).toBe("christmas_mode_visuals_v2");
  });

  it("defaults to all six professional seasonal effects with Balanced intensity", () => {
    const result = parseChristmasVisualSettings(null);
    expect(result.intensity).toBe("balanced");
    expect(Object.values(result.effects)).toEqual([true, true, true, true, true, true]);
    expect(parseChristmasVisualSettings("not json")).toEqual(result);
  });

  it("parses Developer-specific overrides without changing unavailable defaults", () => {
    const result = parseChristmasVisualSettings(
      JSON.stringify({
        intensity: "full",
        effects: { gifts: false, snowfall: false },
      })
    );
    expect(result.intensity).toBe("full");
    expect(result.effects.gifts).toBe(false);
    expect(result.effects.snowfall).toBe(false);
    expect(result.effects.santa).toBe(true);
  });

  it("keeps all users disabled when the allowlist has never been configured", () => {
    expect(christmasModeEnabledForUser("true", null, "selected-user")).toBe(false);
    expect(christmasModeEnabledForUser(null, '["selected-user"]', "selected-user")).toBe(false);
  });

  it("activates only selected users when the master switch is on", () => {
    const allowed = JSON.stringify(["developer-account", "target-user"]);
    expect(christmasModeEnabledForUser("true", allowed, "target-user")).toBe(true);
    expect(christmasModeEnabledForUser("true", allowed, "developer-account")).toBe(true);
    expect(christmasModeEnabledForUser("true", allowed, "other-user")).toBe(false);
  });

  it("does not enable a user who personally opted out, even when allowlisted", () => {
    expect(christmasModeUserPreferenceKey("my-user-id")).toBe("christmas_mode_user_pref:my-user-id");
    expect(christmasModeEnabledForUser("true", '["target-user"]', "target-user", false)).toBe(false);
    expect(christmasModeEnabledForUser("true", '["target-user"]', "target-user", true)).toBe(true);
    expect(christmasModeEnabledForUser("true", '["target-user"]', "not-allowed", true)).toBe(false);
  });

  it("master OFF overrides the allowlist for all accounts", () => {
    expect(christmasModeEnabledForUser("false", '["target-user"]', "target-user")).toBe(false);
    expect(christmasModeEnabledForUser("true", '["target-user"]', null)).toBe(false);
  });

  it("rejects malformed or untrusted legacy allowlist data", () => {
    expect(parseChristmasAllowedUserIds(undefined)).toEqual([]);
    expect(parseChristmasAllowedUserIds("true")).toEqual([]);
    expect(parseChristmasAllowedUserIds('{"all":true}')).toEqual([]);
    expect(parseChristmasAllowedUserIds('["target-user",5]')).toEqual([]);
    expect(parseChristmasAllowedUserIds("invalid-json")).toEqual([]);
    expect(christmasModeEnabledForUser("true", "invalid-json", "target-user")).toBe(false);
  });

  it("deduplicates individual user IDs without broadening access", () => {
    expect(parseChristmasAllowedUserIds('["alice","alice","bob"]')).toEqual(["alice", "bob"]);
    expect(christmasModeEnabledForUser("true", '["alice","alice","bob"]', "eve")).toBe(false);
  });
});
