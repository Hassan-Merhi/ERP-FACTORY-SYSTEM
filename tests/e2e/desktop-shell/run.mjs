#!/usr/bin/env node
/**
 * Launches the real Electron desktop shell and checks what a user would get.
 *
 *   cd desktop && npm ci && node node_modules/electron/install.js && cd ..
 *   xvfb-run -a node tests/e2e/desktop-shell/run.mjs
 *
 * Two scenarios, each in a fresh Electron process:
 *   online  - the shell loads the hosted application, the page is isolated from
 *             Node, and popups/navigation to other origins never open in-app.
 *   offline - the site is unreachable, the bundled offline page appears, and
 *             Retry returns to the application once it is reachable.
 *
 * Nothing leaves the machine: harness.cjs resolves the production host to a
 * local HTTPS server and every other host to "not found".
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");
const desktopDir = path.join(root, "desktop");

function electronBinary() {
  if (process.env.ELECTRON_BINARY) return process.env.ELECTRON_BINARY;
  const requireFromDesktop = createRequire(path.join(desktopDir, "package.json"));
  try {
    return requireFromDesktop("electron");
  } catch (error) {
    throw new Error(
      "Electron is not installed. Run `npm ci` in desktop/, then `node node_modules/electron/install.js`.",
      { cause: error }
    );
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

const workDir = mkdtempSync(path.join(tmpdir(), "desktop-shell-"));
const keyPath = path.join(workDir, "key.pem");
const certPath = path.join(workDir, "cert.pem");
let failed = false;

try {
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=www.hmdinternationalgroup.com",
      "-keyout",
      keyPath,
      "-out",
      certPath,
    ],
    { stdio: "ignore" }
  );

  const binary = electronBinary();
  if (!existsSync(binary)) throw new Error(`Electron binary not found at ${binary}`);

  for (const scenario of ["online", "offline"]) {
    const resultPath = path.join(workDir, `${scenario}.json`);
    const port = await freePort();
    const run = spawnSync(binary, ["--no-sandbox", path.join(here, "harness.cjs")], {
      cwd: root,
      encoding: "utf8",
      timeout: 120000,
      env: {
        ...process.env,
        DESKTOP_SHELL_SCENARIO: scenario,
        DESKTOP_SHELL_RESULT: resultPath,
        DESKTOP_SHELL_PORT: String(port),
        DESKTOP_SHELL_TLS_KEY: keyPath,
        DESKTOP_SHELL_TLS_CERT: certPath,
      },
    });

    if (!existsSync(resultPath)) {
      failed = true;
      console.error(`\n${scenario}: Electron produced no result (exit ${run.status}, signal ${run.signal}).`);
      console.error(run.stderr?.split("\n").slice(-25).join("\n"));
      continue;
    }

    const result = JSON.parse(readFileSync(resultPath, "utf8"));
    console.log(`\n${scenario}`);
    for (const entry of result.checks) {
      console.log(
        `  ${entry.ok ? "ok  " : "FAIL"} ${entry.name}${entry.ok ? "" : ` -> ${JSON.stringify(entry.detail)}`}`
      );
    }
    if (result.error) console.error(`  ERROR ${result.error}`);
    if (!result.ok || run.status !== 0) failed = true;
  }
} catch (error) {
  failed = true;
  console.error(String(error.stack || error));
} finally {
  rmSync(workDir, { recursive: true, force: true });
}

if (failed) {
  console.error("\nDesktop shell launch verification FAILED.");
  process.exit(1);
}
console.log("\nDesktop shell launch verification passed.");
