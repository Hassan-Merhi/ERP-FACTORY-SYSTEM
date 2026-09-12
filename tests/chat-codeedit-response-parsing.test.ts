/**
 * Regression tests for the code_edit response parser extracted from
 * chatService.ts into server/chat/codeAgentContext.ts.
 *
 * The parser must keep accepting the same AI payload shapes with the same
 * stale-guard fallbacks, and must keep passing prose replies through
 * untouched so the chat route always returns a readable answer.
 */
import { describe, expect, it } from "vitest";
import { parseCodeEditResponse } from "../server/chat/codeAgentContext";

describe("parseCodeEditResponse", () => {
  it("parses a single-file patch wrapped in markdown fences", () => {
    const raw = `\`\`\`json
{"filePath":"client/src/pages/Agents.tsx","description":"Split the page","originalContent":"","newContent":"export default function Agents() { return null; }"}
\`\`\``;

    const { filePatchDrafts, finalResponse } = parseCodeEditResponse(raw, {});

    expect(filePatchDrafts).toHaveLength(1);
    expect(filePatchDrafts?.[0]).toMatchObject({
      filePath: "client/src/pages/Agents.tsx",
      description: "Split the page",
      newContent: "export default function Agents() { return null; }",
    });
    expect(finalResponse).toContain("client/src/pages/Agents.tsx");
    expect(finalResponse).toContain("Click **Apply**");
  });

  it("parses a multi-file patch payload and falls back to the session copy for originalContent", () => {
    const originalMap = {
      "client/src/pages/Agents.tsx": "ORIGINAL-A",
      "client/src/pages/Suppliers.tsx": "ORIGINAL-B",
    };
    const raw = `\`\`\`json
{
  "description": "Split two pages",
  "patches": [
    {"filePath":"client/src/pages/Agents.tsx","description":"Patch A","newContent":"NEW-A"},
    {"filePath":"client/src/pages/Suppliers.tsx","description":"Patch B","originalContent":"stale","newContent":"NEW-B"}
  ]
}
\`\`\``;

    const { filePatchDrafts, finalResponse } = parseCodeEditResponse(raw, originalMap);

    expect(filePatchDrafts).toHaveLength(2);
    // Missing originalContent falls back to the content read during the session.
    expect(filePatchDrafts?.[0].originalContent).toBe("ORIGINAL-A");
    // An explicitly-provided originalContent wins (stale-guard trust boundary).
    expect(filePatchDrafts?.[1].originalContent).toBe("stale");
    expect(finalResponse).toContain("changes for **2 files**");
    expect(finalResponse).toContain("Split two pages");
    expect(finalResponse).toContain("Apply All");
  });

  it("ignores patches that lack a filePath or newContent field", () => {
    const raw = `{"description":"bad","patches":[{"description":"no path","newContent":"X"},{"filePath":"a.ts"}]}`;

    const { filePatchDrafts, finalResponse } = parseCodeEditResponse(raw, {});

    // The parser keeps the empty list; the chat() caller maps it to undefined.
    expect(filePatchDrafts).toEqual([]);
    expect(finalResponse).toBe(raw);
  });

  it("passes non-JSON prose responses through untouched", () => {
    const prose = "Sure! Here is how you would refactor that page...";

    const { filePatchDrafts, finalResponse } = parseCodeEditResponse(prose, {});

    expect(filePatchDrafts).toBeUndefined();
    expect(finalResponse).toBe(prose);
  });

  it("tolerates malformed JSON by keeping the original response", () => {
    const broken = `\`\`\`json\n{"filePath": "broken", "newContent":\n\`\`\``;

    const { filePatchDrafts, finalResponse } = parseCodeEditResponse(broken, {});

    expect(filePatchDrafts).toBeUndefined();
    expect(finalResponse).toBe(broken);
  });

  it("does not treat a bare JSON array or scalar as a patch payload", () => {
    const notAnObject = `[{"filePath":"x.ts"}]`;

    const { filePatchDrafts, finalResponse } = parseCodeEditResponse(notAnObject, {});

    expect(filePatchDrafts).toBeUndefined();
    expect(finalResponse).toBe(notAnObject);
  });
});
