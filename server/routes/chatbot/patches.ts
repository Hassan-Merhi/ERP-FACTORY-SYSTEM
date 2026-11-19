/**
 * chatbotRoutes: ChatbotPatch endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express } from "express";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { db } from "../../db";
import { requireAuth, requireRole, requireNonPOS } from "../../auth";
import { systemSettings, codePatchHistory } from "@shared/schema";
import { eq, and, desc, isNull } from "drizzle-orm";
import { logAIAction } from "../../lib/aiActionPermission";
import { resolveWorkspacePath } from "../../lib/codeAgentTools";
import { commitAndPush } from "../../lib/githubPush";
import { registerChatbotPoImportRoutes } from "../chatbotPoImportRoutes";

import { decryptToken } from "./_helpers";
import { registerChatbotPatchRoutesPart1 } from "./registerChatbotPatchRoutesPart1";
import { z } from "zod";
import { emptyQuery, validateRequest, type RequestSchemas } from "../../lib/validateRequest";

// Both stay optional: the handler answers its own 400 without them.
const gitPushInput = {
  query: emptyQuery,
  body: z.strictObject({ files: z.array(z.string()).optional(), message: z.string().optional() }),
} satisfies RequestSchemas;

export function registerChatbotPatchRoutes(app: Express) {
  registerChatbotPoImportRoutes(app);

  // ============================================================
  // EMPLOYEE SALARY ACCOUNT CLEANUP
  // Migrate legacy EMP-* ledger accounts to use employeeId directly
  // ============================================================

  // Get list of legacy EMP-* salary accounts

  registerChatbotPatchRoutesPart1(app);

  // ── Code Agent: update commit hash after successful git-push ──────────────
  // Called internally by the git-push handler to link the history record.
  async function updatePatchCommitHash(companyId: number, filePath: string, commitHash: string) {
    try {
      // Update the most recent un-pushed patch for this file
      const [latest] = await db
        .select({ id: codePatchHistory.id })
        .from(codePatchHistory)
        .where(
          and(
            eq(codePatchHistory.companyId, companyId),
            eq(codePatchHistory.filePath, filePath),
            isNull(codePatchHistory.commitHash),
            isNull(codePatchHistory.revertedAt)
          )
        )
        .orderBy(desc(codePatchHistory.appliedAt))
        .limit(1);
      if (latest) {
        await db.update(codePatchHistory).set({ commitHash }).where(eq(codePatchHistory.id, latest.id));
      }
    } catch (_) {
      /* Non-fatal */
    }
  }

  // ── Code Agent: commit and push to GitHub ─────────────────────────────────
  app.post(
    "/api/chatbot/git-push",
    requireAuth,
    requireNonPOS,
    requireRole("Admin", "Owner"),
    validateRequest(gitPushInput),
    async (req, res) => {
      try {
        const { files, message: commitMessage } = req.body;
        if (!Array.isArray(files) || files.length === 0) {
          return res.status(400).json({ message: "files array is required" });
        }
        if (!commitMessage || !String(commitMessage).trim()) {
          return res.status(400).json({ message: "Commit message is required" });
        }

        // Validate all paths
        for (const f of files) {
          try {
            resolveWorkspacePath(f);
          } catch (e: unknown) {
            return res.status(400).json({ message: getErrorMessage(e) });
          }
        }

        // Load GitHub settings from DB at request time (not from potentially stale process.env)
        const [urlRow, tokenRow] = await Promise.all([
          db
            .select({ value: systemSettings.value })
            .from(systemSettings)
            .where(eq(systemSettings.key, "github_repo_url"))
            .limit(1),
          db
            .select({ value: systemSettings.value })
            .from(systemSettings)
            .where(eq(systemSettings.key, "github_token"))
            .limit(1),
        ]);

        const baseUrl = urlRow[0]?.value ?? process.env.GITHUB_REPO_URL ?? "";
        const rawToken = tokenRow[0]?.value ?? process.env.GITHUB_TOKEN ?? "";
        // New GitHub settings tokens use authenticated v2 encryption.
        // Obsolete CryptoJS ciphertext must be replaced, not passed as a credential.
        const isEncryptedToken = rawToken.startsWith("v2:") || rawToken.startsWith("U2FsdGVkX1");
        const token = isEncryptedToken ? decryptToken(rawToken) : rawToken;
        if (isEncryptedToken && !token) {
          return res.status(422).json({
            success: false,
            error: "TOKEN_RESET",
          });
        }

        if (!baseUrl) {
          return res.status(422).json({
            success: false,
            error: "GitHub repository URL is not configured. Please set it in Chatbot Settings → GitHub Integration.",
          });
        }

        const { buildAuthenticatedUrl } = await import("../../lib/githubPush");
        const authenticatedUrl = buildAuthenticatedUrl(baseUrl, token);

        const result = await commitAndPush({
          files,
          message: String(commitMessage).trim(),
          repoUrl: authenticatedUrl,
          authorName: req.session.userId ? String(req.session.userId) : "ERP Agent",
          authorEmail: "agent@erp.local",
        });

        if (!result.success) {
          return res.status(422).json({ success: false, error: result.error });
        }

        // Link commit hash to patch history records for each pushed file
        const gitPushCompanyId = req.session.currentCompanyId;
        if (result.commitHash && gitPushCompanyId) {
          for (const fp of files) {
            await updatePatchCommitHash(gitPushCompanyId, fp, result.commitHash).catch(() => {});
          }
        }

        await logAIAction({
          req,
          actionType: "write",
          actionName: "git_push",
          inputJson: { files, message: commitMessage },
          outputJson: { commitHash: result.commitHash, branch: result.branch },
          status: "success",
        });

        res.json({ success: true, commitHash: result.commitHash, branch: result.branch });
      } catch (error: unknown) {
        logger.error("[Chatbot] git-push error:", { error: getErrorMessage(error) });
        res.status(500).json({ message: "Internal server error" });
      }
    }
  );
}
