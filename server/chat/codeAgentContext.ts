/**
 * Code-agent context and response parsing for the chat service.
 *
 * Owns the code_read / code_edit branches of the chat pipeline: reading
 * project files (or grepping for keywords), assembling the system prompts,
 * and turning the AI's JSON reply into validated file-patch drafts.
 * Extracted from chatService.ts; behaviour is unchanged.
 */
import { logger } from "../lib/logger";
import {
  readProjectFile,
  grepProjectFiles,
  listProjectDir,
  extractFilePathsFromMessage,
  extractSearchPattern,
  readProjectFileRaw,
  resolveFilePath,
} from "../lib/codeAgentTools";

/** One file change proposed by the AI in a code_edit response. */
export interface FilePatchDraft {
  filePath: string;
  description: string;
  originalContent: string;
  newContent: string;
}

/** Raw AI patch payload fields, as best-guess parsed from model JSON. */
interface CodePatchPayload {
  description?: string;
  filePath?: string;
  originalContent?: string;
  newContent?: string;
  patches?: Array<{
    filePath?: string;
    description?: string;
    originalContent?: string;
    newContent?: string;
  }>;
}

/**
 * Build the code_read system prompt: read explicitly-named project files or
 * fall back to keyword grep / directory listing. Appends each file path read
 * to `codeReadFiles` (mutated by reference, like the original inline branch).
 */
