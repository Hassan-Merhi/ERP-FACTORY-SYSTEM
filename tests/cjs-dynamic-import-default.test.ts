/**
 * xlsx-js-style and exceljs are CommonJS. Under native Node ESM (production
 * runs the bundled server as ESM), `await import(pkg)` exposes their API only
 * on `.default`: `(await import("xlsx-js-style")).utils` is undefined, so the
 * location inventory export failed in production with "Cannot read
 * properties of undefined (reading 'json_to_sheet')". Vitest's interop hides
 * this, so the tests never saw it. Server code must take `.default`.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "..");
const CJS_PACKAGES = ["xlsx-js-style", "exceljs"];

function serverFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return serverFiles(full);
    return /\.ts$/.test(entry.name) && !entry.name.includes(".test.") ? [full] : [];
  });
}

describe("CommonJS packages imported dynamically", () => {
  it("expose their API only on .default under native Node ESM", () => {
    const output = execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        'const x = await import("xlsx-js-style"); console.log(typeof x.utils, typeof x.default.utils);',
      ],
      { cwd: root, encoding: "utf8" }
    ).trim();
    expect(output).toBe("undefined object");
  });

  it("are always read through .default in server code", () => {
    const offenders: string[] = [];
    for (const file of serverFiles(path.join(root, "server"))) {
      const source = fs.readFileSync(file, "utf8");
      for (const pkg of CJS_PACKAGES) {
        const quoted = `"${pkg}"`;
        if (new RegExp(`\\}\\s*=\\s*await import\\(${quoted}\\)`).test(source)) {
          offenders.push(`${path.relative(root, file)} (${pkg}, destructured)`);
        }
        for (const match of source.matchAll(new RegExp(`(\\w+)\\s*=\\s*await import\\(${quoted}\\)\\s*;`, "g"))) {
          // A bare namespace is fine only when every runtime use goes through
          // .default; type annotations such as `ws: ExcelJS.Worksheet` are erased.
          if (new RegExp(`(?<![:<]\\s*)\\b${match[1]}\\.(?!default\\b)\\w`).test(source)) {
            offenders.push(`${path.relative(root, file)} (${pkg}, ${match[1]})`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
