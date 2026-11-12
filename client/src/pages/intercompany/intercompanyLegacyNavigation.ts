/**
 * Phase 7: old independent trading screens were consolidated into normal
 * Properties Containers and Vouchers. These are UI-only compatibility routes:
 * the actual access rules still run on the destination page and on every API.
 */
export type LegacyPropertiesIntercompanyRoute = "linked-trades" | "intercompany-lifecycle" | "intercompany-payments";

export const INTERCOMPANY_CANONICAL_DESTINATIONS = {
  propertiesContainers: "/properties/containers",
  propertiesVouchers: "/properties/vouchers?tab=intercompany",
  erpVouchers: "/vouchers?tab=intercompany",
} as const;

export const LEGACY_PROPERTIES_INTERCOMPANY_ROUTES: Record<LegacyPropertiesIntercompanyRoute, string> = {
  "linked-trades": "/properties/linked-trades",
  "intercompany-lifecycle": "/properties/intercompany-lifecycle",
  "intercompany-payments": "/properties/intercompany-payments",
};

function verifiedContainerId(search: string): number | null {
  const params = new URLSearchParams(search.startsWith("?") ? search : `?${search}`);
  const values = [params.get("physicalContainerId"), params.get("containerId")].filter(
    (value): value is string => value != null
  );
  if (!values.length || values.some((value) => !/^[1-9]\d*$/.test(value))) return null;
  const ids = values.map(Number);
  if (ids.some((value) => !Number.isSafeInteger(value)) || new Set(ids).size !== 1) return null;
  return ids[0];
}

export function legacyPropertiesIntercompanyDestination(
  route: LegacyPropertiesIntercompanyRoute,
  search = ""
): string {
  if (route === "intercompany-payments") return INTERCOMPANY_CANONICAL_DESTINATIONS.propertiesVouchers;
  const containerId = verifiedContainerId(search);
  return containerId == null
    ? INTERCOMPANY_CANONICAL_DESTINATIONS.propertiesContainers
    : `${INTERCOMPANY_CANONICAL_DESTINATIONS.propertiesContainers}/${containerId}`;
}

export function legacyErpIntercompanyPaymentDestination(): string {
  return INTERCOMPANY_CANONICAL_DESTINATIONS.erpVouchers;
}
