/**
 * The coding agent's GitHub push helper: credentialed URL building, input
 * and configuration checks, the git command sequence, and how git failures
 * are mapped to messages with credentials redacted. git is stubbed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  calls: [] as Array<{ args: string[]; env: Record<string, string | undefined> }>,
  respond: (_args: string[]): string | Error => "",
}));
vi.mock("child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("child_process")>()),
  execFile: (
    _cmd: string,
    args: string[],
    opts: { env: Record<string, string> },
    cb: (e: unknown, v?: unknown) => void
  ) => {
    h.calls.push({ args, env: opts.env });
    const out = h.respond(args);
    if (out instanceof Error) cb(out);
    else cb(null, { stdout: `${out}\n`, stderr: "" });
  },
}));

import { buildAuthenticatedUrl, commitAndPush } from "../server/lib/githubPush";
import { WORKSPACE_ROOT } from "../server/lib/codeAgentTools";

const env = { ...process.env };
const REPO = "https://x-token@github.com/acme/erp.git";

beforeEach(() => {
  h.calls = [];
  h.respond = (args) => {
    if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return "feature/x";
    if (args[0] === "status") return " M server/a.ts";
    if (args[0] === "rev-parse") return "abc1234";
    return "";
  };
});

afterEach(() => {
  process.env = { ...env };
});

describe("buildAuthenticatedUrl", () => {
  it("adds a trimmed token as the URL user unless credentials or a token are missing", () => {
    expect(buildAuthenticatedUrl("https://github.com/acme/erp.git", " ghp_1 ")).toBe(
      "https://ghp_1@github.com/acme/erp.git"
    );
    expect(buildAuthenticatedUrl("https://github.com/acme/erp.git")).toBe("https://github.com/acme/erp.git");
    expect(buildAuthenticatedUrl("https://github.com/acme/erp.git", "  ")).toBe("https://github.com/acme/erp.git");
    expect(buildAuthenticatedUrl("https://me:pw@github.com/acme/erp.git", "t")).toBe(
      "https://me:pw@github.com/acme/erp.git"
    );
    expect(buildAuthenticatedUrl("not a url", "t")).toBe("not a url");
  });
});

describe("commitAndPush", () => {
  it("stages, commits as the agent and pushes HEAD to the current branch", async () => {
    delete process.env.GIT_TERMINAL_PROMPT;
    const result = await commitAndPush({
      files: ["server/a.ts", `${WORKSPACE_ROOT}/shared/b.ts`],
      message: "Fix",
      repoUrl: REPO,
    });
    expect(result).toEqual({ success: true, commitHash: "abc1234", branch: "feature/x" });
    expect(h.calls.map((c) => c.args)).toEqual([
      ["rev-parse", "--abbrev-ref", "HEAD"],
      ["add", "--", "server/a.ts", "shared/b.ts"],
      ["status", "--porcelain"],
      ["-c", "user.name=ERP Agent", "-c", "user.email=agent@erp.local", "commit", "-m", "Fix"],
      ["rev-parse", "--short", "HEAD"],
      ["push", REPO, "HEAD:refs/heads/feature/x"],
    ]);
    expect(h.calls[0].env.GIT_TERMINAL_PROMPT).toBe("0");
  });

  it("uses the configured remote, custom author and main when the branch is unknown", async () => {
    process.env.GITHUB_REPO_URL = "https://github.com/acme/env.git";
    h.respond = (args) => {
      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return new Error("detached");
      if (args[0] === "rev-parse") return new Error("no head");
      if (args[0] === "status") return "A x";
      return "";
    };
    const result = await commitAndPush({ files: ["x"], message: "m", authorName: "Bot", authorEmail: "bot@x" });
    expect(result).toEqual({ success: true, commitHash: "", branch: "main" });
    expect(h.calls.at(-1)?.args).toEqual(["push", "https://github.com/acme/env.git", "HEAD:refs/heads/main"]);
    expect(h.calls.find((c) => c.args.includes("commit"))?.args.slice(0, 4)).toEqual([
      "-c",
      "user.name=Bot",
      "-c",
      "user.email=bot@x",
    ]);
  });

  it("refuses empty, escaping or unconfigured pushes before running git", async () => {
    delete process.env.GITHUB_REPO_URL;
    expect(await commitAndPush({ files: [], message: "m", repoUrl: REPO })).toEqual({
      success: false,
      error: "No files to commit",
    });
    expect(await commitAndPush({ files: ["ok.ts", "../evil"], message: "m", repoUrl: REPO })).toEqual({
      success: false,
      error: "Invalid file path: ../evil",
    });
    expect(await commitAndPush({ files: ["ok.ts"], message: "m" })).toEqual({
      success: false,
      error: "GitHub repository is not configured. Please set it in Chatbot Settings → GitHub Integration.",
    });
    expect(h.calls).toEqual([]);
  });

  it("stops when staging leaves nothing to commit", async () => {
    for (const status of ["   ", new Error("status failed")]) {
      h.respond = (args) => (args[0] === "status" ? status : "main");
      expect(await commitAndPush({ files: ["a"], message: "m", repoUrl: REPO })).toEqual({
        success: false,
        error: "Nothing to commit — the file content may already be up to date.",
      });
    }
  });

  it("maps push failures to safe messages and redacts credentialed URLs", async () => {
    const pushFails = (message: string) => {
      h.respond = (args) => (args[0] === "push" ? new Error(message) : args[0] === "status" ? "M a" : "main");
      return commitAndPush({ files: ["a"], message: "m", repoUrl: REPO });
    };
    const cases: Array<[string, string]> = [
      [
        "fatal: Authentication failed for https://x-token@github.com/acme/erp.git",
        "Authentication failed. Check your GitHub token in Chatbot Settings.",
      ],
      ["remote: Invalid username or password", "Authentication failed. Check your GitHub token in Chatbot Settings."],
      ["fatal: could not read Username", "Authentication failed. Check your GitHub token in Chatbot Settings."],
      [
        "! [rejected] HEAD -> main (fetch first)",
        "Push rejected — the remote has conflicting changes. Pull and merge first.",
      ],
      ["error: non-fast-forward", "Push rejected — the remote has conflicting changes. Pull and merge first."],
      ["remote: Repository not found.", "Repository not found. Check your GitHub URL in Chatbot Settings."],
      ["ref not found", "Repository not found. Check your GitHub URL in Chatbot Settings."],
      [
        "Permission denied (publickey)",
        "Permission denied. Ensure your token has the required repository write scope.",
      ],
      [
        "The requested URL returned error: 403",
        "Permission denied. Ensure your token has the required repository write scope.",
      ],
      [
        "unable to access 'https://x-token@github.com/acme/erp.git/': timeout",
        "unable to access '<redacted-url> timeout",
      ],
    ];
    for (const [raw, message] of cases) {
      expect(await pushFails(raw)).toEqual({ success: false, error: message });
    }
    h.respond = (args) => (args[0] === "add" ? new Error("") : "main");
    expect(await commitAndPush({ files: ["a"], message: "m", repoUrl: REPO })).toEqual({ success: false, error: "" });
  });
});
