// Extracted from ./CostCenters.tsx
import type { CostCenter } from "@/api/costCentersApi";

export type Form = { code: string; name: string; description: string; parentId: string };

export const emptyForm: Form = { code: "", name: "", description: "", parentId: "root" };

export function detailsFrom(center: CostCenter): Form {
  return {
    code: center.code,
    name: center.name,
    description: center.description || "",
    parentId: center.parentId == null ? "root" : String(center.parentId),
  };
}

export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Request failed";
}

export function sortCenters(centers: CostCenter[]) {
  const map = new Map<number, CostCenter[]>();
  centers.forEach((center) => {
    const key = centers.some((c) => c.id === center.parentId) ? center.parentId! : 0;
    map.set(key, [...(map.get(key) || []), center]);
  });
  const result: Array<{ center: CostCenter; depth: number }> = [];
  const seen = new Set<number>();
  function visit(parent: number, depth: number) {
    for (const center of (map.get(parent) || []).sort((a, b) => a.code.localeCompare(b.code))) {
      if (seen.has(center.id)) continue;
      seen.add(center.id);
      result.push({ center, depth });
      visit(center.id, depth + 1);
    }
  }
  visit(0, 0);
  centers.filter((c) => !seen.has(c.id)).forEach((c) => result.push({ center: c, depth: 0 }));
  return result;
}
