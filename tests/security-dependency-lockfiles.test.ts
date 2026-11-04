import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

type LockPackage = {
  version?: string;
  resolved?: string;
  link?: boolean;
};
type Lockfile = { packages: Record<string, LockPackage> };

function readLock(path: string): Lockfile {
  return JSON.parse(readFileSync(new URL("../" + path, import.meta.url), "utf8")) as Lockfile;
}
function installed(lock: Lockfile, name: string) {
  const suffix = "/node_modules/" + name;
  return Object.entries(lock.packages).filter(([path]) => path === "node_modules/" + name || path.endsWith(suffix));
}
function parts(version: string): number[] {
  return version.split(".").slice(0, 3).map(Number);
}
function atLeast(version: string, required: [number, number, number]) {
  const current = parts(version);
  for (let i = 0; i < 3; i++) {
    if (current[i] !== required[i]) return current[i] > required[i];
  }
  return true;
}

describe("security remediation for root and desktop lockfiles", () => {
  const root = readLock("package-lock.json");
  const desktop = readLock("desktop/package-lock.json");

  it("keeps every modern minimatch outside the vulnerable 7.x-10.x range", () => {
    for (const [file, lock] of [
      ["root", root],
      ["desktop", desktop],
    ] as const) {
      const rows = installed(lock, "minimatch");
      expect(rows.length, file).toBeGreaterThan(0);
      for (const [path, pkg] of rows) {
        expect(pkg.version, path).toBeTruthy();
        const major = parts(pkg.version!)[0];
        expect(major < 7 || atLeast(pkg.version!, [11, 0, 1]), path).toBe(true);
      }
    }
  });

  it("contains no glob release vulnerable to post-abort traversal", () => {
    for (const lock of [root, desktop]) {
      for (const [path, pkg] of installed(lock, "glob")) {
        expect(pkg.version, path).toBeTruthy();
        const major = parts(pkg.version!)[0];
        expect(major < 9 || atLeast(pkg.version!, [14, 0, 2]), path).toBe(true);
      }
    }
  });

  it("uses fixed undici and fast-uri versions in desktop's build chain", () => {
    const undici = installed(desktop, "undici");
    expect(undici.length).toBeGreaterThan(0);
    for (const [path, pkg] of undici) {
      expect(pkg.version, path).toBeTruthy();
      const major = parts(pkg.version!)[0];
      const safe =
        major === 6
          ? atLeast(pkg.version!, [6, 29, 1])
          : major === 7
            ? atLeast(pkg.version!, [7, 30, 1])
            : atLeast(pkg.version!, [8, 12, 2]);
      expect(safe, path).toBe(true);
    }
    for (const [path, pkg] of installed(desktop, "fast-uri")) {
      expect(pkg.version, path).toBeTruthy();
      expect(atLeast(pkg.version!, [3, 1, 9]), path).toBe(true);
    }
  });

  it("uses only the locally hardened deepmerge replacement", () => {
    const packages = installed(root, "deepmerge");
    expect(packages.length).toBeGreaterThan(0);
    for (const [path, pkg] of packages) {
      expect(pkg.link, path).toBe(true);
      expect(pkg.resolved, path).toContain("secure-deepmerge");
      expect(pkg.version, path).not.toBe("4.3.1");
    }
    const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(manifest.overrides.deepmerge).toBe("file:vendor/secure-deepmerge");
  });
});
