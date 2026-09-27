import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Keeps docs/factory-navigation-registry.md, the live Factory route table and the Factory
 * sidebar/access registry in agreement, so mobile certification only targets reachable routes.
 */

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

const routesSource = source("client/src/components/FactoryRoutes.tsx");
const registryDoc = source("docs/factory-navigation-registry.md");
const accessRegistry = source("shared/factoryAccessRegistry.ts");

const routePaths = Array.from(routesSource.matchAll(/path="([^"]+)"/g), (match) => match[1]);
const redirectPaths = new Set(
  Array.from(routesSource.matchAll(/<Route\s+path="([^"]+)">\s*(?:\{\(\) => )?<Redirect/g), (match) => match[1])
);

function routeFor(url: string): string | undefined {
  return routePaths.find((path) => new RegExp(`^${path.replace(/:[A-Za-z]+/g, "[^/]+")}$`).test(url));
}

function canonicalTopLevelRoutes(): string[] {
  const section = registryDoc.split("## Canonical top-level pages")[1]?.split("\n## ")[0] ?? "";
  return Array.from(section.matchAll(/\| `(\/factory\/[^`]+)` \|/g), (match) => match[1]);
}

describe("Factory route registry", () => {
  it("lists only live page routes as canonical top-level Factory destinations", () => {
    const canonical = canonicalTopLevelRoutes();
    expect(canonical.length).toBeGreaterThan(20);
    for (const url of canonical) {
      const route = routeFor(url);
      expect(route, `${url} has no route`).toBeDefined();
      expect(redirectPaths.has(route!), `${url} is canonical but redirects`).toBe(false);
    }
  });

  it("records Factory POS as a retired alias, matching its live redirect", () => {
    expect(redirectPaths.has("/factory/pos")).toBe(true);
    expect(canonicalTopLevelRoutes().includes("/factory/pos")).toBe(false);
    const aliasRow = registryDoc.split("\n").find((line) => line.startsWith("| `/factory/pos` |"));
    const [, , target, canonical] = (aliasRow ?? "").split("|").map((cell) => cell.trim());
    expect(target).toBe("Factory default landing page");
    expect(canonical).toBe("none (retired)");
  });

  it("routes every sidebar/access-registry destination to a real page", () => {
    const urls = Array.from(new Set(Array.from(accessRegistry.matchAll(/"(factory\/[^"?]+)"/g), (m) => `/${m[1]}`)));
    expect(urls.length).toBeGreaterThan(20);
    for (const url of urls) {
      const route = routeFor(url);
      expect(route, `${url} has no route`).toBeDefined();
      expect(redirectPaths.has(route!), `${url} is a sidebar destination but redirects`).toBe(false);
    }
  });

  it("documents every detail/workflow route pattern that exists", () => {
    const section = registryDoc.split("## Detail and workflow routes")[1]?.split("\n## ")[0] ?? "";
    const documented = Array.from(section.matchAll(/\| `(\/factory\/[^`?]+)[^`]*` \|/g), (match) => match[1]);
    for (const pattern of documented) {
      const concrete = pattern.replace(/:[A-Za-z]+/g, "1");
      expect(routeFor(concrete), `${pattern} is documented but not routed`).toBeDefined();
    }
  });
});
