import { beforeEach, describe, expect, it, vi } from "vitest";

const tools = vi.hoisted(() => ({
  files: {} as Record<string, { content: string; totalLines: number; truncated: boolean }>,
  raw: {} as Record<string, string>,
  grep: {} as Record<string, string | Error>,
  dirs: {} as Record<string, string[] | Error>,
  resolve: {} as Record<string, string>,
  paths: [] as string[],
  pattern: null as string | null,
  grepCalls: [] as Array<[string, string]>,
}));

vi.mock("../server/lib/codeAgentTools", () => ({
  extractFilePathsFromMessage: () => tools.paths,
  extractSearchPattern: () => tools.pattern,
  resolveFilePath: (p: string) => tools.resolve[p] ?? null,
  readProjectFile: async (fp: string) => {
    const file = tools.files[fp];
    if (!file) throw new Error("ENOENT");
    return file;
  },
  readProjectFileRaw: async (fp: string) => {
    if (!(fp in tools.raw)) throw new Error("ENOENT raw");
    return tools.raw[fp];
  },
  grepProjectFiles: async (pattern: string, dir: string) => {
    tools.grepCalls.push([pattern, dir]);
    const result = tools.grep[pattern];
    if (result instanceof Error) throw result;
    if (result === undefined) throw new Error("grep failed");
    return result;
  },
  listProjectDir: async (dir: string) => {
    const result = tools.dirs[dir];
    if (result instanceof Error) throw result;
    return result ?? [];
  },
}));

import { buildCodeEditPrompt, buildCodeReadPrompt } from "../server/chat/codeAgentContext";

beforeEach(() => {
  tools.files = {};
  tools.raw = {};
  tools.grep = {};
  tools.dirs = {};
  tools.resolve = {};
  tools.paths = [];
  tools.pattern = null;
  tools.grepCalls = [];
});

describe("buildCodeReadPrompt", () => {
  it("embeds resolved files once and greps by base name when a file is missing", async () => {
    tools.paths = ["a.ts", "server/missing.ts", "server/a.ts", "x", "y"];
    tools.resolve = { "a.ts": "server/a.ts" };
    tools.files = { "server/a.ts": { content: "const a = 1;", totalLines: 400, truncated: true } };
    tools.grep = { missing: "server/other.ts:1: missing" };
    const read: string[] = [];
    const { systemPrompt, suggestions } = await buildCodeReadPrompt("explain a.ts", read);
    expect(read).toEqual(["server/a.ts"]);
    expect(systemPrompt).toContain("**File: server/a.ts** (400 lines, first 300 shown)");
    expect(systemPrompt).toContain("File server/missing.ts not found. Grep results for `missing`");
    expect(systemPrompt).toContain("server/other.ts:1: missing");
    expect(suggestions).toHaveLength(3);
    expect(tools.grepCalls).toEqual([["missing", "."]]);
  });

  it("reports '(not found)' when the fallback grep also fails", async () => {
    tools.paths = ["gone.ts"];
    const { systemPrompt } = await buildCodeReadPrompt("x", []);
    expect(systemPrompt).toContain("(not found)");
  });

  it("greps by search pattern and reports grep errors", async () => {
    tools.pattern = "needle";
    tools.grep = { needle: "f.ts:3: needle" };
    expect((await buildCodeReadPrompt("find needle", [])).systemPrompt).toContain("Search results for `needle`");
    tools.grep = { needle: new Error("rg exploded") };
    expect((await buildCodeReadPrompt("find needle", [])).systemPrompt).toContain("**Search error:** rg exploded");
  });

  it("lists directories, defaulting to the root, and reports listing errors", async () => {
    tools.dirs = { "server/chat": ["intent.ts", "lookupDrafts.ts"], ".": ["server/"] };
    expect((await buildCodeReadPrompt("list files in server/chat", [])).systemPrompt).toContain(
      "Directory listing for `server/chat`:**\nintent.ts\nlookupDrafts.ts"
    );
    expect((await buildCodeReadPrompt("what files are there", [])).systemPrompt).toContain("Directory listing for `.`");
    tools.dirs = { ".": new Error("denied") };
    expect((await buildCodeReadPrompt("show directory", [])).systemPrompt).toContain("**Listing error:** denied");
  });

  it("adds no context for plain questions", async () => {
    const { systemPrompt } = await buildCodeReadPrompt("how are you", []);
    expect(systemPrompt).not.toContain("**");
  });
});

