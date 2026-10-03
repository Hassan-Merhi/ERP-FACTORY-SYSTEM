#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";

const ROOT = process.cwd();
const SERVER_ROOT = path.join(ROOT, "server");
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs"]);
const EXCLUDED_DIRS = new Set(["node_modules", "dist", "build", ".git"]);

const patterns = [
  { id: "excel-write-buffer", regex: /\.xlsx\.writeBuffer\s*\(/g, severity: "high" },
  { id: "buffer-concat", regex: /Buffer\.concat\s*\(/g, severity: "high" },
  { id: "pdf-buffer-array", regex: /chunks\s*:\s*Buffer\[\]|const\s+chunks\s*=\s*\[\]/g, severity: "medium" },
  { id: "response-buffer-end", regex: /res\.end\s*\(\s*(?:await\s+)?[^\n;]*(?:writeBuffer|Buffer)/g, severity: "high" },
  { id: "archive-buffering", regex: /archiver\s*\([^)]*\)[\s\S]{0,500}Buffer\.concat/g, severity: "high" },
];

async function walk(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (EXCLUDED_DIRS.has(entry.name)) continue;
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(absolute)));
    else if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) files.push(absolute);
  }
  return files;
}

function lineNumberAt(source, index) {
  let line = 1;
  for (let i = 0; i < index; i += 1) if (source.charCodeAt(i) === 10) line += 1;
  return line;
}

function slash(value) {
  return value.replaceAll(path.sep, "/");
}

const packageJson = JSON.parse(await fs.readFile(path.join(ROOT, "package.json"), "utf8"));
const bridgePath = path.join(SERVER_ROOT, "exportBufferBridge.mjs");
let bridgeSource = "";
try {
  bridgeSource = await fs.readFile(bridgePath, "utf8");
} catch {
  // Reported below as missing protection.
}

const devCommand = String(packageJson.scripts?.dev || "");
const startCommand = String(packageJson.scripts?.start || "");
// Bridges are preloaded through the ordered manifest (server/startupPreload.mjs).
const startupPreloadSource = await fs.readFile(path.join(SERVER_ROOT, "startupPreload.mjs"), "utf8").catch(() => "");
const manifestLoadsExportBridge = startupPreloadSource.includes('await import("./exportBufferBridge.mjs");');
const bridgePreloadedInDev = devCommand.includes("--import ./server/startupPreload.mjs") && manifestLoadsExportBridge;
const bridgePreloadedInProduction = startCommand.includes("--import ./server/startupPreload.mjs") && manifestLoadsExportBridge;
const bridgeImplementsWorkbookStreaming = bridgeSource.includes("exportAwareWriteBuffer");
const bridgeImplementsChunkStreaming = bridgeSource.includes("bridgedBufferConcat");
const bridgeReady =
  bridgePreloadedInDev &&
  bridgePreloadedInProduction &&
  bridgeImplementsWorkbookStreaming &&
  bridgeImplementsChunkStreaming;

function protectionFor(file, pattern) {
  if (file === "server/exportBufferBridge.mjs") return "bridge-infrastructure";
  if (/whatsapp|scheduler|mailer|email/i.test(file)) return "attachment-buffer-required";
  if (!bridgeReady) return "unprotected";
  if (pattern === "excel-write-buffer" || pattern === "response-buffer-end") {
    return "browser-stream-or-serialized-attachment";
  }
  if (pattern === "buffer-concat" || pattern === "pdf-buffer-array") {
    return "browser-chunk-stream-or-attachment-buffer";
  }
  if (pattern === "archive-buffering") return "unprotected";
  return "review";
}

const files = await walk(SERVER_ROOT);
const findings = [];

for (const file of files) {
  const source = await fs.readFile(file, "utf8");
  const relativeFile = slash(path.relative(ROOT, file));
  for (const pattern of patterns) {
    pattern.regex.lastIndex = 0;
    for (const match of source.matchAll(pattern.regex)) {
      findings.push({
        severity: pattern.severity,
        pattern: pattern.id,
        protection: protectionFor(relativeFile, pattern.id),
        file: relativeFile,
        line: lineNumberAt(source, match.index ?? 0),
        excerpt: match[0].replace(/\s+/g, " ").slice(0, 180),
      });
    }
  }
}

findings.sort((a, b) => {
  const weight = { high: 0, medium: 1, low: 2 };
  return weight[a.severity] - weight[b.severity] || a.file.localeCompare(b.file) || a.line - b.line;
});

const summary = findings.reduce((acc, finding) => {
  acc.byPattern[finding.pattern] = (acc.byPattern[finding.pattern] || 0) + 1;
  acc.byProtection[finding.protection] = (acc.byProtection[finding.protection] || 0) + 1;
  return acc;
}, { byPattern: {}, byProtection: {} });

const unprotectedHighRisk = findings.filter(
  (finding) => finding.severity === "high" && finding.protection === "unprotected"
);

console.log(
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      bridge: {
        ready: bridgeReady,
        preloadedInDev: bridgePreloadedInDev,
        preloadedInProduction: bridgePreloadedInProduction,
        workbookStreaming: bridgeImplementsWorkbookStreaming,
        chunkStreaming: bridgeImplementsChunkStreaming,
      },
      total: findings.length,
      unprotectedHighRisk: unprotectedHighRisk.length,
      summary,
      findings,
    },
    null,
    2
  )
);

if (process.env.EXPORT_BUFFER_AUDIT_FAIL === "1" && unprotectedHighRisk.length > 0) {
  process.exitCode = 1;
}
