/**
 * Live view of the Express stack for route access verification.
 *
 * Unlike tests/helpers/routeManifest.ts, which snapshots routes and mounts as
 * two separate lists, this keeps them interleaved in registration order and
 * reads the role lists `requireRole` attaches to its guards. That is what the
 * access manifest needs to prove: which guards run for a route, and which
 * mounted middleware runs in front of it.
 */
import express, { type Express } from "express";

import { REQUIRED_ROLES_METADATA } from "../../server/auth";
import { REQUIRED_PERMISSION_METADATA } from "../../server/lib/permissionMiddleware";
import { registerRoutes } from "../../server/routes";

export interface LiveRoute {
  kind: "route";
  /** Position in the Express stack, shared with mounts. */
  index: number;
  /** `METHOD /path#n`, matching the manifest's rule ids. */
  id: string;
  method: string;
  path: string;
  guards: string[];
  /** One entry per `requireRole(...)` guard in the chain. */
  requiredRoles: string[][];
  /** Keys of `requirePermission(...)` guards in the chain. */
  requiredPermissions: string[];
}

export interface LiveMount {
  kind: "mount";
  index: number;
  /** Mount path, `/` for unprefixed middleware, `re:<source>` for a RegExp. */
  path: string;
  name: string;
  /** The RegExp the middleware was mounted with, when it was not a string path. */
  pattern?: RegExp;
  /** Set when the mounted middleware is a `requirePermission` guard. */
  requiredPermission?: string;
}

export type LiveStackEntry = LiveRoute | LiveMount;

interface StackLayer {
  name?: string;
  handle?: { name?: string } & Record<string, unknown>;
  route?: {
    path?: unknown;
    methods?: Record<string, boolean>;
    stack?: Array<{ name?: string; method?: string; handle?: { name?: string } & Record<string, unknown> }>;
  };
}

const ANONYMOUS = "<anonymous>";
const EXPRESS_INTERNAL = new Set(["query", "expressInit"]);

function handlerName(candidate: { name?: string; handle?: { name?: string } } | undefined): string {
  const name = candidate?.name || candidate?.handle?.name;
  if (!name || name === ANONYMOUS) return ANONYMOUS;
  return name.startsWith("bound ") ? name.slice("bound ".length) : name;
}

/** Register every application route on a fresh app and return its ordered stack. */
export async function buildLiveRouteStack(): Promise<LiveStackEntry[]> {
  const app = express();
  // Same routing options as server/httpApp.ts.
  app.set("case sensitive routing", true);
  const mountPaths = captureMountPaths(app);
  const server = await registerRoutes(app);
  server.close();
  return extractLiveRouteStack(app, mountPaths);
}

type CapturedApp = {
  use: (...args: unknown[]) => unknown;
  router?: { stack?: StackLayer[] };
  _router?: { stack?: StackLayer[] };
};

function stackOf(app: Express): StackLayer[] {
  const captured = app as unknown as CapturedApp;
  const stack = captured.router?.stack ?? captured._router?.stack;
  if (!stack) throw new Error("Express router stack unavailable");
  return stack;
}

/** Express does not keep the source path of `app.use()` mounts, so record it as they are added. */
export function captureMountPaths(app: Express): WeakMap<object, string | RegExp> {
  const mountPaths = new WeakMap<object, string | RegExp>();
  const captured = app as unknown as CapturedApp;
  const originalUse = captured.use.bind(app);
  captured.use = (...args: unknown[]) => {
    const first = args[0];
    const mountPath = typeof first === "string" || first instanceof RegExp ? first : "/";
    const before = (captured.router?.stack ?? captured._router?.stack ?? []).length;
    const result = originalUse(...args);
    for (const layer of stackOf(app).slice(before)) mountPaths.set(layer, mountPath);
    return result;
  };
  return mountPaths;
}

export function extractLiveRouteStack(app: Express, mountPaths: WeakMap<object, string | RegExp>): LiveStackEntry[] {
  const entries: LiveStackEntry[] = [];
  const occurrences = new Map<string, number>();

  for (const layer of stackOf(app)) {
    if (layer.route) {
      const rawPath = layer.route.path;
      const paths = (Array.isArray(rawPath) ? rawPath : [rawPath]).map((path) => {
        if (typeof path !== "string") throw new Error(`Unsupported non-string route path: ${String(path)}`);
        return path;
      });
      const methods = Object.keys(layer.route.methods ?? {})
        .filter((method) => layer.route?.methods?.[method])
        .map((method) => method.toUpperCase())
        .sort();
      for (const path of paths) {
        for (const method of methods) {
          const handlers = (layer.route.stack ?? []).filter(
            (handler) => handler.method === undefined || handler.method.toUpperCase() === method
          );
          const key = `${method} ${path}`;
          const occurrence = (occurrences.get(key) ?? 0) + 1;
          occurrences.set(key, occurrence);
          entries.push({
            kind: "route",
            index: entries.length,
            id: `${key}#${occurrence}`,
            method,
            path,
            guards: handlers.map(handlerName),
            requiredRoles: handlers
              .map((handler) => handler.handle?.[REQUIRED_ROLES_METADATA])
              .filter((roles): roles is string[] => Array.isArray(roles))
              .map((roles) => [...roles]),
            requiredPermissions: handlers
              .map((handler) => handler.handle?.[REQUIRED_PERMISSION_METADATA])
              .filter((key): key is string => typeof key === "string"),
          });
        }
      }
      continue;
    }

    const name = handlerName(layer.handle ?? { name: layer.name });
    if (EXPRESS_INTERNAL.has(name) || EXPRESS_INTERNAL.has(layer.name ?? "")) continue;
    const requiredPermission = layer.handle?.[REQUIRED_PERMISSION_METADATA];
    const mountedAt = mountPaths.get(layer) ?? "/";
    entries.push({
      kind: "mount",
      index: entries.length,
      path: typeof mountedAt === "string" ? mountedAt : `re:${mountedAt.source}`,
      name,
      ...(typeof mountedAt === "string" ? {} : { pattern: mountedAt }),
      ...(typeof requiredPermission === "string" ? { requiredPermission } : {}),
    });
  }
  return entries;
}

/** A concrete URL for a route pattern, with every parameter replaced by `value`. */
export function samplePath(routePath: string, value = "1"): string {
  return routePath
    .replace(/:([A-Za-z0-9_]+)/g, value)
    .replace(/\*([A-Za-z0-9_]+)/g, value)
    .replace(/[{}]/g, "");
}

/** Whether a mount runs for the concrete URL `path`. */
export function mountCovers(mount: Pick<LiveMount, "path" | "pattern">, path: string): boolean {
  if (mount.pattern) return mount.pattern.test(path);
  if (mount.path === "/") return true;
  const mountSegments = mount.path.split("/").filter(Boolean);
  const pathSegments = path.split("/").filter(Boolean);
  if (mountSegments.length > pathSegments.length) return false;
  return mountSegments.every((segment, position) => segment.startsWith(":") || segment === pathSegments[position]);
}
