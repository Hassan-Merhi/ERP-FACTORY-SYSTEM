/**
 * The desktop installer must contain every file the shell loads at runtime.
 *
 * electron-builder packages only what its `files` list names. main.js loads
 * preload.js, offline.html and the window icon by path, so a file left out of
 * that list builds a clean installer that fails on the user's machine: no
 * preload bridge, or a blank window instead of the offline page.
 */
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const desktopDir = path.resolve(import.meta.dirname, "../desktop");
const builderConfig = require(path.join(desktopDir, "electron-builder.config.js")) as {
  files: string[];
  directories: { output: string };
  win: { icon: string };
  appx: { identityName: string; publisher: string; applicationId: string };
};
const manifest = require(path.join(desktopDir, "package.json")) as {
  main: string;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
};

const included = builderConfig.files.filter((entry) => !entry.startsWith("!"));
const excluded = builderConfig.files.filter((entry) => entry.startsWith("!")).map((entry) => entry.slice(1));

describe("desktop installer contents", () => {
  it.each(["main.js", "preload.js", "offline.html", "package.json"])("packages %s, and it exists", (file) => {
    expect(included).toContain(file);
    expect(existsSync(path.join(desktopDir, file))).toBe(true);
  });

  it("starts from the packaged main process file", () => {
    expect(manifest.main).toBe("main.js");
    expect(included).toContain(manifest.main);
  });

  it("packages the generated icons the window and the installer use", () => {
    expect(included).toContain("icons/**/*");
    expect(builderConfig.win.icon).toBe("icons/icon.ico");
  });

  it("keeps build output and build tooling out of the installer", () => {
    expect(excluded).toEqual(expect.arrayContaining(["node_modules/**/*", "dist/**/*", "scripts/**/*"]));
    expect(builderConfig.directories.output).toBe("dist");
  });

  it("needs no runtime dependencies, since node_modules is not packaged", () => {
    expect(manifest.dependencies).toEqual({});
    expect(Object.keys(manifest.devDependencies)).toEqual(expect.arrayContaining(["electron", "electron-builder"]));
  });

  it("keeps the Microsoft Store identity the published listing is bound to", () => {
    expect(builderConfig.appx.identityName).toBe("HassanDakik.HMDERPFACTORYSYSTEM");
    expect(builderConfig.appx.publisher).toBe("CN=3D500DA2-F04D-4D3C-A10F-89F31D7C393E");
    expect(builderConfig.appx.applicationId).toBe("HMDERPFactorySystem");
  });
});
