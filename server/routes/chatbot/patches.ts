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
import path from "path";
import fs from "fs";
import { logAIAction } from "../../lib/aiActionPermission";
import { resolveWorkspacePath, readProjectFileRaw } from "../../lib/codeAgentTools";
import { commitAndPush } from "../../lib/githubPush";
import { registerChatbotPoImportRoutes } from "../chatbotPoImportRoutes";

import { decryptToken } from "./_helpers";

export function registerChatbotPatchRoutes(app: Express) {
  registerChatbotPoImportRoutes(app);

  // ============================================================
  // EMPLOYEE SALARY ACCOUNT CLEANUP
  // Migrate legacy EMP-* ledger accounts to use employeeId directly
  // ============================================================

  // Get list of legacy EMP-* salary accounts

  // ── Code Agent: apply file patch ───────────────────────────────────────────
  app.post("/api/chatbot/apply-patch", requireAuth, requireNonPOS, requireRole("Admin", "Owner"), async (req, res) => {
    try {
      const { filePath, originalContent, newContent } = req.body;
      if (!filePath || newContent === undefined || newContent === null) {
        return res.status(400).json({ message: "filePath and newContent are required" });
      }
      const companyId = req.session.currentCompanyId;
      const userId = req.session.userId;

      // Validate path is inside workspace
      let absPath: string;
      try {
        absPath = resolveWorkspacePath(filePath);
      } catch (e: unknown) {
        return res.status(400).json({ message: getErrorMessage(e) });
      }

      // Stale guard: enforce whenever the file exists on disk.
      // - If originalContent is non-empty: compare exactly (protects against concurrent edits).
      // - If originalContent is empty but file already exists: reject — the AI must have read
      //   the file first; an empty originalContent for an existing file means the patch was
      //   generated without seeing the current content and cannot be applied safely.
      // - If file does NOT exist yet: allow creation unconditionally.
      const fileAlreadyExists = fs.existsSync(absPath) && fs.statSync(absPath).isFile();
      if (fileAlreadyExists) {
        const currentContent = await readProjectFileRaw(filePath).catch(() => "");
        if (!originalContent || originalContent.trim() === "") {
          return res.status(409).json({
            message:
              "Cannot overwrite an existing file without a stale-check reference. Please re-ask the AI to regenerate the patch.",
            stale: true,
          });
        }
        if (currentContent !== originalContent) {
          return res.status(409).json({
            message: "The file has changed since the diff was generated. Please re-ask the AI to regenerate the patch.",
            stale: true,
          });
        }
      }

      // Ensure parent directory exists
      const dir = path.dirname(absPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      // Write the new content
      fs.writeFileSync(absPath, newContent, "utf8");

      // Log to code_patch_history
      const { description: patchDescription } = req.body;
      try {
        await db.insert(codePatchHistory).values({
          companyId: companyId ?? 0,
          filePath,
          description: patchDescription || null,
          originalContent: originalContent || "",
          newContent,
          appliedByUserId: String(userId),
        });
      } catch (_) {
        /* Non-fatal: don't fail the request if history logging fails */
      }

      await logAIAction({
        req,
        actionType: "write",
        actionName: "apply_patch",
        inputJson: { filePath, lineCount: newContent.split("\n").length },
        outputJson: { success: true },
        status: "success",
      });

      res.json({ success: true, filePath });
    } catch (error: unknown) {
      logger.error("[Chatbot] apply-patch error:", { error: getErrorMessage(error) });
      res.status(500).json({ message: "Internal server error" });
    }
  });

  // ── Code Agent: patch history (list) ─────────────────────────────────────
  app.get("/api/chatbot/patch-history", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      const userRole = req.session.currentRole;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      if (userRole !== "Admin" && userRole !== "Owner" && userRole !== "Developer") {
        return res.status(403).json({ message: "Access denied" });
      }
      const rows = await db
        .select({
          id: codePatchHistory.id,
          companyId: codePatchHistory.companyId,
          filePath: codePatchHistory.filePath,
          description: codePatchHistory.description,
          appliedByUserId: codePatchHistory.appliedByUserId,
          appliedAt: codePatchHistory.appliedAt,
          commitHash: codePatchHistory.commitHash,
          revertedAt: codePatchHistory.revertedAt,
        })
        .from(codePatchHistory)
        .where(eq(codePatchHistory.companyId, companyId))
        .orderBy(desc(codePatchHistory.appliedAt))
        .limit(100);
      res.json(rows);
    } catch {
      res.status(500).json({ message: "Internal server error" });
    }
  });

  // ── Code Agent: revert a patch ────────────────────────────────────────────
  app.post(
    "/api/chatbot/revert-patch/:id",
    requireAuth,
    requireNonPOS,
    requireRole("Admin", "Owner"),
    async (req, res) => {
      try {
        const companyId = req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });

        const patchId = parseInt(req.params.id, 10);
        if (isNaN(patchId)) return res.status(400).json({ message: "Invalid patch id" });

        const [row] = await db
          .select()
          .from(codePatchHistory)
          .where(and(eq(codePatchHistory.id, patchId), eq(codePatchHistory.companyId, companyId)));
        if (!row) return res.status(404).json({ message: "Patch not found" });
        if (row.revertedAt) return res.status(409).json({ message: "Patch has already been reverted" });

        // Write original content back to disk
        let absPath: string;
        try {
          absPath = resolveWorkspacePath(row.filePath);
        } catch (e: unknown) {
          return res.status(400).json({ message: getErrorMessage(e) });
        }

        const dir = path.dirname(absPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(absPath, row.originalContent ?? "", "utf8");

        // Mark as reverted
        await db.update(codePatchHistory).set({ revertedAt: new Date() }).where(eq(codePatchHistory.id, patchId));

        await logAIAction({
          req,
          actionType: "write",
          actionName: "revert_patch",
          inputJson: { patchId, filePath: row.filePath },
          outputJson: { success: true },
          status: "success",
        });

        res.json({ success: true, filePath: row.filePath });
      } catch (error: unknown) {
        logger.error("[Chatbot] revert-patch error:", { error: getErrorMessage(error) });
        res.status(500).json({ message: "Internal server error" });
      }
    }
  );

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
  app.post("/api/chatbot/git-push", requireAuth, requireNonPOS, requireRole("Admin", "Owner"), async (req, res) => {
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
      // Decrypt if it looks like a CryptoJS AES cipher (base64 with U2FsdGVkX1 prefix)
      const token = rawToken.startsWith("U2FsdGVkX1") ? decryptToken(rawToken) : rawToken;

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
  });
}
