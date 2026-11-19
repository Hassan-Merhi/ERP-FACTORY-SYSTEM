// Extracted from ./patches.ts
import type { Express } from "express";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { db } from "../../db";
import { requireAuth, requireRole, requireNonPOS } from "../../auth";
import { codePatchHistory } from "@shared/schema";
import { eq, and, desc } from "drizzle-orm";
import path from "path";
import fs from "fs";
import { logAIAction } from "../../lib/aiActionPermission";
import { resolveWorkspacePath, readProjectFileRaw } from "../../lib/codeAgentTools";

export function registerChatbotPatchRoutesPart1(app: Express) {
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
}
