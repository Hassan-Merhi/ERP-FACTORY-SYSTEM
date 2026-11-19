// Extracted from ./AdvancedRestrictionsPanel.tsx
import { PERMISSION_CATALOG, type PermissionType } from "@shared/permissionConfig";

export interface RolePermissionRecord {
  role: string;
  featureKey: string;
  enabled: boolean;
}

export interface AdvancedRestrictionsPanelProps {
  role: string;
  companyId: number;
  companyName?: string;
}

export const IS_NORMAL_USER = (role: string) => role === "Normal User";

/**
 * For a given role and DB-stored enabled value, determine whether the
 * checkbox should appear checked in the UI.
 *
 *   Owner/Manager/POS → checkbox = restriction; checked means enabled=false in DB
 *   Normal User       → checkbox = grant;       checked means enabled=true in DB
 */
export function dbToChecked(role: string, enabled: boolean | undefined): boolean {
  if (IS_NORMAL_USER(role)) {
    return enabled === true;
  }
  return enabled === false;
}

/**
 * Convert a UI checkbox state back to the DB enabled value.
 */
export function checkedToDb(role: string, checked: boolean): boolean {
  if (IS_NORMAL_USER(role)) {
    return checked; // checked = granted = true
  }
  return !checked; // checked = restricted = false
}

/**
 * Returns how many restrictions/grants are active for this role given the
 * permission map.
 */
export function countActive(role: string, permMap: Map<string, boolean>): number {
  let count = 0;
  for (const entry of PERMISSION_CATALOG) {
    const stored = permMap.get(entry.key);
    if (IS_NORMAL_USER(role)) {
      if (stored === true) count++;
    } else {
      if (stored === false) count++;
    }
  }
  return count;
}

export const TYPE_ORDER: PermissionType[] = ["module", "page", "tab", "action", "sensitive", "export", "pos"];
