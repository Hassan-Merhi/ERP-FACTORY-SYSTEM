import type { Request } from "express";

export type FactoryApiAccessRequirement = {
  pageKey?: string;
  /** Every listed tab must be visible. */
  tabs?: string[];
  /** At least one complete alternative tab-set on the same page must be visible. */
  tabAlternatives?: string[][];
  /** Shared APIs may be legitimately owned by more than one Factory surface. */
  alternatives?: FactoryApiAccessRequirement[];
};

export function hasPrefix(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(prefix + "/");
}

export function isWrite(req: Request): boolean {
  return !["GET", "HEAD", "OPTIONS"].includes(req.method.toUpperCase());
}

export function isFactoryAccessBoundaryExempt(req: Request, path: string): boolean {
  if (path === "/my-access") return true;
  if (req.method.toUpperCase() !== "GET") return false;

  // Shared read-only configuration/assets are consumed by multiple permitted
  // Factory pages. Their mutations are still explicitly protected by Settings.
  if (path === "/settings") return true;
  // Read-only company switch state; changing it requires Settings access and
  // an Admin/Owner role (enforced by the route itself).
  if (path === "/automatic-priority-mode") return true;
  if (path === "/label-design-colors" || path === "/label-banners") return true;
  if (/^\/customer-logos\/\d+\/image$/.test(path)) return true;
  return false;
}

export function requirement(pageKey: string, tabs?: string[]): FactoryApiAccessRequirement {
  return { pageKey, ...(tabs?.length ? { tabs } : {}) };
}

export function anyOf(...alternatives: FactoryApiAccessRequirement[]): FactoryApiAccessRequirement {
  return { alternatives };
}
