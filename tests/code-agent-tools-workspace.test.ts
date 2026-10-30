/**
 * The AI coding agent's sandboxed workspace tools against the real
 * repository: path traversal rejection, file reads with truncation, bare
 * filename lookup, directory listing, grep, and message parsing.
 */
import fs from "fs";
import path from "path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import {
  extractFilePathsFromMessage,
  extractSearchPattern,
  grepProjectFiles,
  listProjectDir,
  readProjectFile,
  readProjectFileRaw,
  resolveFilePath,
  resolveWorkspacePath,
  WORKSPACE_ROOT,
} from "../server/lib/codeAgentTools";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("resolveWorkspacePath", () => {
  it("keeps paths inside the workspace, treating leading slashes as relative", () => {
    expect(resolveWorkspacePath("package.json")).toBe(path.join(WORKSPACE_ROOT, "package.json"));
    expect(resolveWorkspacePath("/etc/passwd")).toBe(path.join(WORKSPACE_ROOT, "etc/passwd"));
    expect(resolveWorkspacePath(".")).toBe(WORKSPACE_ROOT);
  });

  it("rejects traversal out of the workspace", () => {
    expect(() => resolveWorkspacePath("../outside.txt")).toThrow('Path traversal rejected: "../outside.txt"');
    expect(() => resolveWorkspacePath("server/../../x")).toThrow("Path traversal rejected");
  });
});

describe("file reads", () => {
  // Fixtures live in the ignored artifacts folder so reads never depend on real source text.
  const dir = path.join("artifacts", `code-agent-tools-${process.pid}`);
  const write = (name: string, content: string) => {
    fs.mkdirSync(path.join(WORKSPACE_ROOT, dir), { recursive: true });
    fs.writeFileSync(path.join(WORKSPACE_ROOT, dir, name), content);
    return path.join(dir, name);
  };
  afterAll(() => fs.rmSync(path.join(WORKSPACE_ROOT, dir), { recursive: true, force: true }));

  it("returns short files whole and truncates long ones at 300 lines", async () => {
    const smallPath = write("small.txt", "alpha\nbeta\n");
    expect(await readProjectFile(smallPath)).toEqual({
      content: "alpha\nbeta\n",
      truncated: false,
      totalLines: 3,
      relPath: smallPath,
    });

    const exact = Array.from({ length: 300 }, (_, i) => `row ${i}`).join("\n");
    expect(await readProjectFile(write("exact.txt", exact))).toMatchObject({ truncated: false, content: exact });
    expect((await readProjectFile(write("over.txt", `${exact}\nlast`))).truncated).toBe(true);

    const lines = Array.from({ length: 350 }, (_, i) => `line ${i + 1}`);
    const big = await readProjectFile(write("big.txt", lines.join("\n")));
    expect(big.truncated).toBe(true);
    expect(big.totalLines).toBe(350);
    expect(big.content).toBe(`${lines.slice(0, 300).join("\n")}\n\n// ... (50 more lines — file truncated)`);
  });

  it("refuses missing files and directories", async () => {
    const present = write("raw.txt", "raw text");
    await expect(readProjectFile("no/such/file.ts")).rejects.toThrow("File not found: no/such/file.ts");
    await expect(readProjectFile(dir)).rejects.toThrow(`Not a file: ${dir}`);
    expect(await readProjectFileRaw("no/such/file.ts")).toBe("");
    expect(await readProjectFileRaw(present)).toBe("raw text");
  });
});

describe("resolveFilePath", () => {
  it("accepts an exact relative path and finds a bare filename in source folders", () => {
    expect(resolveFilePath("/shared/priorityScanColors.ts")).toBe("shared/priorityScanColors.ts");
    expect(resolveFilePath("codeAgentTools.ts")).toBe(path.join("server", "lib", "codeAgentTools.ts"));
    expect(resolveFilePath("some/old/dir/priorityScanColors.ts")).toBe(path.join("shared", "priorityScanColors.ts"));
    expect(resolveFilePath("definitely-not-a-real-file-9271.ts")).toBeNull();
  });

  it("skips unreadable folders", () => {
    const readdir = fs.readdirSync;
    vi.spyOn(fs, "readdirSync").mockImplementation(((dir: fs.PathLike, options?: unknown) => {
      if (String(dir).endsWith(`${path.sep}server`)) throw new Error("EACCES");
      return readdir(dir, options as never);
    }) as never);
    expect(resolveFilePath("priorityScanColors.ts")).toBe(path.join("shared", "priorityScanColors.ts"));
  });
});

describe("listProjectDir", () => {
  it("lists entries sorted with folders marked and noise skipped", async () => {
    const root = await listProjectDir();
    expect(root).toContain("server/");
    expect(root).toContain("package.json");
    const names = root.map((entry) => entry.replace(/\/$/, ""));
    expect(names).not.toContain("node_modules");
    expect(names).not.toContain(".git");
    expect([...root].sort()).toEqual(root);
    await expect(listProjectDir("missing-dir-123")).rejects.toThrow("Directory not found: missing-dir-123");
  });
});

describe("grepProjectFiles", () => {
  it("returns matches with workspace-relative paths, or a no-match note", async () => {
    const out = await grepProjectFiles("export function extractSearchPattern", "server/lib");
    expect(out).toContain("server/lib/codeAgentTools.ts:");
    expect(out).not.toContain(WORKSPACE_ROOT);
    expect(await grepProjectFiles("zz_no_such_token_" + "4827", "shared")).toBe("(no matches found)");
    await expect(grepProjectFiles("[", "shared")).rejects.toThrow(/^grep failed:/);
  });
});

describe("message parsing", () => {
  it("extracts unique file paths and bare file names", () => {
    expect(
      extractFilePathsFromMessage(
        "Look at server/lib/logger.ts and App.tsx, then server/lib/logger.ts again; ignore notes.txt and styles.css"
      )
    ).toEqual(["server/lib/logger.ts", "App.tsx", "styles.css"]);
    expect(extractFilePathsFromMessage("nothing here")).toEqual([]);
  });

  it("extracts a search keyword after common phrasings", () => {
    expect(extractSearchPattern("find where getCompanyById is used")).toBe("getCompanyById");
    expect(extractSearchPattern("Search for `buildTrialBalance`")).toBe("buildTrialBalance");
    expect(extractSearchPattern("where is logger.info")).toBe("logger.info");
    expect(extractSearchPattern('grep for "TODO_ITEM"')).toBe("TODO_ITEM");
    expect(extractSearchPattern("how is voucherNumber built")).toBe("voucherNumber");
    expect(extractSearchPattern("look for x")).toBeNull();
    expect(extractSearchPattern("please fix the bug")).toBeNull();
  });
});
