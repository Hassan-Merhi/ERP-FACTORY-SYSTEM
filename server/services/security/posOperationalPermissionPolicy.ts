export interface PosOperationalLocationInput {
  bodyLocationId?: unknown;
  queryLocationId?: unknown;
  pathLocationId?: unknown;
}

export function parsePositiveId(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  if (Array.isArray(value) || typeof value === "object") return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

export function resolveExplicitPosLocation(input: PosOperationalLocationInput): {
  locationId: number | null;
  conflict: boolean;
} {
  const ids = [
    parsePositiveId(input.bodyLocationId),
    parsePositiveId(input.queryLocationId),
    parsePositiveId(input.pathLocationId),
  ].filter((value): value is number => value !== null);

  if (ids.length === 0) return { locationId: null, conflict: false };
  const first = ids[0];
  return {
    locationId: first,
    conflict: ids.some((value) => value !== first),
  };
}

export function isPosMutationAllowed(input: { method: string; role: string; posViewOnly: boolean }): boolean {
  const method = input.method.toUpperCase();
  if (["GET", "HEAD", "OPTIONS"].includes(method)) return true;
  if (input.role === "View Only" || input.role === "Create Only") return false;
  if (input.role === "POS" && input.posViewOnly) return false;
  return true;
}

export function isPosSaleCreate(method: string, path: string): boolean {
  return method.toUpperCase() === "POST" && path === "/api/pos/sales";
}

export function parsePosSaleEditVoucherId(method: string, path: string): number | null {
  if (!["PUT", "PATCH"].includes(method.toUpperCase())) return null;
  const match = path.match(/^\/api\/vouchers\/(\d+)\/sales$/);
  return match ? parsePositiveId(match[1]) : null;
}
