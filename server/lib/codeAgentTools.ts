/**
 * Code Agent Tools — sandboxed file-access utilities for the AI coding agent.
 * All paths are resolved relative to the workspace root; traversal is rejected.
 */

import path from "path";
import { getErrorMessage } from "../lib/httpHandlers";
import fs from "fs";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

export const WORKSPACE_ROOT = process.cwd();
const MAX_FILE_LINES = 300;

// ── Path safety ────────────────────────────────────────────────────────────────

/**
 * Resolve and validate a relative path. Throws if the path escapes the workspace.
 */
export function resolveWorkspacePath(relPath: string): string {
  // Strip any leading slashes so "abs" paths like /etc/passwd still resolve inside workspace
  const cleaned = relPath.replace(/^\/+/, "");
  const abs = path.resolve(WORKSPACE_ROOT, cleaned);
  const rootWithSep = WORKSPACE_ROOT.endsWith(path.sep) ? WORKSPACE_ROOT : WORKSPACE_ROOT + path.sep;
  if (abs !== WORKSPACE_ROOT && !abs.startsWith(rootWithSep)) {
    throw new Error(`Path traversal rejected: ${JSON.stringify(relPath)}`);
  }
  return abs;
}

// ── File operations ────────────────────────────────────────────────────────────

export async function readProjectFile(
  relPath: string
): Promise<{ content: string; totalLines: number; truncated: boolean; relPath: string }> {
  const abs = resolveWorkspacePath(relPath);
  if (!fs.existsSync(abs)) {
    throw new Error(`File not found: ${relPath}`);
  }
  const stat = fs.statSync(abs);
  if (!stat.isFile()) {
    throw new Error(`Not a file: ${relPath}`);
  }

  const raw = fs.readFileSync(abs, "utf8");
  const allLines = raw.split("\n");
  const truncated = allLines.length > MAX_FILE_LINES;
  const content = truncated
    ? allLines.slice(0, MAX_FILE_LINES).join("\n") +
      `\n\n// ... (${allLines.length - MAX_FILE_LINES} more lines — file truncated)`
    : raw;

  return { content, totalLines: allLines.length, truncated, relPath };
}

export async function readProjectFileRaw(relPath: string): Promise<string> {
  const abs = resolveWorkspacePath(relPath);
  if (!fs.existsSync(abs)) return "";
  return fs.readFileSync(abs, "utf8");
}

// ── Bare-filename search ────────────────────────────────────────────────────

const SOURCE_DIRS = ["server", "client/src", "shared", "scripts"];

/**
 * Search known source directories for a file with the given basename.
 * Returns the first match as a workspace-relative path, or null if not found.
 */
function findInSourceDirs(dirAbs: string, filename: string): string | null {
  if (!fs.existsSync(dirAbs)) return null;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dirAbs, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of entries) {
    if (e.name === "node_modules" || e.name === ".git" || e.name === "dist") continue;
    const fullPath = path.join(dirAbs, e.name);
    if (e.isFile() && e.name === filename) return fullPath;
    if (e.isDirectory()) {
      const found = findInSourceDirs(fullPath, filename);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Resolve a user-supplied filename (bare name or relative path) to a workspace-relative
 * path by searching known source directories. Returns null if nothing is found.
 */
export function resolveFilePath(nameOrPath: string): string | null {
  // Strip leading slashes
  const cleaned = nameOrPath.replace(/^\/+/, "");
  // Direct hit first (exact relative path)
  const directAbs = path.resolve(WORKSPACE_ROOT, cleaned);
  if (fs.existsSync(directAbs) && fs.statSync(directAbs).isFile()) {
    return cleaned;
  }
  // Bare filename — search source dirs
  const basename = path.basename(cleaned);
  for (const srcDir of SOURCE_DIRS) {
    const found = findInSourceDirs(path.resolve(WORKSPACE_ROOT, srcDir), basename);
    if (found) return path.relative(WORKSPACE_ROOT, found);
  }
  return null;
}

export async function listProjectDir(relPath: string = "."): Promise<string[]> {
  const abs = resolveWorkspacePath(relPath);
  if (!fs.existsSync(abs)) {
    throw new Error(`Directory not found: ${relPath}`);
  }
  const IGNORED = new Set(["node_modules", ".git", "dist", ".cache", ".local", "__pycache__"]);
  const entries = fs.readdirSync(abs, { withFileTypes: true });
  return entries
    .filter((e) => !IGNORED.has(e.name))
    .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
    .sort();
}

export async function grepProjectFiles(pattern: string, relDir: string = "."): Promise<string> {
  const abs = resolveWorkspacePath(relDir);
  try {
    const { stdout } = await execFileAsync(
      "grep",
      ["-r", "-n", "-m", "40", "--include=*.ts", "--include=*.tsx", "--include=*.js", "--include=*.jsx", pattern, abs],
      { timeout: 10_000 }
    );
    // Strip workspace root from paths for cleaner output
    const rootPfx = WORKSPACE_ROOT + path.sep;
    return stdout.replaceAll(rootPfx, "");
  } catch (e: unknown) {
    if ((e as { code?: number }).code === 1) return "(no matches found)";
    throw new Error(`grep failed: ${getErrorMessage(e)}`, { cause: e });
  }
}

// ── Message parsing helpers ────────────────────────────────────────────────────

const FILE_EXT_RE =
  /\b((?:server|client|shared|scripts)\/[\w./-]+\.(?:ts|tsx|js|jsx|css|json|md)|[\w-]+\.(?:ts|tsx|js|jsx|css|json|md))\b/gi;

/**
 * Extract all file-path-like tokens from a user message.
 */
export function extractFilePathsFromMessage(msg: string): string[] {
  const matches = [...msg.matchAll(FILE_EXT_RE)];
  // Deduplicate and return
  return [...new Set(matches.map((m) => m[1]))];
}

/**
 * Extract a keyword likely intended as a grep pattern.
 */
export function extractSearchPattern(msg: string): string | null {
  const m = msg.match(
    /\b(?:find\s+(?:where\s+)?|search\s+(?:for\s+)?|where\s+is\s+|grep\s+(?:for\s+)?|how\s+is\s+|look\s+for\s+)([`"']?)(\w[\w.]+)\1/i
  );
  return m ? m[2] : null;
}
