#!/usr/bin/env node
// Alias that verifies without writing — enforces the generated registry stays in sync with code.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const dir = dirname(fileURLToPath(import.meta.url));
const gen = resolve(dir, "./generate-remote-control-action-registry.mjs");
const child = spawn(process.execPath, [gen], { stdio: "inherit" });
child.on("exit", (code) => process.exit(code ?? 1));