export async function buildCodeReadPrompt(
  userMessage: string,
  codeReadFiles: string[]
): Promise<{ systemPrompt: string; suggestions: string[] }> {
  // ── Code Read: read project files or grep, inject into system prompt ──────
  const filePaths = extractFilePathsFromMessage(userMessage);
  let codeContext = "";

  if (filePaths.length > 0) {
    for (const raw of filePaths.slice(0, 3)) {
      // Resolve bare filenames (e.g. "chatService.ts") to full workspace-relative paths
      const fp = resolveFilePath(raw) ?? raw;
      try {
        const { content, totalLines, truncated } = await readProjectFile(fp);
        codeContext += `\n\n**File: ${fp}** (${totalLines} lines${truncated ? `, first 300 shown` : ""})\n\`\`\`typescript\n${content}\n\`\`\``;
        if (!codeReadFiles.includes(fp)) codeReadFiles.push(fp);
      } catch (_err: unknown) {
        // Still not found — fall back to grep by base name
        const basename = fp.replace(/.*\//, "").replace(/\.\w+$/, "");
        const grepResult = await grepProjectFiles(basename, ".").catch(() => "(not found)");
        codeContext += `\n\n**File ${fp} not found. Grep results for \`${basename}\`:**\n\`\`\`\n${grepResult}\n\`\`\``;
      }
    }
  } else {
    // No file paths — try grep for keywords
    const pattern = extractSearchPattern(userMessage);
    if (pattern) {
      try {
        const grepResult = await grepProjectFiles(pattern, ".");
        codeContext = `\n\n**Search results for \`${pattern}\`:**\n\`\`\`\n${grepResult}\n\`\`\``;
      } catch (err: unknown) {
        codeContext = `\n\n**Search error:** ${(err as Error).message}`;
      }
    } else if (/\b(?:list files|ls\b|what files|directory)\b/i.test(userMessage)) {
      const dirMatch = userMessage.match(/\b(server|client|shared|scripts)\/[\w./+-]*/);
      const dir = dirMatch ? dirMatch[0] : ".";
      try {
        const entries = await listProjectDir(dir);
        codeContext = `\n\n**Directory listing for \`${dir}\`:**\n${entries.join("\n")}`;
      } catch (err: unknown) {
        codeContext = `\n\n**Listing error:** ${(err as Error).message}`;
      }
    }
  }

  const systemPrompt = `You are a coding assistant with access to this TypeScript ERP/POS project (React + Express + PostgreSQL). Answer the user's question clearly and concisely about the code.${codeContext}\n\nIf you reference specific parts of the code, use code blocks with the language specified.`;
  const suggestions = ["Explain how this works", "Find related files", "Show me all usages"];
  logger.info("[ChatService] code_read intent — loaded file/grep context");
  return { systemPrompt, suggestions };
}

/**
 * Build the code_edit system prompt: read up to three explicitly-named files
 * (or infer a candidate file via keyword grep), embed their current content,
 * and demand a strict JSON patch response. Populates `codeReadFiles` and
 * `codeEditOriginalMap` (both mutated by reference) for the later parse step.
 */
export async function buildCodeEditPrompt(
  userMessage: string,
  sessionReadFiles: string[] | undefined,
  codeReadFiles: string[],
  codeEditOriginalMap: Record<string, string>
): Promise<{ systemPrompt: string; suggestions: string[] }> {
  // ── Code Edit: load files and build structured output prompt ──────────────
  // Support up to 3 explicitly-named files; fall back to keyword grep for pathless edits.
  const rawPaths = extractFilePathsFromMessage(userMessage);
  const resolvedPaths = rawPaths
    .slice(0, 3)
    .map((p) => resolveFilePath(p) ?? p)
    .filter(Boolean);

  const contentBlocks: string[] = [];

  // Read each explicitly-named file
  for (const fp of resolvedPaths) {
    const alreadyInSession = sessionReadFiles?.includes(fp);
    try {
      const { content, totalLines, truncated } = await readProjectFile(fp);
      const raw = await readProjectFileRaw(fp).catch(() => "");
      codeEditOriginalMap[fp] = raw;
      if (!codeReadFiles.includes(fp)) codeReadFiles.push(fp);
      const note = alreadyInSession ? " *(also seen earlier this session)*" : "";
      contentBlocks.push(
        `Current content of \`${fp}\`${note} (${totalLines} lines${truncated ? ", first 300 shown" : ""}):\n\`\`\`typescript\n${content}\n\`\`\``
      );
      logger.info(`[ChatService] code_edit — read ${fp} (${totalLines} lines${truncated ? ", truncated" : ""})`);
    } catch {
      contentBlocks.push(`File \`${fp}\` does not exist yet — you will be creating it.`);
      if (!codeReadFiles.includes(fp)) codeReadFiles.push(fp);
    }
  }

  // Pathless edit: infer candidate file by grepping message keywords
  if (resolvedPaths.length === 0) {
    const keywords = [
      ...new Set(
        (
          (userMessage.match(
            /\b[A-Z][a-zA-Z]{3,}\b|\b[a-z]{4,}(?:Form|Page|Component|Hook|Route|Schema|Type|Service|Helper|Utils?)\b/g
          ) ?? []) as string[]
        ).concat(
          (userMessage.match(
            /\b(?:voucher|invoice|payment|receipt|stock|pos|purchase|sale|customer|supplier|company|user|auth|chat)\b/gi
          ) ?? []) as string[]
        )
      ),
    ].slice(0, 4);

    let grepResults = "";
    for (const kw of keywords) {
      const result = await grepProjectFiles(kw, "client/src").catch(() => "");
      if (result && result !== "(no matches found)") {
        grepResults += result + "\n";
        break;
      }
    }
    const candidatePaths = [
      ...new Set((grepResults.match(/^([\w/.-]+\.(?:tsx?|jsx?)):/gm) ?? []).map((l) => l.replace(/:$/, ""))),
    ].slice(0, 1);

    for (const fp of candidatePaths) {
      const alreadyInSession = sessionReadFiles?.includes(fp);
      try {
        const { content, totalLines, truncated } = await readProjectFile(fp);
        const raw = await readProjectFileRaw(fp).catch(() => "");
        codeEditOriginalMap[fp] = raw;
        if (!codeReadFiles.includes(fp)) codeReadFiles.push(fp);
        const note = alreadyInSession ? " *(also seen earlier this session)*" : "";
        contentBlocks.push(
          `Current content of \`${fp}\`${note} (${totalLines} lines${truncated ? ", first 300 shown" : ""}):\n\`\`\`typescript\n${content}\n\`\`\``
        );
        logger.info(
          `[ChatService] code_edit (pathless) — inferred ${fp} (${totalLines} lines${truncated ? ", truncated" : ""})`
        );
      } catch {
        /* File might not exist */
      }
    }

    if (candidatePaths.length === 0) {
      contentBlocks.push(
        `No specific file was found. Infer the best file to create or edit and set filePath accordingly.`
      );
    }
  }

  const _primaryFilePath = resolvedPaths[0] ?? codeReadFiles[0] ?? "path/to/file.ts";
  const contentSection = contentBlocks.length > 0 ? "\n\n" + contentBlocks.join("\n\n") : "";

  const systemPrompt = `You are a senior TypeScript engineer on this ERP/POS project (React 18 + Express + Drizzle ORM + shadcn/ui). You MUST respond with ONLY a valid JSON object — no markdown, no explanation, ONLY raw JSON.

User request: "${userMessage}"${contentSection}

Respond with ONLY JSON in ONE of these two formats:

Single file change:
{"filePath":"...","description":"one-sentence summary","originalContent":"(the exact current file content shown above, or empty string for new files)","newContent":"the complete new file content"}

Multiple file changes (only when edits span more than one file):
{"description":"one-sentence summary of all changes","patches":[{"filePath":"...","description":"...","originalContent":"...","newContent":"..."},...]}

Rules:
- "newContent" must be the COMPLETE file — every line, not just the changed parts
- Preserve all existing imports, exports, and functionality unless explicitly asked to remove something
- Match the existing coding style, indentation (2 spaces), and TypeScript patterns exactly
- If creating a new file, "originalContent" must be ""
- Never truncate newContent — output the entire file even if it is long
- "originalContent" in each patch MUST exactly match what was shown above (required for stale-guard validation)
- Use the multi-file format ONLY when the change genuinely requires editing more than one file`;

  const suggestions = ["Apply this change", "Show me the diff", "Explain what changed"];
  logger.info(`[ChatService] code_edit intent — targets: ${codeReadFiles.join(", ") || "(inferred)"}`);
  return { systemPrompt, suggestions };
}

/**
 * Parse the AI's code_edit response into file-patch drafts. Accepts either
 * the single-file or the multi-file JSON shape; falls back to the unmodified
 * text response when the model returned prose instead of JSON.
 */
export function parseCodeEditResponse(
  response: string,
  codeEditOriginalMap: Record<string, string>
): { filePatchDrafts?: FilePatchDraft[]; finalResponse: string } {
  let filePatchDrafts: FilePatchDraft[] | undefined = undefined;
  let finalResponse = response;

  try {
    const raw = response
      .trim()
      .replace(/^```(?:json)?\n?/, "")
      .replace(/\n?```$/, "")
      .trim();
    if (raw.startsWith("{")) {
      const parsed: CodePatchPayload = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.patches) && parsed.patches.length > 0) {
        // Multi-file patches
        filePatchDrafts = parsed.patches
          .filter((p) => p.filePath && "newContent" in p)
          .map((p) => ({
            filePath: p.filePath as string,
            description: p.description || parsed.description || "Apply code changes",
            originalContent: p.originalContent ?? codeEditOriginalMap[p.filePath as string] ?? "",
            newContent: p.newContent ?? "",
          }));
        if (filePatchDrafts && filePatchDrafts.length > 0) {
          const fileList = filePatchDrafts.map((p) => `- \`${p.filePath}\``).join("\n");
          finalResponse = `I've prepared changes for **${filePatchDrafts.length} file${filePatchDrafts.length > 1 ? "s" : ""}**.`;
          finalResponse += `\n\n${parsed.description || "Review the diffs below."}\n\n${fileList}\n\nClick **Apply** on each diff, or **Apply All** to write all changes at once.`;
        }
      } else if (parsed && parsed.filePath && "newContent" in parsed) {
        // Single file patch
        filePatchDrafts = [
          {
            filePath: parsed.filePath,
            description: parsed.description || "Apply code changes",
            originalContent: parsed.originalContent ?? codeEditOriginalMap[parsed.filePath] ?? "",
            newContent: parsed.newContent ?? "",
          },
        ];
        finalResponse = `I've prepared the changes for **\`${parsed.filePath}\`**.`;
        finalResponse += `\n\n${parsed.description || "Review the diff below and click Apply when you're ready."}\n\nClick **Apply** to write the changes to disk, or **Cancel** to discard.`;
      }
    }
  } catch {
    // AI responded with explanation text — leave finalResponse as-is
  }

  return { filePatchDrafts, finalResponse };
}