describe("buildCodeEditPrompt", () => {
  it("loads named files, notes session files and marks missing files as new", async () => {
    tools.paths = ["a.ts", "server/new.ts"];
    tools.resolve = { "a.ts": "server/a.ts" };
    tools.files = { "server/a.ts": { content: "x", totalLines: 5, truncated: false } };
    tools.raw = { "server/a.ts": "raw-x" };
    const read = ["server/a.ts"];
    const map: Record<string, string> = {};
    const { systemPrompt, suggestions } = await buildCodeEditPrompt("edit a.ts", ["server/a.ts"], read, map);
    expect(map).toEqual({ "server/a.ts": "raw-x" });
    expect(read).toEqual(["server/a.ts", "server/new.ts"]);
    expect(systemPrompt).toContain("Current content of `server/a.ts` *(also seen earlier this session)* (5 lines)");
    expect(systemPrompt).toContain("File `server/new.ts` does not exist yet");
    expect(suggestions[0]).toBe("Apply this change");
  });

  it("stores an empty original when the raw read fails and flags truncation", async () => {
    tools.paths = ["server/b.ts"];
    tools.files = { "server/b.ts": { content: "y", totalLines: 900, truncated: true } };
    const map: Record<string, string> = {};
    const { systemPrompt } = await buildCodeEditPrompt("edit server/b.ts", undefined, [], map);
    expect(map).toEqual({ "server/b.ts": "" });
    expect(systemPrompt).toContain("(900 lines, first 300 shown)");
  });

  it("infers a candidate file from keywords for pathless edits", async () => {
    tools.grep = {
      Invoice: "(no matches found)",
      voucher: "client/src/pages/VoucherForm.tsx:10: voucher\nclient/src/pages/VoucherForm.tsx:12: voucher",
    };
    tools.files = { "client/src/pages/VoucherForm.tsx": { content: "form", totalLines: 1000, truncated: true } };
    tools.raw = { "client/src/pages/VoucherForm.tsx": "raw-form" };
    const read: string[] = [];
    const map: Record<string, string> = {};
    const { systemPrompt } = await buildCodeEditPrompt(
      "add a field to the Invoice voucher screen",
      ["client/src/pages/VoucherForm.tsx"],
      read,
      map
    );
    expect(tools.grepCalls.map(([kw]) => kw)).toEqual(["Invoice", "voucher"]);
    expect(read).toEqual(["client/src/pages/VoucherForm.tsx"]);
    expect(map["client/src/pages/VoucherForm.tsx"]).toBe("raw-form");
    expect(systemPrompt).toContain("*(also seen earlier this session)* (1000 lines, first 300 shown)");
  });

  it("keeps going when the inferred file cannot be read", async () => {
    tools.grep = { Widget: "client/src/Widget.tsx:1: Widget" };
    const read: string[] = [];
    const { systemPrompt } = await buildCodeEditPrompt("rename the Widget title", undefined, read, {});
    expect(read).toEqual([]);
    expect(systemPrompt).not.toContain("No specific file was found");
    expect(systemPrompt).not.toContain("Current content");
  });

  it("asks the model to infer a file when nothing matches", async () => {
    const read: string[] = [];
    const { systemPrompt } = await buildCodeEditPrompt("make things nicer for Users", undefined, read, {});
    expect(systemPrompt).toContain("No specific file was found");
    expect(read).toEqual([]);
  });

  it("reads an inferred file without a session list", async () => {
    tools.grep = { Ledger: "client/src/Ledger.tsx:4: Ledger" };
    tools.files = { "client/src/Ledger.tsx": { content: "l", totalLines: 4, truncated: false } };
    const read = ["client/src/Ledger.tsx"];
    const { systemPrompt } = await buildCodeEditPrompt("fix the Ledger view", undefined, read, {});
    expect(read).toEqual(["client/src/Ledger.tsx"]);
    expect(systemPrompt).toContain("Current content of `client/src/Ledger.tsx` (4 lines)");
  });
});
