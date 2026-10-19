import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

type LockEntry = { version?: string; dependencies?: Record<string, string> };
type DesktopLock = { packages: Record<string, LockEntry> };
type DesktopManifest = { overrides?: Record<string, Record<string, string>> };

const lock = JSON.parse(readFileSync(new URL("../desktop/package-lock.json", import.meta.url), "utf8")) as DesktopLock;
const manifest = JSON.parse(
  readFileSync(new URL("../desktop/package.json", import.meta.url), "utf8")
) as DesktopManifest;

describe("desktop build dependency security", () => {
  it("excludes the vulnerable sprintf-js dependency and its retired roarr parent", () => {
    const installed = Object.keys(lock.packages);
    expect(installed.filter((name) => /(?:^|\/)node_modules\/(?:sprintf-js|roarr)$/.test(name))).toEqual([]);
  });

  it("uses the replacement global-agent release without a roarr dependency", () => {
    expect(manifest.overrides?.["@electron/get"]?.["global-agent"]).toBe("4.1.3");
    expect(lock.packages["node_modules/global-agent"]?.version).toBe("4.1.3");
    expect(lock.packages["node_modules/global-agent"]?.dependencies?.["roarr"]).toBeUndefined();
  });
});
